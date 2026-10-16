/**
 * Polygon.io aggregates provider — the first live `HistoricalDataProvider` (spec 16
 * interface; docs/market-data). Server-side only: `apiKey` must never reach the browser.
 *
 * Backtest-integrity rules (see the provider discovery report):
 * - Every request is `adjusted=false` — raw OHLCV only; split-adjusted series would rewrite
 *   the historical tape after the fact and break PIT semantics for equities.
 * - Polygon `t` is bar-open Unix ms — the canonical convention; no timezone conversion.
 * - `end` is translated to `end − 1 ms` because Polygon's `to` bound is inclusive while
 *   `MarketDataRequest.end` is exclusive.
 * - Missing intervals simply return no bar — gaps are classified by the quality pipeline,
 *   never fabricated.
 * - `next_url` pagination is followed with the apiKey re-appended (Polygon omits it), with
 *   a hard page bound and timestamp dedup at page boundaries.
 * - NSE / `indian-markets` assets are unsupported (no coverage): `supports()` → false and
 *   `getCandles` → `unsupported_symbol`. Nothing is fabricated.
 * - Polygon reports entitlement delay via the aggregate `status` field (`DELAYED`
 *   on EOD/delayed plans, `OK` otherwise — observed 2026-10-16 smoke test). The
 *   provider stamps `classification: "delayed"` on evidence, `"historical"`
 *   otherwise; the capability row's declared class is the router's fallback.
 */
import type {
  AssetIdentifier,
  Candle,
  MarketDataError,
  MarketDataRequest,
  MarketDataSource,
  RawCandle,
  Timeframe,
} from "@/lib/types";
import { normalizeCandles } from "../normalize";
import { buildQualityReport } from "../quality";
import { alwaysOpen, weekdayUtc, type SessionCalendar } from "../sessions";
import { providerError, type HistoricalDataProvider, type ProviderResponse } from "../provider";

const DEFAULT_BASE_URL = "https://api.polygon.io";
const DEFAULT_PAGE_SIZE = 50_000; // Polygon documented maximum.
const MAX_PAGES = 40; // Safety bound — 2M bars worst case; never infinite pagination.
const RETRY_DELAY_MS = 400;

