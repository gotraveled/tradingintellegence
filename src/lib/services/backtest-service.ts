/**
 * Product-layer composition for the Strategy Lab backtest path — the first production
 * consumer of the completed engine (spec 26 `runBacktest`).
 *
 * Flow: `BacktestRequest` → universe resolution → `HistoricalDataProvider` candles →
 * spec-26 `BacktestCell[]` → engine → `SystemBacktestResult` → `BacktestResult`.
 *
 * This module owns NO engine semantics: it fetches data, shapes inputs, calls the engine
 * once, and maps its output. Detection, scoring, lifecycle, outcomes, statistics, and
 * aggregation stay inside `src/lib/engines/`.
 */
import { runBacktest as runSystemBacktestEngine } from "@/lib/engines/backtest";
import type { HistoricalDataProvider } from "@/lib/market-data/provider";
import { timeframeMs } from "@/lib/market-data/timeframes";
import { FEATURED_INSTRUMENTS, getInstrument } from "@/lib/constants/instruments";
import type {
  AssetIdentifier,
  BacktestCell,
  BacktestRequest,
  BacktestResult,
  BacktestTrade,
  BacktestTradeOutcome,
  EngineConfig,
  MarketSegmentId,
  SetupOutcome,
  SystemBacktestResult,
} from "@/lib/types";
import { defaultConfig } from "./engine-defaults";
import { assessDataSufficiency } from "./data-sufficiency";
import { ServiceUnavailableError } from "./types";

const DAY_MS = 86_400_000;

export interface BacktestCompositionDeps {
  /** Historical candles source — the spec-01/16 contract; the engine never fetches. */
  provider: HistoricalDataProvider;
  /** Engine parameter set — defaults to `defaultConfig()` (spec-21 factory). */
  config?: EngineConfig;
  /** Universe resolver — defaults to the static instrument catalog + request symbols. */
  universe?: (request: BacktestRequest) => AssetIdentifier[];
  /** Engine entry point — injectable so tests can assert the engine is the callee. */
  run?: typeof runSystemBacktestEngine;
}

/** Symbols whose provider fetch failed or returned no candles — diagnostics only. */
export interface BacktestSkip {
  symbol: string;
  reason: string;
}

export interface SystemBacktestExecution {
  /** Adapter output consumed by the Strategy Lab UI. */
  result: BacktestResult;
  /** Symbols evaluated by the engine (canonical order from `result.cells`). */
  evaluatedSymbols: string[];
  /** Symbols that produced no cell — never silently dropped. */
  skipped: BacktestSkip[];
}

// ---------------------------------------------------------------------------
// Universe resolution

/**
 * Request symbols → `AssetIdentifier` (catalog metadata where known); otherwise the static
 * instrument catalog filtered by `request.market`. The catalog carries reference metadata
 * only — no prices — so it defines the scan extent, never the data.
 */
export function defaultUniverse(request: {
  symbols?: string[];
  market?: MarketSegmentId;
}): AssetIdentifier[] {
  if (request.symbols && request.symbols.length > 0) {
    return request.symbols.map((symbol) => {
      const asset = getInstrument(symbol);
      return asset
        ? {
            symbol: asset.symbol,
            assetClass: asset.assetClass,
            exchange: asset.exchange,
            marketId: asset.marketId,
          }
        : { symbol };
    });
  }
  const universe: AssetIdentifier[] = FEATURED_INSTRUMENTS.filter(
    (asset) => request.market === undefined || asset.marketId === request.market,
  ).map((asset) => ({
    symbol: asset.symbol,
    assetClass: asset.assetClass,
    exchange: asset.exchange,
    marketId: asset.marketId,
  }));
  return universe;
}

// ---------------------------------------------------------------------------
// Request validation — product-layer input checks (the engine validates its own inputs;
// these reject malformed requests before any fetch).

