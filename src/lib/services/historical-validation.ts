/**
 * Historical Scenario Validation — product-layer evaluation workflow.
 *
 * Measures how canonical engine scenarios (confirmed setups with their frozen
 * entry band / invalidation / targets) played out on candles AFTER the
 * scenario's anchor bar. Zero-budget: everything runs on user-uploaded OHLC.
 *
 * What this module owns — and what it refuses to own:
 * - Scenario GENERATION is entirely the canonical engine's (specs 02–14 causal
 *   replay, spec-11 lifecycle stamps, spec-15 scoring). This file never
 *   detects, scores, or invents a level. If the engine did not stamp a field,
 *   the scenario is `unevaluable` — never back-filled.
 * - OUTCOME MEASUREMENT is the canonical spec-17 engine (`measureOutcome`),
 *   re-invoked per scenario over a caller-bounded evaluation window. Bounding
 *   is expressed as a truncated candle series plus a Setup clone whose
 *   lifecycle stamps beyond the horizon are stripped — the engine's own
 *   ordering rules (invalidation-before-same-bar-target, proximal-edge fill,
 *   unactivated ⇒ R=0) apply verbatim. No intrabar-ordering is assumed here.
 * - Everything else (status taxonomy, costs, baseline, splits, aggregation,
 *   fingerprints) is presentation over those canonical rows.
 *
 * Documented policies (spec §23 contested definitions, product layer):
 * - GAPS: a gap bar whose [low, high] spans a level counts as a touch — OHLC
 *   cannot prove intrabar sequence, and the canonical lifecycle already
 *   encodes the conservative same-bar ordering in its stamps.
 * - ENTRY BEFORE OUTCOME: `entryPrice` exists only when the canonical
 *   `activeBar` stamp falls inside the window; no credit is possible without
 *   it (engine's own gate).
 * - CENSORING: a scenario with no terminal stamp ≤ horizon end is `censored`
 *   (mark-to-market at the horizon close) or `not_filled` when the entry was
 *   never activated — never silently "win/loss".
 * - AMBIGUITY: intrabar event ordering is resolved by the canonical
 *   conservative policy embedded in the lifecycle stamps (invalidation beats
 *   same-bar target). The `ambiguous` status exists for inputs the canonical
 *   stamps cannot adjudicate — reachable today only as a defensive fallback.
 */
import { createHash } from "node:crypto";
import type {
  BacktestCell,
  Candle,
  Direction,
  EngineConfig,
  Setup,
  SetupOutcome,
  SetupType,
  SystemBacktestResult,
  Timeframe,
} from "@/lib/types";
import { runBacktest } from "@/lib/engines/backtest";
import { measureOutcome } from "@/lib/engines/outcomes";
import { validateBars } from "@/lib/market-data/validation";

export const VALIDATION_CONTRACT_VERSION = "hv1";

// ---------------------------------------------------------------------------
// Contract — request
// ---------------------------------------------------------------------------

/** Explicit cost assumptions — never hidden constants. Applied per round trip. */
export interface ValidationCostConfig {
  /** Round-trip fees as basis points of notional at entry price. */
  feeBps?: number;
  /** Round-trip slippage as basis points of notional at entry price. */
  slippageBps?: number;
  /** Round-trip slippage in absolute price points (e.g. tick count × tick size). */
  slippagePoints?: number;
}

export interface ValidationRunConfig {
  /** Bars after the anchor available to each scenario's outcome window (≥1). */
  horizonBars: number;
  /** Optional cap on how many bars a scenario may wait for entry activation. */
  entryDeadlineBars?: number;
  costs?: ValidationCostConfig;
  /** Analytical marking only — mirrors spec-25 semantics; never fabricates. */
  minScore?: number;
  setupTypes?: SetupType[];
  /** Chronological cohorts. test = remainder. Descriptive only — no tuning exists
   *  in this workflow, so no split can leak tuned parameters. */
  split?: { trainPct: number; validationPct: number };
}

export type ValidationStatus =
  | "target"        // terminal target event inside the window
  | "stop"          // terminal invalidation inside the window
  | "expired"       // lifecycle expiry inside the window
  | "cancelled"     // lifecycle cancellation inside the window
  | "not_filled"    // window ended before entry activation
  | "censored"      // activated, still open at window end (mark-to-market)
  | "ambiguous"     // defensive: canonical stamps cannot adjudicate
  | "unevaluable";  // scenario fields missing/invalid or engine declined

