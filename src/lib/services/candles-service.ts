/**
 * Product-layer composition for POST /api/candles — the bounded historical-candles
 * read behind the chart surface.
 *
 * Flow: `CandlesRequest` → validation → symbol→`AssetIdentifier` resolution →
 * `HistoricalDataProvider` (supports pre-check, then getCandles) → `CandlesResult`.
 *
 * Contract decisions:
 *  A. EMPTY vs FAILURE — a provider `ok:true` with zero candles is a valid empty
 *     window (it carries the full quality report); it is returned as 200 with
 *     `candles: []`. Any `ok:false` — authorization, rate limit, transport, malformed
 *     payload, unsupported ticker — is an error mapped by code, never an empty chart.
 *     `data_not_available` is a provider *failure code* (no quality report exists to
 *     accompany a fabricated "empty"), so it maps to 404, not to a 200 empty result.
 *  B. IDENTITY — catalog symbols resolve through `getInstrument` to the canonical
 *     `AssetIdentifier` (assetClass/marketId/exchange). Unknown symbols pass through
 *     as `{symbol}` only — no invented classification — and the provider's own
 *     `supports()` decides. Requested `symbol`, resolved `asset`, and the actual
 *     `servedTicker` (e.g. X:BTCUSD for BTCUSDT) are reported as three distinct facts.
 *  C. WINDOWS — `end` is the exclusive bound (`to` or server now); `start` is either
 *     explicit `from` or a bounded `bars` lookback, then floored to the timeframe
 *     boundary via the canonical `alignFloor`. Fixed timeframes use `TIMEFRAME_MS`;
 *     `1M` uses UTC month arithmetic — both tested independently. Quality gap metrics
 *     are passed through verbatim: they include *expected* closures (weekends,
 *     off-session) per the session calendar, not only defects — the UI says so.
 */
import { getInstrument } from "@/lib/constants/instruments";
import type { HistoricalDataProvider } from "@/lib/market-data/provider";
import { alignFloor, TIMEFRAME_MS, timeframeMs } from "@/lib/market-data/timeframes";
import type {
  AssetIdentifier,
  CandlesRequest,
  CandlesResult,
  MarketDataErrorCode,
  Timeframe,
  UnixMs,
} from "@/lib/types";
import { nseRegular } from "@/lib/market-data/calendars/nse";
import { assessDataFreshness } from "./data-freshness";
import { assessDataSufficiency } from "./data-sufficiency";

const DAY_MS = 86_400_000;

/** Product-layer work bounds — the route validates these before any provider access. */
export const CANDLES_MAX_BARS = 2000;
export const CANDLES_DEFAULT_BARS = 300;
export const CANDLES_MAX_RANGE_DAYS = 1825;
const CANDLES_MAX_SYMBOL_LEN = 64;

/** Typed failure carrying the canonical provider code so the route can map HTTP status. */
export class CandlesError extends Error {
  readonly code: MarketDataErrorCode | "invalid_request";

  constructor(code: MarketDataErrorCode | "invalid_request", message: string) {
    super(message);
    this.name = "CandlesError";
    this.code = code;
  }
}

export interface CandlesCompositionDeps {
  /** Historical candles source — the spec-16 contract; the chart never fetches directly. */
  provider: HistoricalDataProvider;
  /** Injectable clock — `to` default and `retrievedAt` stay deterministic in tests. */
  nowMs?: number;
}

// ---------------------------------------------------------------------------
// Request validation — mirrors the existing service style: reject malformed input
// before any provider access. `timeframe` is checked against the canonical set.

function isCanonicalTimeframe(tf: unknown): tf is Timeframe {
  return typeof tf === "string" && (tf === "1M" || tf in TIMEFRAME_MS);
}

function assertValidRequest(request: CandlesRequest): { symbol: string; timeframe: Timeframe } {
  if (typeof request?.symbol !== "string" || request.symbol.trim() === "") {
    throw new CandlesError("invalid_request", "symbol is required.");
  }
  const symbol = request.symbol.trim().toUpperCase();
  if (symbol.length > CANDLES_MAX_SYMBOL_LEN) {
    throw new CandlesError("invalid_request", `symbol may not exceed ${CANDLES_MAX_SYMBOL_LEN} characters.`);
  }
  if (!isCanonicalTimeframe(request?.timeframe)) {
    throw new CandlesError("invalid_request", "timeframe must be one of the canonical timeframe set.");
  }
  if (request.from !== undefined && request.bars !== undefined) {
    throw new CandlesError("invalid_request", "from and bars are mutually exclusive — supply a window or a lookback, not both.");
  }
  if (request.from !== undefined && !Number.isFinite(Date.parse(request.from))) {
    throw new CandlesError("invalid_request", "from must be a valid ISO timestamp when supplied.");
  }
  if (request.to !== undefined && !Number.isFinite(Date.parse(request.to))) {
    throw new CandlesError("invalid_request", "to must be a valid ISO timestamp when supplied.");
  }
  if (request.bars !== undefined) {
    const { bars } = request;
    if (typeof bars !== "number" || !Number.isInteger(bars) || bars <= 0 || bars > CANDLES_MAX_BARS) {
      throw new CandlesError("invalid_request", `bars must be an integer between 1 and ${CANDLES_MAX_BARS}.`);
    }
  }
  return { symbol, timeframe: request.timeframe };
}