function assertValidRequest(request: BacktestRequest): { start: number; end: number } {
  if (!request.strategyId || request.strategyId.trim() === "") {
    throw new Error("Backtest request requires a strategyId.");
  }
  if (!request.timeframe) {
    throw new Error("Backtest request requires a timeframe.");
  }
  const start = Date.parse(request.period?.from ?? "");
  const to = Date.parse(request.period?.to ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(to)) {
    throw new Error("Backtest request period must be valid ISO timestamps.");
  }
  // The form submits a bare UTC-midnight date; that convention means "through that day",
  // so the exclusive provider bound extends by one day. A non-midnight timestamp is used
  // literally — `MarketDataRequest.end` is an exclusive bar-open bound.
  const end = to % DAY_MS === 0 ? to + DAY_MS : to;
  if (start >= end) {
    throw new Error("Backtest period 'from' must be before 'to'.");
  }
  if (!Number.isFinite(request.minScore) || request.minScore < 0 || request.minScore > 100) {
    throw new Error("minScore must be between 0 and 100.");
  }
  if (!Number.isFinite(request.riskPerTradePct) || request.riskPerTradePct <= 0) {
    throw new Error("riskPerTradePct must be a positive number.");
  }
  return { start, end };
}

// ---------------------------------------------------------------------------
// Cell assembly — candles in, spec-26 cells out. No `frames` are supplied: MTF is an
// opt-in spec-31 transport and absent frames preserve bit-for-bit baseline behavior.

async function buildCells(
  assets: AssetIdentifier[],
  timeframe: BacktestRequest["timeframe"],
  windowMs: { start: number; end: number },
  provider: HistoricalDataProvider,
): Promise<{ cells: BacktestCell[]; skipped: BacktestSkip[] }> {
  const cells: BacktestCell[] = [];
  const skipped: BacktestSkip[] = [];
  for (const asset of assets) {
    const response = await provider.getCandles({
      asset,
      timeframe,
      start: windowMs.start,
      end: windowMs.end,
    });
    if (!response.ok) {
      skipped.push({ symbol: asset.symbol, reason: response.error.message });
      continue;
    }
    const { candles, quality } = response.result;
    if (candles.length === 0) {
      skipped.push({ symbol: asset.symbol, reason: "provider returned no candles" });
      continue;
    }
    // A sparse fragment is not a backtest input — skipped with an explicit
    // reason so a successful HTTP response can't masquerade as adequate coverage.
    if (assessDataSufficiency({ candles, quality }) === "insufficient") {
      skipped.push({
        symbol: asset.symbol,
        reason: `insufficient data — ${candles.length} bars returned for the requested window`,
      });
      continue;
    }
    cells.push({
      symbol: asset.symbol,
      timeframe,
      series: {
        symbol: asset.symbol,
        timeframe,
        candles,
        assetClass: asset.assetClass,
        exchange: asset.exchange,
      },
    });
  }
  return { cells, skipped };
}

// ---------------------------------------------------------------------------
// Result adapter — SystemBacktestResult → BacktestResult.
//
// Pure presentation mapping: pure arithmetic over authoritative spec-17 outcome rows only.
// The engine applies no costs, position sizing, or execution semantics (spec 26) — so
// `assumptions`/`outOfSample` are never fabricated and stay absent.

/** Trade population: resolved rows that actually entered the entry band. */
function toTrades(outcomes: SetupOutcome[], timeframe: BacktestRequest["timeframe"]): BacktestTrade[] {
  const tfMs = timeframeMs(timeframe);
  const sorted = [...outcomes].sort(
    (a, b) =>
      Date.parse(a.resolvedAt ?? a.confirmedAt) - Date.parse(b.resolvedAt ?? b.confirmedAt) ||
      (a.setupId < b.setupId ? -1 : a.setupId > b.setupId ? 1 : 0),
  );
  const trades: BacktestTrade[] = [];
  for (const row of sorted) {
    if (row.unresolved) continue;
    if (row.entryPrice === undefined || row.initialRisk === undefined || row.rMultiple === undefined)
      continue;
    const sign = row.direction === "bearish" ? -1 : 1;
    // Activation time: confirm-bar open + elapsed bars × timeframe. ISODateTime stays a
    // string; for calendar timeframes without a fixed duration (1M) the confirm timestamp
    // is the honest anchor.
    const entryAt =
      row.barsToActive !== undefined && row.barsToActive !== null && tfMs !== undefined
        ? new Date(Date.parse(row.confirmedAt) + row.barsToActive * tfMs).toISOString()
        : row.confirmedAt;
    const outcome: BacktestTradeOutcome =
      row.rMultiple > 0 || row.targetsReached >= 1
        ? "target"
        : row.rMultiple < 0 || row.stopReached
          ? "stop"
          : row.expired
            ? "timeout"
            : "breakeven";
    trades.push({
      id: row.setupId,
      symbol: row.symbol,
      direction: row.direction,
      entryAt,
      exitAt: row.resolvedAt ?? row.confirmedAt,
      entry: row.entryPrice,
      exit: row.entryPrice + sign * row.rMultiple * row.initialRisk,
      resultR: row.rMultiple,
      outcome,
    });
  }
  return trades;
}