export interface ScenarioLevels {
  entryBandLow: number;
  entryBandHigh: number;
  invalidation: number;
  targets: number[];
}

export interface ValidatedScenario {
  setupId: string;
  setupType: SetupType;
  direction: Direction;
  /** Anchor = canonical confirmBar — the last bar whose close the scenario knew. */
  anchorBar: number;
  anchorTime: string;
  /** Frozen point-in-time scenario artifact (canonical stamps verbatim). */
  scenario: ScenarioLevels;
  scoreAtConfirmation?: number;
  status: ValidationStatus;
  statusReason?: string;
  /** Only present when entry activated inside the window (engine semantics). */
  entryPrice?: number;
  initialRisk?: number;
  riskAtr?: number;
  /** Bar index the window resolved/censored on; ISO time alongside. */
  resolvedBar?: number;
  resolvedAt?: string;
  barsToActive?: number | null;
  targetsReached?: number;
  /** R computed by the canonical engine over the capped window (gross). */
  grossR?: number;
  /** Configured cost deduction in R — 0 when no costs were configured. */
  costR?: number;
  netR?: number;
  mfeR?: number;
  maeR?: number;
  /** Directional buy-and-hold reference from anchor close to window-end close. */
  baselineR?: number;
  baselineReturnPct?: number;
  /** True when this scenario's evaluation window overlaps a later scenario's
   *  anchor — overlapping windows are disclosed, never double-counted as
   *  independent evidence. */
  overlapsNext?: boolean;
}

// ---------------------------------------------------------------------------
// Contract — result
// ---------------------------------------------------------------------------

export interface ValidationAggregate {
  scenarioCount: number;
  /** Confirmed setups excluded before evaluation (missing levels, out-of-window). */
  excludedCount: number;
  counts: Record<ValidationStatus, number>;
  /** Scenarios with an activated entry inside the window. */
  filledCount: number;
  /** filled rows partitioned by netR sign — precise definitions, no "win rate = profit". */
  wins: number;
  losses: number;
  breakevens: number;
  /** Mean netR over filled rows with defined netR — absent on empty denominator. */
  expectancyR?: number;
  grossExpectancyR?: number;
  medianR?: number;
  totalR?: number;
  /** Peak-to-trough of cumulative netR in anchor order — only emitted when a
   *  defensible sequence exists (≥2 filled rows). */
  maxDrawdownR?: number;
  /** Mean of the directional-hold baseline over scenarios that produced baselineR. */
  meanBaselineR?: number;
}

export interface SplitAggregate {
  name: "train" | "validation" | "test";
  fromScenario: number;
  toScenario: number;
  aggregate: ValidationAggregate;
}

