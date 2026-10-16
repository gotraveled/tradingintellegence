/**
 * Product-layer composition for POST /api/analysis — point-in-time market analysis,
 * the second production consumer of the completed engine (spec 26 `runBacktest`).
 *
 * Flow: `AnalysisRequest` → universe resolution → `HistoricalDataProvider` candles →
 * spec-26 `BacktestCell[]` → engine → records emitted AT the anchor bar →
 * `AnalysisResult`.
 *
 * Point-in-time rule: the anchor is the last bar whose CLOSE ≤ asOf
 * (`closedIndexAt`, spec-18 closed-bar semantics). Returned records are the spec-25/26
 * frozen observations at that bar only — `SetupOutcome` rows, aggregates, and the
 * post-hoc `outcomeRef` join are measured over bars after the anchor and are
 * deliberately excluded from the response (they would leak the future).
 *
 * This module owns NO engine semantics: it fetches data, shapes inputs, calls the
 * engine once, and maps its output. Detection, scoring, lifecycle, outcomes,
 * statistics, and aggregation stay inside `src/lib/engines/`.
 */
import { runBacktest } from "@/lib/engines/backtest";
import { closedIndexAt } from "@/lib/engines/mtf";
import type { HistoricalDataProvider } from "@/lib/market-data/provider";
import { TIMEFRAME_MS } from "@/lib/market-data/timeframes";
import type {
  AnalysisCell,
  AnalysisRequest,
  AnalysisResult,
  AssetIdentifier,
  BacktestCell,
  CandleSeries,
  EngineConfig,
  Timeframe,
} from "@/lib/types";
import type { FrameRole } from "@/lib/engines/mtf";
import { defaultConfig } from "./engine-defaults";
import { defaultUniverse, type BacktestSkip } from "./backtest-service";
import { assessDataSufficiency } from "./data-sufficiency";
import { ServiceUnavailableError } from "./types";

const DAY_MS = 86_400_000;

/** Product-layer work bounds — the route validates these before any provider access. */
export const ANALYSIS_MAX_SYMBOLS = 16;
export const ANALYSIS_MAX_LOOKBACK_DAYS = 180;
export const ANALYSIS_DEFAULT_LOOKBACK_DAYS = 30;

export interface AnalysisCompositionDeps {
  /** Historical candles source — the spec-01/16 contract; the engine never fetches. */
  provider: HistoricalDataProvider;
  /** Engine parameter set — defaults to `defaultConfig()` (spec-21 factory). */
  config?: EngineConfig;
  /** Universe resolver — defaults to the static instrument catalog + request symbols. */
  universe?: (request: AnalysisRequest) => AssetIdentifier[];
  /** Engine entry point — injectable so tests can assert the engine is the callee. */
  run?: typeof runBacktest;
  /** Injectable clock — request-time asOf resolution stays deterministic in tests. */
  nowMs?: number;
  /**
   * Spec-31 opt-in: resolves auxiliary MTF frame series for a cell. Called once
   * per built cell; `undefined` leaves `BacktestCell.frames` unset — baseline
   * behavior is preserved bit-for-bit. Callers (e.g. multi-file uploaded
   * datasets) must also set `config.mtf.set` so each role's configured
   * timeframe matches the frame's declared timeframe — the engine verifies
   * this and skips mismatched frames with a diagnostic.
   */
  frames?: (
    asset: AssetIdentifier,
    timeframe: Timeframe,
  ) => Partial<Record<FrameRole, CandleSeries>> | undefined;
}

// ---------------------------------------------------------------------------
// Request validation — product-layer input checks (the engine validates its own
// inputs; these reject malformed requests before any fetch).