/**
 * Deterministic pure mapping. Population rule: when the run carried a selection, only
 * setups observed as `selected === true` count — spec-25 marking semantics ("only setups at
 * or above this quality score are included"). Without a selection, every measured row
 * counts.
 */
export function toBacktestResult(
  result: SystemBacktestResult,
  request: BacktestRequest,
  selectedOnly: boolean,
): BacktestResult {
  let population = result.outcomes;
  if (selectedOnly) {
    const selectedSetupIds = new Set(
      result.opportunities.filter((o) => o.selected === true).map((o) => o.setupId),
    );
    population = population.filter((row) => selectedSetupIds.has(row.setupId));
  }

  const trades = toTrades(population, request.timeframe);
  const rs = trades.map((t) => t.resultR);
  const sampleSize = trades.length;
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r < 0);
  const grossWin = wins.reduce((sum, r) => sum + r, 0);
  const grossLoss = Math.abs(losses.reduce((sum, r) => sum + r, 0));
  const total = rs.reduce((sum, r) => sum + r, 0);

  // Peak-to-trough over cumulative R in resolution order — arithmetic over the same rows
  // the trade list exposes; no hidden state.
  let equity = 0;
  let peak = 0;
  let maxDrawdownR: number | undefined;
  for (const r of rs) {
    equity += r;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR ?? 0, peak - equity);
  }

  return {
    id: result.runId ?? `sl-${request.strategyId}`,
    strategyId: request.strategyId,
    symbols: [...new Set(result.cells.map((cell) => cell.symbol))],
    timeframe: request.timeframe,
    setupType: request.setupType,
    period: request.period,
    sampleSize,
    hitRate: sampleSize === 0 ? 0 : wins.length / sampleSize,
    averageR: sampleSize === 0 ? 0 : total / sampleSize,
    expectancyR: sampleSize === 0 ? 0 : total / sampleSize,
    maxDrawdownR,
    profitFactor: grossLoss === 0 ? undefined : grossWin / grossLoss,
    // `assumptions` absent — the engine applies no commission/slippage (spec 26 exclusion).
    // `outOfSample` absent — no split methodology exists (spec-24 deferral).
    trades,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Composition entry point

/**
 * Runs the real engine over provider-supplied candles. Throws `ServiceUnavailableError`
 * when market data cannot be obtained for any requested symbol — a fabricated result is
 * never returned.
 */
export async function executeSystemBacktest(
  request: BacktestRequest,
  deps: BacktestCompositionDeps,
): Promise<SystemBacktestExecution> {
  const { start, end } = assertValidRequest(request);
  const config = deps.config ?? defaultConfig();
  const universe = (deps.universe ?? defaultUniverse)(request);
  if (universe.length === 0) {
    throw new Error(
      request.market === undefined
        ? "No symbols resolved for the backtest universe."
        : `No instruments known for market '${request.market}'.`,
    );
  }

  const { cells, skipped } = await buildCells(
    universe,
    request.timeframe,
    { start, end },
    deps.provider,
  );
  if (cells.length === 0) {
    throw new ServiceUnavailableError(
      "Market data provider",
      `No historical candles could be obtained for the requested symbols (${universe
        .map((a) => a.symbol)
        .join(", ")}). The backtest was not run.`,
    );
  }

  // Spec-26 analytical marking only — filters narrow `selected`, never remove records.
  const filters = {
    setupTypes: request.setupType ? [request.setupType] : undefined,
    minScore: request.minScore,
  };
  const run = deps.run ?? runSystemBacktestEngine;
  const res = run({
    cells,
    selection: { filters },
    runId: `sl-${request.strategyId}`,
    config,
  });
  if (!res.ok || res.data === undefined) {
    throw new Error(
      `Backtest engine failed: ${res.errors.map((e) => `${e.code}: ${e.message}`).join("; ")}`,
    );
  }

  const hasSelection = filters.setupTypes !== undefined || filters.minScore !== undefined;
  return {
    result: toBacktestResult(res.data, request, hasSelection),
    evaluatedSymbols: res.data.cells.map((cell) => cell.symbol),
    skipped,
  };
}