export interface PolygonProviderConfig {
  apiKey: string;
  baseUrl?: string;
  pageSize?: number;
  /** Injectable for tests — production uses the platform fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests — production uses a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export const POLYGON_SOURCE: MarketDataSource = {
  id: "polygon",
  kind: "rest",
  label: "Polygon.io",
};

// ---------------------------------------------------------------------------
// Symbol mapping — catalog symbol → Polygon ticker. Explicit, never guessed per request.

/** Index catalog aliases → Polygon index tickers. */
const INDEX_TICKERS: Record<string, string> = {
  NAS100: "I:NDX",
};

/**
 * Resolves `AssetIdentifier` → Polygon ticker, or `undefined` when the vendor cannot serve
 * the asset. `supports()` and `getCandles()` share this single resolution so the two can
 * never disagree.
 */
export function polygonTickerFor(asset: AssetIdentifier): string | undefined {
  // Indian markets (NSE/BSE) have no Polygon coverage — honest unsupported, not a guess.
  if (asset.marketId === "indian-markets") return undefined;

  const symbol = asset.symbol.toUpperCase();
  switch (asset.assetClass) {
    case "crypto": {
      // Catalog crypto symbols are USDT-quoted (BTCUSDT); Polygon crypto pairs are
      // USD-quoted (X:BTCUSD). USDT tracks USD — this is a documented quote normalization,
      // and the served pair is recorded on the response `source`.
      const pair = symbol.endsWith("USDT") ? `${symbol.slice(0, -4)}USD` : symbol;
      return `X:${pair}`;
    }
    case "forex":
    case "commodities":
      // Spot metals trade under Polygon's forex feed (C:XAUUSD).
      return `C:${symbol}`;
    case "equities":
      return symbol;
    case "indices":
      return INDEX_TICKERS[symbol];
    default:
      // No assetClass or unknown class — no mapping guess.
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Timeframe mapping — the canonical Timeframe set → (multiplier, timespan). Every fixed
// timeframe maps directly to a Polygon aggregate; nothing is approximated.

function polygonRange(timeframe: Timeframe): { multiplier: number; timespan: string } | undefined {
  switch (timeframe) {
    case "1m": return { multiplier: 1, timespan: "minute" };
    case "3m": return { multiplier: 3, timespan: "minute" };
    case "5m": return { multiplier: 5, timespan: "minute" };
    case "15m": return { multiplier: 15, timespan: "minute" };
    case "30m": return { multiplier: 30, timespan: "minute" };
    case "1h": return { multiplier: 1, timespan: "hour" };
    case "2h": return { multiplier: 2, timespan: "hour" };
    case "4h": return { multiplier: 4, timespan: "hour" };
    case "6h": return { multiplier: 6, timespan: "hour" };
    case "12h": return { multiplier: 12, timespan: "hour" };
    case "1D": return { multiplier: 1, timespan: "day" };
    case "1W": return { multiplier: 1, timespan: "week" };
    case "1M": return { multiplier: 1, timespan: "month" };
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------
// Quality calendar — the coarsest honest approximation per asset class. Crypto is 24/7;
// everything else trades weekdays (UTC). Holiday calendars are a later extension.

function calendarFor(asset: AssetIdentifier): SessionCalendar {
  return asset.assetClass === "crypto" ? alwaysOpen("polygon-crypto-24x7") : weekdayUtc();
}

// ---------------------------------------------------------------------------

interface PolygonAggregateRow {
  t?: number;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
  vw?: number;
  n?: number;
}

interface PolygonAggregatesBody {
  status?: string;
  error?: string;
  ticker?: string;
  results?: PolygonAggregateRow[];
  resultsCount?: number;
  next_url?: string;
}

export class PolygonProvider implements HistoricalDataProvider {
  readonly source: MarketDataSource = POLYGON_SOURCE;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly pageSize: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: PolygonProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  supports(request: MarketDataRequest): boolean {
    return (
      polygonRange(request.timeframe) !== undefined &&
      polygonTickerFor(request.asset) !== undefined
    );
  }

  async getCandles(request: MarketDataRequest): Promise<ProviderResponse> {
    const range = polygonRange(request.timeframe);
    if (range === undefined) {
      return providerError("unsupported_timeframe", `timeframe '${request.timeframe}' is not mappable to a Polygon aggregate`);
    }
    const ticker = polygonTickerFor(request.asset);
    if (ticker === undefined) {
      return providerError("unsupported_symbol", `symbol '${request.asset.symbol}' is not served by Polygon`);
    }
    if (!Number.isFinite(request.start) || !Number.isFinite(request.end) || request.start >= request.end) {
      return providerError("invalid_request", "request requires finite start < end");
    }

    const url = `${this.baseUrl}/v2/aggs/ticker/${encodeURIComponent(ticker)}` +
      `/range/${range.multiplier}/${range.timespan}` +
      // Polygon `to` is inclusive; `MarketDataRequest.end` is exclusive → shift by 1 ms.
      `/${request.start}/${request.end - 1}` +
      `?adjusted=false&sort=asc&limit=${this.pageSize}`;

    const rows: RawCandle[] = [];
    const seen = new Set<number>(); // page-boundary dedup — stitches, never data repair.
    let next: string | undefined = url;
    let pages = 0;
    let delayedStatus = false; // vendor-reported DELAYED — the classification evidence.

    while (next !== undefined) {
      if (pages >= MAX_PAGES) {
        return providerError("incomplete_data", `range exceeded the ${MAX_PAGES}-page safety bound`);
      }
      pages += 1;

      const page = await this.fetchPage(next, ticker, request);
      if (!page.ok) return { ok: false, error: page.error };
      const body = page.body;
      if (body.status === "DELAYED") delayedStatus = true;

      if (body.results === undefined) {
        if (body.status === "NOT_FOUND" || body.status === "ERROR") {
          return providerError(
            body.status === "NOT_FOUND" ? "unsupported_symbol" : "provider_error",
            body.error ?? `Polygon returned status '${body.status}' for '${ticker}'`,
          );
        }
        // status OK with no `results` array = an honestly empty range.
        break;
      }

      for (const row of body.results) {
        if (row.t === undefined) continue;
        if (row.t < request.start || row.t >= request.end) continue; // enforce [start, end).
        if (seen.has(row.t)) continue;
        seen.add(row.t);
        rows.push({ time: row.t, open: row.o, high: row.h, low: row.l, close: row.c, volume: row.v, vwap: row.vw, tradeCount: row.n });
      }

      const last = body.results[body.results.length - 1];
      next = body.next_url;
      if (next !== undefined && last !== undefined && last.t !== undefined && last.t >= request.end) {
        next = undefined; // range fully covered — stop paging.
      }
    }

    const normalized = normalizeCandles(rows);
    const candles: Candle[] = normalized.candles;
    const quality = buildQualityReport({
      symbol: request.asset.symbol,
      timeframe: request.timeframe,
      candles,
      calendar: calendarFor(request.asset),
    });
    return {
      ok: true,
      result: {
        candles,
        quality,
        source: this.source,
        // DELAYED is Polygon's own report of entitlement delay; absent → the
        // aggregate is ordinary historical data. A REST read is never "live".
        classification: delayedStatus ? "delayed" : "historical",
        warnings: [
          ...normalized.rejected.map((r) => `row ${r.index}: ${r.reason}`),
          `ticker:${ticker}`, // record the served pair — e.g. X:BTCUSD for BTCUSDT.
        ],
      },
    };
  }

  /** One bounded retry on transient failures (429/5xx/network); never on 4xx/malformed. */
  private async fetchPage(
    url: string,
    ticker: string,
    request: MarketDataRequest,
  ): Promise<
    { ok: true; body: PolygonAggregatesBody } | { ok: false; error: MarketDataError }
  > {
    const fail = (code: MarketDataError["code"], message: string) =>
      ({ ok: false as const, error: { code, message } });

    const keyUrl = url.includes("apiKey=") ? url : `${url}${url.includes("?") ? "&" : "?"}apiKey=${this.apiKey}`;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let res: Response;
      try {
        res = await this.fetchImpl(keyUrl, { method: "GET" });
      } catch {
        if (attempt === 1) {
          await this.sleep(RETRY_DELAY_MS);
          continue;
        }
        return fail("provider_error", `network failure fetching '${ticker}'`);
      }
      if (res.ok) {
        let body: PolygonAggregatesBody;
        try {
          body = (await res.json()) as PolygonAggregatesBody;
        } catch {
          return fail("invalid_data", `malformed JSON from Polygon for '${ticker}'`);
        }
        if (typeof body !== "object" || body === null) {
          return fail("invalid_data", `malformed payload from Polygon for '${ticker}'`);
        }
        return { ok: true, body };
      }
      if (res.status === 401 || res.status === 403) {
        return fail("provider_error", `Polygon authentication failed (HTTP ${res.status})`);
      }
      if (res.status === 404) {
        return fail("unsupported_symbol", `symbol '${request.asset.symbol}' not found on Polygon`);
      }
      if (res.status === 429) {
        if (attempt === 1) {
          await this.sleep(RETRY_DELAY_MS);
          continue;
        }
        return fail("rate_limited", `Polygon rate limit fetching '${ticker}'`);
      }
      if (res.status >= 500) {
        if (attempt === 1) {
          await this.sleep(RETRY_DELAY_MS);
          continue;
        }
        return fail("provider_error", `Polygon server error (HTTP ${res.status})`);
      }
      return fail("provider_error", `Polygon request failed (HTTP ${res.status})`);
    }
  }
}