function assertValidRequest(request: AnalysisRequest): { asOfMs?: number } {
  const { timeframe } = request;
  const timeframeValid =
    typeof timeframe === "string" &&
    (timeframe === "1M" || timeframe in TIMEFRAME_MS);
  if (!timeframeValid) {
    throw new Error("timeframe must be one of the canonical timeframe set.");
  }
  const lookback = request.lookbackDays ?? ANALYSIS_DEFAULT_LOOKBACK_DAYS;
  if (!Number.isFinite(lookback) || lookback <= 0 || lookback > ANALYSIS_MAX_LOOKBACK_DAYS) {
    throw new Error(
      `lookbackDays must be a positive number no greater than ${ANALYSIS_MAX_LOOKBACK_DAYS}.`,
    );
  }
  const parsed = request.asOf === undefined ? undefined : Date.parse(request.asOf);
  if (request.asOf !== undefined && !Number.isFinite(parsed)) {
    throw new Error("asOf must be a valid ISO timestamp when supplied.");
  }
  if (request.minScore !== undefined) {
    if (!Number.isFinite(request.minScore) || request.minScore < 0 || request.minScore > 100) {
      throw new Error("minScore must be between 0 and 100.");
    }
  }
  if (request.setupTypes !== undefined) {
    if (!Array.isArray(request.setupTypes) || request.setupTypes.some((s) => typeof s !== "string")) {
      throw new Error("setupTypes must be an array of strings.");
    }
  }
  return { asOfMs: parsed };
}

// ---------------------------------------------------------------------------
// Cell assembly — candles in, spec-26 cells + per-cell anchors out. No `frames` are
// supplied: MTF is an opt-in spec-31 transport and absent frames preserve bit-for-bit
// baseline behavior (same posture as the backtest boundary).

async function buildCells(
  assets: AssetIdentifier[],
  timeframe: Timeframe,
  windowMs: { start: number; end: number },
  provider: HistoricalDataProvider,
  frames?: AnalysisCompositionDeps["frames"],
): Promise<{
  cells: BacktestCell[];
  anchors: Map<string, AnalysisCell>;
  skipped: BacktestSkip[];
}> {
  const cells: BacktestCell[] = [];
  const anchors = new Map<string, AnalysisCell>();
  const skipped: BacktestSkip[] = [];
  for (const asset of assets) {
    if (!provider.supports({ asset, timeframe, start: windowMs.start, end: windowMs.end })) {
      skipped.push({ symbol: asset.symbol, reason: "unsupported symbol or timeframe" });
      continue;
    }
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
    const { candles, quality, classification } = response.result;
    if (candles.length === 0) {
      skipped.push({ symbol: asset.symbol, reason: "provider returned no candles" });
      continue;
    }
    // A sparse fragment must never produce a successful-looking analysis cell —
    // sparse responses are skipped with an honest reason (M1 sufficiency rule).
    if (assessDataSufficiency({ candles, quality }) === "insufficient") {
      skipped.push({
        symbol: asset.symbol,
        reason: `insufficient data — ${candles.length} bars returned for the requested window`,
      });
      continue;
    }
    // Anchor = last CLOSED bar at asOf — an open bar's contents are not yet knowable.
    const asOfIdx = closedIndexAt(candles, timeframe, windowMs.end);
    if (asOfIdx < 0) {
      skipped.push({
        symbol: asset.symbol,
        reason: "insufficient history — no closed bar exists at the evaluation timestamp",
      });
      continue;
    }
    const framesForCell = frames?.(asset, timeframe);
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
      // Spec-31 transport: only set when the resolver supplies frames — absent
      // is the documented bit-identical baseline (no join attempted).
      ...(framesForCell !== undefined ? { frames: framesForCell } : {}),
    });
    anchors.set(asset.symbol, {
      symbol: asset.symbol,
      timeframe,
      barCount: candles.length,
      evaluatedIndex: asOfIdx,
      evaluatedAt: candles[asOfIdx].time,
      asset,
      quality,
      ...(classification !== undefined ? { classification } : {}),
    });
  }
  return { cells, anchors, skipped };
}

// ---------------------------------------------------------------------------
// Composition entry point

/**
 * Runs the real engine over provider-supplied candles and returns the frozen
 * observations at the anchor bar. Throws `ServiceUnavailableError` when no cell can
 * be evaluated — a fabricated result is never returned.
 */