// ---------------------------------------------------------------------------
// Window math — exclusive `end`; `start` explicit or `bars` lookback, floored to the
// timeframe boundary so the query always aligns to a bar open.

/** `bars` lookback start. Fixed TFs: `end − bars·tfMs`. `1M`: UTC month arithmetic. */
export function lookbackStart(end: UnixMs, timeframe: Timeframe, bars: number): UnixMs {
  const ms = timeframeMs(timeframe);
  if (ms !== undefined) return end - bars * ms;
  // "1M" is calendar-based — subtract `bars` months, month-start aligned.
  const d = new Date(end);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - bars, 1);
}

export function candleWindow(
  request: CandlesRequest,
  timeframe: Timeframe,
  nowMs: number,
): { start: UnixMs; end: UnixMs } {
  const end = request.to !== undefined ? Date.parse(request.to) : nowMs;
  let start: UnixMs;
  if (request.from !== undefined) {
    start = Date.parse(request.from);
  } else {
    start = lookbackStart(end, timeframe, request.bars ?? CANDLES_DEFAULT_BARS);
  }
  if (start >= end) {
    throw new CandlesError("invalid_request", "the candles window start must be before its end.");
  }
  if (end - start > CANDLES_MAX_RANGE_DAYS * DAY_MS) {
    throw new CandlesError(
      "invalid_request",
      `the candles window may not exceed ${CANDLES_MAX_RANGE_DAYS} days.`,
    );
  }
  return { start: alignFloor(start, timeframe), end };
}

// ---------------------------------------------------------------------------
// Identity — catalog first; pass-through `{symbol}` otherwise. No invented metadata.

export function resolveAsset(symbol: string): AssetIdentifier {
  const instrument = getInstrument(symbol);
  return instrument
    ? {
        symbol: instrument.symbol,
        assetClass: instrument.assetClass,
        exchange: instrument.exchange,
        marketId: instrument.marketId,
      }
    : { symbol };
}

// ---------------------------------------------------------------------------
// Composition entry point

/**
 * Reads normalized historical candles for one symbol/timeframe. Throws `CandlesError`
 * (canonical code) for request and provider failures, `ServiceUnavailableError` never —
 * the route raises that when no provider is configured, same as the other boundaries.
 */
export async function executeCandles(
  request: CandlesRequest,
  deps: CandlesCompositionDeps,
): Promise<CandlesResult> {
  const { symbol, timeframe } = assertValidRequest(request);
  const nowMs = deps.nowMs ?? Date.now();
  const window = candleWindow(request, timeframe, nowMs);
  const asset = resolveAsset(symbol);

  const providerRequest = { asset, timeframe, start: window.start, end: window.end };
  if (!deps.provider.supports(providerRequest)) {
    // `supports` shares the provider's ticker/range resolution — all canonical
    // timeframes map, so a false here is an instrument-level unsupported.
    throw new CandlesError(
      "unsupported_symbol",
      `symbol '${symbol}' is not served by the configured market-data provider.`,
    );
  }

  const response = await deps.provider.getCandles(providerRequest);
  if (!response.ok) {
    // Provider failures (auth, rate limit, transport, malformed, unsupported) surface
    // as their canonical code — never as an empty chart.
    throw new CandlesError(response.error.code, response.error.message);
  }

  const { candles, quality, warnings } = response.result;
  const servedTicker = warnings
    ?.find((w) => w.startsWith("ticker:"))
    ?.slice("ticker:".length);

  return {
    symbol,
    asset,
    timeframe,
    window,
    candles, // provider-verbatim: ascending, deduplicated, gaps preserved
    candleCount: candles.length,
    quality,
    // The routed result's own source — under ProviderRouter this is the vendor
    // that actually served, not the router's aggregate label.
    source: response.result.source ?? deps.provider.source,
    // Provider-reported freshness (Polygon stamps DELAYED evidence) or the
    // router's declared capability floor — never upgraded by request success.
    classification: response.result.classification ?? "historical",
    // zero candles is a valid empty window — never sufficiency by implication.
    // The floor compares against what was asked: a bounded bars:N request or
    // the window's own expected count — never a universal minimum.
    sufficiency: assessDataSufficiency({
      candles,
      quality,
      requestedBars: request.bars ?? quality.expectedBarCount,
    }),
    // Session-aware staleness: last-bar time on the market's own clock —
    // weekends and exchange holidays count as closed, never as missing data.
    freshness: assessDataFreshness({
      candles,
      timeframe,
      // indian-markets gets the real NSE calendar (IST session + holidays);
      // other segments keep the coarse weekday/always-open defaults.
      calendar:
        asset.marketId === "indian-markets" ? nseRegular() : undefined,
      is24x7: asset.assetClass === "crypto",
      nowMs,
    }),
    retrievedAt: new Date(nowMs).toISOString(),
    ...(servedTicker !== undefined ? { servedTicker } : {}),
    warnings: warnings ?? [],
  };
}