export interface HistoricalValidationResult {
  contractVersion: typeof VALIDATION_CONTRACT_VERSION;
  /** sha256 over {config, datasets} — reproduce the run bit-for-bit. */
  fingerprint: string;
  datasets: { symbol: string; timeframe: Timeframe; bars: number; firstBar: string; lastBar: string }[];
  config: ValidationRunConfig;
  configVersion: string;
  scenarioCount: number;
  scenarios: ValidatedScenario[];
  aggregate: ValidationAggregate;
  splits?: SplitAggregate[];
  /** Honest caveats — sample size, overlap, censoring share, data quality, bias. */
  warnings: string[];
  assumptions: string[];
  engineDiagnostics?: Record<string, unknown>;
  evaluatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const sgn = (d: Direction) => (d === "bearish" ? -1 : 1);
const round4 = (x: number) => Number(x.toFixed(4));
const toISO = (ms: number) => new Date(ms).toISOString();

const TERMINAL_STAMPS = ["targetReachedBar", "invalidatedBar", "expiredBar", "cancelledBar"] as const;

/** Setup clone whose post-horizon lifecycle stamps are removed — the engine then
 *  cannot observe events outside the window, exactly as it cannot on a truncated series. */
function capSetup(s: Setup, hEnd: number, entryDeadline?: number): Setup {
  const m = { ...(s.metadata ?? {}) };
  for (const key of TERMINAL_STAMPS) {
    const b = num(m[key]);
    if (b !== undefined && b > hEnd) delete m[key];
  }
  // Entry deadline: activation stamps beyond the cap are invisible inside the window.
  const actCap = entryDeadline !== undefined ? Math.min(hEnd, (num(m.confirmBar) ?? 0) + entryDeadline) : hEnd;
  const ab = num(m.activeBar);
  if (ab !== undefined && ab > actCap) delete m.activeBar;
  const tb = typeof m.targetBars === "string" && m.targetBars.length > 0
    ? m.targetBars.split(",").map(Number).filter(Number.isFinite)
    : [];
  if (tb.length > 0) m.targetBars = tb.filter((b) => b <= hEnd).join(",");
  return { ...s, metadata: m };
}

/** Round-trip cost in price units at the entry price — explicit formula only. */
function costPrice(costs: ValidationCostConfig | undefined, entry: number): number {
  if (!costs) return 0;
  const bps = ((costs.feeBps ?? 0) + (costs.slippageBps ?? 0)) / 10_000;
  return entry * bps + (costs.slippagePoints ?? 0);
}

// ---------------------------------------------------------------------------
// Scenario evaluation — canonical stamps + capped spec-17 measurement
// ---------------------------------------------------------------------------

export function evaluateScenario(input: {
  setup: Setup;
  candles: readonly Candle[];
  config: ValidationRunConfig;
  /** Full-series canonical row for this setup — supplies score/regime context. */
  fullRow?: SetupOutcome;
}): ValidatedScenario {
  const { setup: s, candles, config } = input;
  const n = candles.length;
  const cb = num(s.metadata?.confirmBar);
  const base: Omit<ValidatedScenario, "status"> = {
    setupId: s.id,
    setupType: s.type,
    direction: s.direction,
    anchorBar: cb ?? -1,
    anchorTime: cb !== undefined && cb >= 0 && cb < n ? toISO(candles[cb].time) : s.createdAt,
    scenario: {
      entryBandLow: num(s.metadata?.entryBandLow) ?? NaN,
      entryBandHigh: num(s.metadata?.entryBandHigh) ?? NaN,
      invalidation: num(s.metadata?.invalidation) ?? NaN,
      targets: (typeof s.metadata?.targets === "string" && s.metadata.targets.length > 0
        ? s.metadata.targets.split(",").map(Number).filter(Number.isFinite)
        : []),
    },
    scoreAtConfirmation: input.fullRow?.scoreAtConfirmation,
  };

  if (cb === undefined || cb < 0 || cb >= n) {
    return { ...base, status: "unevaluable", statusReason: "setup never confirmed (no confirmBar stamp)" };
  }
  const low = num(s.metadata?.entryBandLow);
  const high = num(s.metadata?.entryBandHigh);
  const inv = num(s.metadata?.invalidation);
  if (low === undefined || high === undefined || inv === undefined || !(low <= high)) {
    return { ...base, status: "unevaluable", statusReason: "missing or inverted entry band / invalidation stamps" };
  }

  // Window: strictly post-anchor observation, capped by horizon and series end.
  const hEnd = Math.min(cb + Math.max(1, Math.floor(config.horizonBars)), n - 1);
  if (hEnd <= cb) {
    return { ...base, status: "unevaluable", statusReason: "anchor is the last bar — no forward data" };
  }
  const capped = capSetup(s, hEnd, config.entryDeadlineBars);
  const res = measureOutcome({
    setup: capped,
    candles: candles.slice(0, hEnd + 1),
    scoreAtConfirmation: input.fullRow?.scoreAtConfirmation,
    scoreAtDetection: input.fullRow?.scoreAtDetection,
    regime: input.fullRow?.regime,
    paramsVersion: VALIDATION_CONTRACT_VERSION,
  });
  if (!res.ok || res.data === undefined) {
    const reason = res.errors.map((e) => e.message).join("; ") || "engine declined measurement";
    return { ...base, status: "unevaluable", statusReason: reason };
  }
  const row = res.data;
  const activated = row.entryPrice !== undefined;
  const risk = row.initialRisk;

  // Status from the capped stamps — the engine's terminal-priority ordering applies.
  // Conservative tie-break (priority): on an equal-bar collision the WORST
  // plausible outcome wins — stop before expiry/cancel before target — mirroring
  // the canonical invalidation-before-same-bar-target rule.
  const m = capped.metadata ?? {};
  const terms: { stamp: string; status: ValidationStatus; priority: number }[] = [
    { stamp: "invalidatedBar", status: "stop", priority: 0 },
    { stamp: "expiredBar", status: "expired", priority: 1 },
    { stamp: "cancelledBar", status: "cancelled", priority: 2 },
    { stamp: "targetReachedBar", status: "target", priority: 3 },
  ];
  const hit = terms
    .map((t) => ({ ...t, bar: num(m[t.stamp]) }))
    .filter((t): t is { stamp: string; status: ValidationStatus; priority: number; bar: number } => t.bar !== undefined)
    .sort((a, b) => a.bar - b.bar || a.priority - b.priority)[0];
  let status: ValidationStatus = hit?.status ?? (activated ? "censored" : "not_filled");
  if (!activated && (status === "target" || status === "stop" || status === "ambiguous")) {
    // Defensive: a terminal hit without activation can't be a trade outcome.
    status = status === "target" ? "ambiguous" : "not_filled";
  }

  const grossR = row.rMultiple;
  const costR = activated && risk !== undefined && risk > 0
    ? round4(costPrice(config.costs, row.entryPrice!) / risk)
    : 0;
  const netR = grossR !== undefined ? round4(grossR - costR) : undefined;

  // Baseline: enter at anchor close in the scenario direction, exit at window close.
  const entryC = candles[cb].close;
  const exitC = candles[hEnd].close;
  const baselineReturnPct = entryC > 0 ? round4((sgn(s.direction) * (exitC - entryC) / entryC) * 100) : undefined;
  const baselineR = activated && risk !== undefined && risk > 0
    ? round4(sgn(s.direction) * (exitC - entryC) / risk)
    : undefined;

  return {
    ...base,
    status,
    entryPrice: row.entryPrice,
    initialRisk: row.initialRisk,
    riskAtr: row.riskAtr,
    resolvedBar: hit !== undefined ? Math.min(hit.bar, hEnd) : hEnd,
    resolvedAt: toISO(candles[hit !== undefined ? Math.min(hit.bar, hEnd) : hEnd].time),
    barsToActive: row.barsToActive,
    targetsReached: row.targetsReached,
    grossR,
    costR,
    netR,
    mfeR: row.mfeR,
    maeR: row.maeR,
    baselineR,
    baselineReturnPct,
  };
}

// ---------------------------------------------------------------------------
// Aggregation — precise definitions; denominators never fabricated
// ---------------------------------------------------------------------------

export function aggregateScenarios(scenarios: ValidatedScenario[], excludedCount = 0): ValidationAggregate {
  const counts: Record<ValidationStatus, number> = {
    target: 0, stop: 0, expired: 0, cancelled: 0,
    not_filled: 0, censored: 0, ambiguous: 0, unevaluable: 0,
  };
  for (const sc of scenarios) counts[sc.status]++;
  const filled = scenarios.filter((s) => s.entryPrice !== undefined && s.netR !== undefined);
  const rs = filled.map((s) => s.netR!);
  const grossRs = filled.map((s) => s.grossR!).filter((x) => x !== undefined);
  const wins = rs.filter((r) => r > 0).length;
  const losses = rs.filter((r) => r < 0).length;
  const breakevens = rs.filter((r) => r === 0).length;
  const sortedR = [...rs].sort((a, b) => a - b);
  let maxDrawdownR: number | undefined;
  if (rs.length >= 2) {
    let equity = 0, peak = 0, mdd = 0;
    for (const s of filled) {
      equity += s.netR!;
      peak = Math.max(peak, equity);
      mdd = Math.max(mdd, peak - equity);
    }
    maxDrawdownR = round4(mdd);
  }
  const baselines = scenarios.map((s) => s.baselineR).filter((x): x is number => x !== undefined);
  return {
    scenarioCount: scenarios.length,
    excludedCount,
    counts,
    filledCount: filled.length,
    wins,
    losses,
    breakevens,
    expectancyR: rs.length > 0 ? round4(rs.reduce((a, b) => a + b, 0) / rs.length) : undefined,
    grossExpectancyR: grossRs.length > 0 ? round4(grossRs.reduce((a, b) => a + b, 0) / grossRs.length) : undefined,
    medianR: sortedR.length === 0 ? undefined
      : sortedR.length % 2 === 1 ? sortedR[(sortedR.length - 1) / 2]
      : round4((sortedR[sortedR.length / 2 - 1] + sortedR[sortedR.length / 2]) / 2),
    totalR: rs.length > 0 ? round4(rs.reduce((a, b) => a + b, 0)) : undefined,
    maxDrawdownR,
    meanBaselineR: baselines.length > 0 ? round4(baselines.reduce((a, b) => a + b, 0) / baselines.length) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Orchestration — canonical engine → capped evaluation → honest report
// ---------------------------------------------------------------------------

export interface HistoricalValidationDeps {
  run?: typeof runBacktest;
  config: EngineConfig;
}

export function runHistoricalValidation(input: {
  cells: BacktestCell[];
  config: ValidationRunConfig;
  deps: HistoricalValidationDeps;
}): HistoricalValidationResult {
  const { cells, config, deps } = input;
  const run = deps.run ?? runBacktest;

  if (!Number.isFinite(config.horizonBars) || config.horizonBars < 1) {
    throw new Error("ValidationConfig.horizonBars must be a finite number ≥ 1.");
  }
  if (config.entryDeadlineBars !== undefined && (!Number.isFinite(config.entryDeadlineBars) || config.entryDeadlineBars < 1)) {
    throw new Error("ValidationConfig.entryDeadlineBars must be a finite number ≥ 1 when provided.");
  }
  if (config.split !== undefined) {
    const { trainPct, validationPct } = config.split;
    const bad = [trainPct, validationPct].some((p) => !Number.isFinite(p) || p < 0 || p > 1);
    if (bad || trainPct + validationPct >= 1) {
      throw new Error("split percentages must be in [0,1] and sum to < 1.");
    }
  }

  // Data-quality facts collected BEFORE the run — malformed cells are reported,
  // and the engine independently skips them (spec-01 validation).
  const warnings: string[] = [];
  const datasets = cells.map((c) => {
    const issues = validateBars([...c.series.candles], c.timeframe);
    for (const i of issues) {
      warnings.push(`${c.symbol}@${c.timeframe}: ${i.severity} — ${i.message}`);
    }
    return {
      symbol: c.symbol,
      timeframe: c.timeframe,
      bars: c.series.candles.length,
      firstBar: toISO(c.series.candles[0]?.time ?? 0),
      lastBar: toISO(c.series.candles[c.series.candles.length - 1]?.time ?? 0),
    };
  });

  // Canonical run — measured setups collected via the additive spec-26 hook.
  const setups = new Map<string, Setup>();
  const res = run({
    cells,
    selection: {
      filters: {
        setupTypes: config.setupTypes,
        minScore: config.minScore,
      },
    },
    runId: `hv-${VALIDATION_CONTRACT_VERSION}`,
    config: deps.config,
    onMeasuredSetup: (s) => setups.set(s.id, s),
  });
  if (!res.ok || res.data === undefined) {
    throw new Error(`Backtest engine failed: ${res.errors.map((e) => `${e.code}: ${e.message}`).join("; ")}`);
  }
  const engine: SystemBacktestResult = res.data;
  const fullRows = new Map(engine.outcomes.map((o) => [o.setupId, o]));
  const selectedIds = new Set(
    engine.opportunities.filter((o) => o.selected === true).map((o) => o.setupId),
  );
  const hasSelection = config.setupTypes !== undefined || config.minScore !== undefined;

  // Evaluate each measured setup under the capped window — anchor order.
  const scenarios: ValidatedScenario[] = [];
  let excluded = 0;
  const candleIndex = new Map(cells.map((c) => [`${c.symbol}@${c.timeframe}`, c.series.candles] as const));
  for (const s of [...setups.values()].sort(
    (a, b) => (num(a.metadata?.confirmBar) ?? 0) - (num(b.metadata?.confirmBar) ?? 0) || a.id.localeCompare(b.id),
  )) {
    if (hasSelection && !selectedIds.has(s.id)) { excluded++; continue; }
    const candles = candleIndex.get(`${s.symbol}@${s.timeframe}`);
    if (candles === undefined) { excluded++; continue; }
    scenarios.push(evaluateScenario({ setup: s, candles, config, fullRow: fullRows.get(s.id) }));
  }

  // Overlap disclosure: window_i = [anchor_i+1, anchor_i+horizon]; flag when the
  // next scenario's anchor falls inside it — evidence shares candles.
  let overlapping = 0;
  for (let i = 0; i < scenarios.length - 1; i++) {
    const a = scenarios[i];
    const b = scenarios[i + 1];
    if (a.status === "unevaluable") continue;
    const aEnd = a.anchorBar + Math.max(1, Math.floor(config.horizonBars));
    if (b.anchorBar <= aEnd) { a.overlapsNext = true; overlapping++; }
  }
  if (overlapping > 0) {
    warnings.push(`${overlapping} scenario(s) have evaluation windows overlapping a later scenario's anchor — shared candles mean these rows are not independent observations.`);
  }

  // Chronological splits — contiguous cohorts by anchor order. Descriptive only:
  // this workflow performs no parameter selection, so no split can leak tuned state.
  let splits: SplitAggregate[] | undefined;
  if (config.split !== undefined && scenarios.length > 0) {
    const n = scenarios.length;
    const nTrain = Math.floor(n * config.split.trainPct);
    const nVal = Math.floor(n * config.split.validationPct);
    const mk = (name: SplitAggregate["name"], from: number, to: number): SplitAggregate =>
      ({ name, fromScenario: from, toScenario: to, aggregate: aggregateScenarios(scenarios.slice(from, to)) });
    splits = [mk("train", 0, nTrain), mk("validation", nTrain, nTrain + nVal), mk("test", nTrain + nVal, n)];
  }

  const aggregate = aggregateScenarios(scenarios, excluded);
  if (aggregate.filledCount > 0 && aggregate.filledCount < 30) {
    warnings.push(`small sample — ${aggregate.filledCount} filled scenarios; descriptive statistics only, no inference about expected performance is warranted.`);
  }
  const censoredShare = aggregate.scenarioCount > 0 ? aggregate.counts.censored / aggregate.scenarioCount : 0;
  if (censoredShare > 0.5) {
    warnings.push(`>${Math.round(censoredShare * 100)}% of scenarios reached the horizon unresolved (censored) — consider a longer horizon or dataset before interpreting results.`);
  }
  warnings.push("user-uploaded historical sample: coverage, survivorship, and selection bias cannot be assessed by this tool — results describe this dataset only.");

  const assumptions = [
    `observation opens at anchorBar+1 (anchor close is evidence, not outcome)`,
    `evaluation window = horizonBars=${config.horizonBars} bars, clamped at series end`,
    config.entryDeadlineBars !== undefined ? `entry activation must occur within ${config.entryDeadlineBars} bars` : `no separate entry deadline — horizon applies`,
    `same-bar stop/target ordering: canonical conservative policy (invalidation resolves before same-bar target; wicks never invalidate)`,
    `entry fill: first-touched proximal band edge (canonical); gap-through counts as a touch`,
    config.costs ? `costs: ${JSON.stringify(config.costs)} applied round-trip, deducted in R` : `no costs configured — gross = net`,
    `baseline: directional hold from anchor close to window-end close`,
    `R-multiple requires activated entry and initialRisk > 0; zero-risk scenarios are unevaluable`,
  ];

  // Reproducibility digest binds to CONTENT: config + per-cell candle tuples
  // (time+OHLCV) + engine versions — identical data & config ⇒ identical run.
  const dataHash = createHash("sha256");
  for (const c of cells) {
    dataHash.update(`${c.symbol}@${c.timeframe}|`);
    for (const k of c.series.candles) {
      dataHash.update(`${k.time},${k.open},${k.high},${k.low},${k.close},${k.volume ?? ""};`);
    }
    for (const [role, f] of Object.entries(c.frames ?? {})) {
      for (const k of f.candles) dataHash.update(`${role}:${k.time},${k.close};`);
    }
  }
  const fp = createHash("sha256")
    .update(JSON.stringify({ v: VALIDATION_CONTRACT_VERSION, config, datasets, engineVersion: engine.versions }))
    .update(dataHash.digest())
    .digest("hex");

  return {
    contractVersion: VALIDATION_CONTRACT_VERSION,
    fingerprint: fp,
    datasets,
    config,
    configVersion: engine.versions.configVersion,
    scenarioCount: scenarios.length,
    scenarios,
    aggregate,
    ...(splits !== undefined ? { splits } : {}),
    warnings,
    assumptions,
    engineDiagnostics: { engineVersions: engine.versions, cells: engine.cells },
    evaluatedAt: new Date().toISOString(),
  };
}