export async function executeAnalysis(
  request: AnalysisRequest,
  deps: AnalysisCompositionDeps,
): Promise<AnalysisResult> {
  const { asOfMs: requestedAsOf } = assertValidRequest(request);
  // `end` is the exclusive fetch bound and the evaluation timestamp; `start` is
  // lookback depth only — it supplies PIT context, it does not widen the evaluation point.
  const asOfMs = requestedAsOf ?? deps.nowMs ?? Date.now();
  const lookback = request.lookbackDays ?? ANALYSIS_DEFAULT_LOOKBACK_DAYS;
  const windowMs = { start: asOfMs - lookback * DAY_MS, end: asOfMs };

  const config = deps.config ?? defaultConfig();
  // Caller-owned spec-25 ScannerConfig parameter: developing refs are part of the
  // scan contract — `dev1` is stamped in the scanner's own paramsVersion grammar.
  // The optional `config.scanner` slot inherits runBacktest's documented fallback.
  const scanConfig: typeof config = {
    ...config,
    scanner: {
      topK: config.scanner?.topK ?? 0,
      methodVersion: config.scanner?.methodVersion ?? "v1-scan",
      includeDeveloping: true,
    },
  };

  const universe = (deps.universe ?? defaultUniverse)(request);
  if (universe.length === 0) {
    throw new Error(
      request.market === undefined
        ? "No symbols resolved for the analysis universe."
        : `No instruments known for market '${request.market}'.`,
    );
  }
  if (universe.length > ANALYSIS_MAX_SYMBOLS) {
    throw new Error(`At most ${ANALYSIS_MAX_SYMBOLS} symbols per analysis.`);
  }

  const { cells, anchors, skipped } = await buildCells(
    universe,
    request.timeframe,
    windowMs,
    deps.provider,
    deps.frames,
  );
  if (cells.length === 0) {
    throw new ServiceUnavailableError(
      "Market data provider",
      `No historical candles could be obtained for the requested symbols (${universe
        .map((a) => a.symbol)
        .join(", ")}). The analysis was not run.`,
    );
  }

  const filters = {
    setupTypes: request.setupTypes,
    minScore: request.minScore,
  };
  const hasSelection = filters.setupTypes !== undefined || filters.minScore !== undefined;
  const run = deps.run ?? runBacktest;
  const res = run({
    cells,
    selection: hasSelection ? { filters } : undefined,
    runId: "analysis",
    config: scanConfig,
  });
  if (!res.ok || res.data === undefined) {
    throw new Error(
      `Analysis engine failed: ${res.errors.map((e) => `${e.code}: ${e.message}`).join("; ")}`,
    );
  }

  // Anchor-bar filter — records exist per evaluation bar; only the anchor bar's
  // emission represents "state as of asOf" for that cell. `outcomeRef` is dropped:
  // it is a post-hoc join measured over post-anchor bars (future data at asOf).
  const atAnchor = <T extends { symbol: string; evaluatedIndex: number; outcomeRef?: unknown }>(
    r: T,
  ): T | undefined => {
    const anchor = anchors.get(r.symbol);
    if (anchor === undefined || r.evaluatedIndex !== anchor.evaluatedIndex) return undefined;
    const rest = { ...r };
    delete rest.outcomeRef; // post-hoc join — measured over post-anchor bars
    return rest;
  };

  const data = res.data;
  const cellRows = [...anchors.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  // A single value only when every evaluated cell agrees — mixed multi-provider
  // answers leave it absent and per-cell classification is the ground truth.
  const classes = new Set(cellRows.map((c) => c.classification ?? "historical"));
  const dataClassification = classes.size === 1 ? [...classes][0] : undefined;
  return {
    asOf: new Date(asOfMs).toISOString(),
    cells: cellRows,
    ...(dataClassification !== undefined ? { dataClassification } : {}),
    opportunities: data.opportunities
      .map(atAnchor)
      .filter((r): r is NonNullable<typeof r> => r !== undefined),
    developing: data.developing
      .map(atAnchor)
      .filter((r): r is NonNullable<typeof r> => r !== undefined),
    skipped,
    dataSource: deps.provider.source,
    versions: data.versions,
    // Engine-side diagnostics verbatim — includes `mtfFramesSkipped`, the
    // spec-31 count of supplied frames that failed contract validation. Never
    // hidden: a rejected frame is a reportable fact, not a silent default.
    ...(res.meta.diagnostics !== undefined
      ? { engineDiagnostics: res.meta.diagnostics }
      : {}),
  };
}
