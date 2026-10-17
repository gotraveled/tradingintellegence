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
  /** Additional explicit cost cases — re-priced on the SAME frozen scenarios;
   *  the base case (costs) is always included. Never defaults to invented values. */
  costSensitivity?: ValidationCostConfig[];
  /** Additional evaluation horizons — each evaluated independently on the same
   *  frozen scenarios; horizonBars is always included. */
  horizonSensitivity?: number[];
  /** Explicit opt-in: emit PURGED cohort aggregates alongside the raw ones —
   *  earlier-cohort scenarios whose consumed window (anchorBar, resolvedBar]
   *  reaches ANY later cohort's same-series evaluation partition are excluded
   *  from the earlier cohort's purged statistics. Diagnostics are always
   *  emitted; this flag only controls whether purged aggregates are computed. */
  purgeBoundaries?: boolean;
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
  /** Series identity — bar indices are only comparable inside the same series. */
  symbol?: string;
  timeframe?: Timeframe;
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

export interface DependenceDiagnostics {
  /** Distinct anchorBar values — multiple scenarios CAN share one anchor. */
  uniqueAnchors: number;
  /** Anchor-sorted pairs (i<j) whose evaluation windows share ≥1 future bar. */
  overlappingPairs: number;
  /** Scenarios whose window reaches a later scenario's anchor. */
  overlappingWindows: number;
  /** Connected components under transitive consecutive-window overlap — a
   *  rough upper bound on independent evidence. */
  clusters: number;
  /** Largest cluster size — worst-case correlated chain. */
  largestCluster: number;
}

export interface ValidationAggregate {
  scenarioCount: number;
  excludedCount: number;
  counts: Record<ValidationStatus, number>;
  /** Filled rows with defined netR — denominator for the MIXED filled stats. */
  filledCount: number;
  /** Mixed (realized + mark-to-market) — kept for export compatibility. */
  wins: number;
  losses: number;
  breakevens: number;
  /** REALIZED outcomes only — terminal statuses; the honest win denominator. */
  realizedCount: number;
  realizedWins: number;
  realizedLosses: number;
  realizedBreakevens: number;
  /** Mark-to-market (censored) rows — reported separately, never as realized. */
  mtmCount: number;
  mtmWins: number;
  mtmLosses: number;
  mtmBreakevens: number;
  /** netR > 0 among realized rows only — absent when realizedCount = 0. */
  realizedWinRate?: number;
  /** Mean netR over realized rows only. */
  realizedExpectancyR?: number;
  /** Mean netR over censored rows only — explicitly unrealized. */
  mtmMeanR?: number;
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
  /** Uncertainty around supported metrics — absent metrics carry a note inside. */
  uncertainty?: ValidationUncertainty;
  /** Dependence diagnostics for THIS aggregate's slice. */
  dependence?: DependenceDiagnostics;
  /** Count of scenarios whose window overlaps a later anchor inside THIS aggregate. */
  overlappingWindows?: number;
}

export interface UncertaintyEstimate {
  /** Exact estimator label — reproducibility demands the method, not a magic CI. */
  method: "wilson-score" | "student-t" | "moving-block-bootstrap";
  confidence: number;
  point: number;
  lower: number;
  upper: number;
  /** The count actually divided by — see `denominator` for its definition. */
  n: number;
  denominator: string;
  /** Whether the estimate assumes independence or models dependence. */
  dependenceHandling: "iid-assumed" | "moving-block-bootstrap";
  /** Bootstrap details — present only for resampling estimates. */
  bootstrap?: { resamples: number; blockLen: number; seed: number; resamplingUnit: string };
  caveat?: string;
}

export interface ValidationUncertainty {
  winRate?: UncertaintyEstimate;
  expectancyR?: UncertaintyEstimate;
  /** Why a metric was omitted, or which assumptions its interval carries. */
  notes: string[];
}

export interface SplitAggregate {
  name: "train" | "validation" | "test";
  fromScenario: number;
  toScenario: number;
  /** Inclusive anchor-time bounds — cohort boundaries must be inspectable. */
  anchorFrom?: string;
  anchorTo?: string;
  aggregate: ValidationAggregate;
  /** Present only when config.purgeBoundaries — recomputed on retained rows. */
  purged?: PurgedCohort;
}

export type BoundaryStatus = "clean" | "leakage_detected" | "indeterminate";
export type WalkForwardStatus = "clean" | "purged" | "leakage_detected" | "indeterminate";

export interface BoundaryContamination {
  setupId: string;
  /** Position in the run's scenario array — audit trail across cohorts. */
  scenarioIndex: number;
  /** Which earlier cohort the scenario belongs to. */
  fromCohort: string;
  /** Series the comparison was made on — indices are never mixed across series. */
  series: string;
  anchorBar: number;
  resolvedBar: number;
  /** The same-series boundary anchor this row crossed (earliest later-cohort
   *  anchor on its series). */
  boundaryAnchorBar: number;
  /** Consumed bars lying at-or-past that series boundary's first consumed bar. */
  barsIntoLaterCohort: number;
}

export interface BoundaryLeakageReport {
  /** Scenario index where the later cohort begins. */
  boundaryIndex: number;
  toCohort: string;
  /** Boundary semantics — verbatim, so consumers never guess the definition. */
  basis: string;
  /** Smallest same-series boundary anchor across the later cohort (earliest
   *  later-cohort scenario anchor); per-series values in `perSeries`. */
  boundaryAnchorBar?: number;
  /** First held-out consumed bar — boundaryAnchorBar + 1. */
  boundaryBar?: number;
  /** Anchor timestamp of the earliest later-cohort scenario. */
  boundaryTime?: string;
  /** One boundary per series present in the later cohort — bar indices are
   *  comparable only inside a single series. */
  perSeries: {
    series: string;
    boundaryAnchorBar: number;
    boundaryTime?: string;
    laterScenarioCount: number;
  }[];
  /** Evaluable earlier-cohort scenarios examined (incl. unverifiable ones). */
  earlierEvaluableCount: number;
  /** Earlier evaluable rows whose series identity or resolved timing could
   *  not be verified — these make the boundary indeterminate. */
  unverifiableCount: number;
  contaminatedCount: number;
  /** contaminatedCount / earlierEvaluableCount — absent when 0 examined. */
  contaminatedPct?: number;
  /** Distinct same-series anchor bars among contaminated scenarios. */
  affectedAnchors: number;
  /** Distinct later-cohort consumed bars also consumed by contaminating
   *  windows — per-series union size summed; undefined when not derivable. */
  laterBarsTouched?: number;
  contamination: BoundaryContamination[];
  status: BoundaryStatus;
  note?: string;
}

export interface PurgedCohort {
  /** Exact rule — recorded verbatim in methodology + shown in UI. */
  rule: string;
  retainedCount: number;
  purgedCount: number;
  purgedSetupIds: string[];
  /** Why each row was excluded — which later cohort its window reached and
   *  how far past that cohort's same-series boundary it resolved. */
  purgeReasons: { setupId: string; intoCohort: string; barsIntoLaterCohort: number }[];
  /** Aggregate over RETAINED rows only — dependence + uncertainty recomputed. */
  aggregate?: ValidationAggregate;
  /** Set when a reliable purge could not run — the cohort is then NOT purged. */
  unavailableReason?: string;
}

export interface WalkForwardReport {
  boundaries: BoundaryLeakageReport[];
  /** overall = worst of: indeterminate > (purged | leakage_detected) > clean */
  status: WalkForwardStatus;
  notes: string[];
}

export interface CostSensitivityCase {
  /** "base" for the configured costs, otherwise a deterministic label. */
  label: string;
  costs?: ValidationCostConfig;
  aggregate: ValidationAggregate;
  /** aggregate.expectancyR minus the BASE case's — negative means dearer. */
  expectancyDeltaR?: number;
  /** Filled rows whose netR sign changed vs base — cost made a winner a loser. */
  signFlips: number;
  /** True when the expectancy sign flips vs base — classification changed. */
  expectancySignChange: boolean;
}

export interface HorizonSensitivityResult {
  horizonBars: number;
  aggregate: ValidationAggregate;
  /** base status → this status transition counts (populations must be disclosed). */
  statusTransitions: Record<string, number>;
  /** Rows whose status differs from the base-horizon run. */
  changedCount: number;
}

export interface HistoricalValidationResult {
  contractVersion: typeof VALIDATION_CONTRACT_VERSION;
  /** sha256 over {config, datasets, versions} — reproduce the run bit-for-bit. */
  fingerprint: string;
  datasets: { symbol: string; timeframe: Timeframe; bars: number; firstBar: string; lastBar: string }[];
  config: ValidationRunConfig;
  configVersion: string;
  scenarioCount: number;
  scenarios: ValidatedScenario[];
  aggregate: ValidationAggregate;
  splits?: SplitAggregate[];
  /** Cross-boundary outcome-window leakage diagnostics — emitted whenever a
   *  chronological split is configured. */
  walkForward?: WalkForwardReport;
  /** Sensitivity grids — same frozen scenarios, only the named assumption varies. */
  sensitivity?: { costs?: CostSensitivityCase[]; horizons?: HorizonSensitivityResult[] };
  /** What each metric divides by and which estimator produced each interval —
   *  required to distinguish a genuine outcome change from a definition change. */
  methodology: {
    metricDefinitions: Record<string, string>;
    uncertaintyMethod: string;
    cohortBoundaries: string;
    /** Exact boundary-leakage rule + purge semantics when purging is enabled. */
    boundaryPolicy: string;
  };
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

/** Precise denominator definitions — emitted verbatim in every result. */
const METRIC_DEFINITIONS: Record<string, string> = {
  filledCount: "scenarios whose canonical activeBar stamp falls inside the evaluation window AND produced a defined netR",
  realizedCount: "filled scenarios with a TERMINAL status (target/stop/expired/cancelled) — the realized denominator",
  realizedWins: "realized scenarios with netR > 0",
  realizedLosses: "realized scenarios with netR < 0",
  realizedBreakevens: "realized scenarios with netR === 0",
  realizedWinRate: "realizedWins / realizedCount — never includes censored rows",
  realizedExpectancyR: "mean netR over realized scenarios only",
  mtmCount: "censored scenarios still open at window end — mark-to-market, NOT realized",
  mtmWins: "censored scenarios with mark-to-market netR > 0 (unrealized)",
  mtmLosses: "censored scenarios with mark-to-market netR < 0 (unrealized)",
  mtmMeanR: "mean mark-to-market netR over censored rows — explicitly unrealized",
  wins: "filled scenarios with netR > 0 — MIXED: realized + mark-to-market (kept for export compatibility)",
  losses: "filled scenarios with netR < 0 — MIXED: realized + mark-to-market",
  breakevens: "filled scenarios with netR === 0 — MIXED",
  expectancyR: "mean netR over all filled rows — MIXED: includes censored mark-to-market values",
  grossExpectancyR: "mean of grossR over filled rows before cost deduction",
  medianR: "median netR over filled rows — MIXED",
  totalR: "sum of netR over filled rows — MIXED",
  maxDrawdownR: "max peak-to-trough of cumulative netR in anchor order over filled rows (≥2)",
  meanBaselineR: "mean baselineR over scenarios that produced one (activated rows)",
  uniqueAnchors: "distinct anchor bars — a scenarioCount > uniqueAnchors gap means anchor duplication",
  overlappingPairs: "anchor-sorted pairs whose evaluation windows share at least one future bar",
  clusters: "connected components under transitive window overlap — upper bound on independent evidence",
};

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
    symbol: s.symbol,
    timeframe: s.timeframe,
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
// Uncertainty — deterministic, dependency-free, honest about its assumptions
// ---------------------------------------------------------------------------

/**
 * 97.5-percentile of Student's t by degrees of freedom — a fixed table (not an
 * approximation for tiny df, where normal z would overstate coverage).
 */
const T975: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
  8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145,
  15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
  21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060, 26: 2.056,
  27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042, 40: 2.021, 50: 2.009,
  60: 2.000, 80: 1.990, 100: 1.984, 120: 1.980,
};
const t975 = (df: number): number => {
  const keys = Object.keys(T975).map(Number).sort((a, b) => a - b);
  for (const k of keys) if (df <= k) return T975[k];
  return 1.96; // df > 120 ≈ normal
};

/** Wilson score interval for a binomial proportion (95%) — valid at any n,
 *  unlike the normal approximation which breaks down near 0/1 or small n.
 *  Assumes INDEPENDENT observations — caller attaches dependence caveats. */
export function wilsonInterval(wins: number, n: number, z = 1.96): UncertaintyEstimate | undefined {
  if (n < 1) return undefined;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    method: "wilson-score", confidence: 0.95, point: round4(p),
    lower: round4(Math.max(0, (centre - half) / denom)),
    upper: round4(Math.min(1, (centre + half) / denom)),
    n, denominator: "realized scenarios (terminal outcome, defined netR)",
    dependenceHandling: "iid-assumed",
  };
}

/** Student-t interval for a mean (95%) — requires n≥2 and nonzero variance.
 *  Assumes INDEPENDENT observations; kept only as a labelled fallback. */
export function meanTInterval(values: number[]): UncertaintyEstimate | undefined {
  const n = values.length;
  if (n < 2) return undefined;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  if (sd === 0) {
    // Degenerate: identical R values — the point is exact, report a zero-width band.
    return {
      method: "student-t", confidence: 0.95, point: round4(mean),
      lower: round4(mean), upper: round4(mean), n,
      denominator: "realized scenarios (netR values)",
      dependenceHandling: "iid-assumed",
      caveat: "all observations identical — interval collapses to the point estimate",
    };
  }
  const half = t975(n - 1) * sd / Math.sqrt(n);
  return {
    method: "student-t", confidence: 0.95, point: round4(mean),
    lower: round4(mean - half), upper: round4(mean + half), n,
    denominator: "realized scenarios (netR values)",
    dependenceHandling: "iid-assumed",
  };
}

// ---------------------------------------------------------------------------
// Dependence — windows share future bars; same anchor ≠ same window
// ---------------------------------------------------------------------------

/**
 * Pairwise window-overlap analysis over an anchor-sorted scenario slice.
 * Scenario i's window is (anchorBar_i, resolvedBar_i]; a LATER scenario shares
 * future bars iff its anchor falls strictly inside that window. Equal anchors
 * share the SAME window start — that is anchor duplication, reported via
 * uniqueAnchors, and their windows trivially overlap.
 *
 * Side effect: sets `overlapsNext` on each scenario (UI row flag).
 */
export function analyzeDependence(scenarios: ValidatedScenario[]): DependenceDiagnostics {
  // Group by canonical series first — raw bar indices are only comparable
  // inside one symbol@timeframe series (the same key candleIndex uses, so
  // duplicate files collapse to ONE series). A row without series identity
  // forms its own group: overlap can be neither asserted nor ruled out, so it
  // never merges into another row's cluster.
  const groups: { s: ValidatedScenario; end: number | undefined }[][] = [];
  const groupOf = new Map<string, number>();
  for (const s of scenarios) {
    const key = s.symbol !== undefined && s.timeframe !== undefined
      ? `${s.symbol}@${s.timeframe}` : undefined;
    const end = s.status === "unevaluable" ? undefined : (s.resolvedBar ?? s.anchorBar);
    const g = key !== undefined ? groupOf.get(key) : undefined;
    if (g === undefined) {
      groups.push([{ s, end }]);
      if (key !== undefined) groupOf.set(key, groups.length - 1);
    } else {
      groups[g].push({ s, end });
    }
  }
  let uniqueAnchors = 0, overlappingPairs = 0, clusters = 0, largestCluster = 0;
  for (const group of groups) {
    // Anchor-sorted within the series — the caller's global time ordering
    // implies it, but sorting keeps this function order-agnostic.
    const rows = [...group].sort((a, b) => a.s.anchorBar - b.s.anchorBar);
    const ends = rows.map((r) => r.end);
    const anchorSet = new Set<number>();
    for (let i = 0; i < rows.length; i++) {
      anchorSet.add(rows[i].s.anchorBar);
      if (ends[i] === undefined) continue;
      for (let j = i + 1; j < rows.length; j++) {
        if (rows[j].s.anchorBar < ends[i]!) overlappingPairs++;
        else break; // anchor-sorted — no later pair can overlap window i
      }
      // Row flag: a later same-series scenario's anchor falls inside THIS window.
      if (i + 1 < rows.length && rows[i + 1].s.anchorBar < ends[i]!) {
        rows[i].s.overlapsNext = true;
      }
    }
    uniqueAnchors += anchorSet.size;
    // Clusters = connected components under transitive window overlap.
    let run = 0, clusterEnd = -Infinity;
    for (let i = 0; i < rows.length; i++) {
      if (ends[i] === undefined) { // no window → cannot share bars; closes any open run
        if (run > largestCluster) largestCluster = run;
        run = 0; clusterEnd = -Infinity;
        continue;
      }
      if (rows[i].s.anchorBar < clusterEnd) {
        run++;
        if (ends[i]! > clusterEnd) clusterEnd = ends[i]!;
      } else {
        if (run > largestCluster) largestCluster = run;
        run = 1; clusters++; clusterEnd = ends[i]!;
      }
    }
    if (run > largestCluster) largestCluster = run;
  }
  const overlappingWindows = scenarios.filter((s) => s.overlapsNext === true).length;
  return { uniqueAnchors, overlappingPairs, overlappingWindows, clusters, largestCluster };
}

// ---------------------------------------------------------------------------
// Boundary leakage — did an earlier cohort's window consume later-cohort bars?
// ---------------------------------------------------------------------------

/** Exact boundary rule, recorded verbatim in methodology and shown in the UI. */
export const BOUNDARY_PURGE_RULE =
  "a cohort-K scenario is purged from cohort K's statistics when its consumed window (anchorBar, resolvedBar] reaches, on its own series, any bar >= (earliest anchor bar among cohort-J scenarios on the same series) + 1 for ANY later cohort J — i.e. resolvedBar exceeds the earliest later-cohort anchor on the same series; scenarios are never moved between cohorts";

/** Boundary semantics, verbatim — emitted in every report so the UI and
 *  auditors never have to guess which definition was applied. */
export const BOUNDARY_BASIS =
  "boundary = the FIRST HELD-OUT EVALUATION BAR of the later cohort, per series: (earliest anchor bar among the later cohort's scenarios on that series) + 1; bar indices are compared only inside the same symbol@timeframe series";

/** Canonical series key — identical to the candleIndex key, so two uploaded
 *  files with the same symbol@timeframe resolve to the SAME series object and
 *  their bar indices remain mutually comparable. */
const seriesKey = (s: ValidatedScenario): string | undefined =>
  s.symbol === undefined || s.timeframe === undefined
    ? undefined
    : `${s.symbol}@${s.timeframe}`;

/** Union-merge half-open-safe closed intervals [lo, hi]; input pre-sorted. */
const mergeIntervals = (ivs: [number, number][]): [number, number][] => {
  const out: [number, number][] = [];
  for (const iv of [...ivs].sort((x, y) => x[0] - y[0])) {
    const top = out[out.length - 1];
    if (top !== undefined && iv[0] <= top[1] + 1) top[1] = Math.max(top[1], iv[1]);
    else out.push([...iv]);
  }
  return out;
};

/**
 * For each adjacent cohort boundary: find earlier-cohort scenarios whose
 * consumed interval (anchorBar, resolvedBar] reaches the later cohort's
 * evaluation partition — defined PER SERIES as
 * (earliest anchorBar among later-cohort scenarios on that series) + 1.
 *
 * Design rules (established by audit, not assumed):
 * - Cohorts are contiguous slices of the anchor-TIME-sorted scenario array;
 *   the partition is a scenario-membership cut, and each series' held-out
 *   evaluation domain begins at that cohort's earliest same-series anchor.
 * - A scenario never supplies its series' boundary merely by being first in
 *   the slice — the boundary is the cohort's minimum same-series anchor, and
 *   ONLY evaluable-window rows (status !== unevaluable) define one. An
 *   unevaluable row consumed nothing, so its anchor cannot bound the
 *   partition; if a series has later rows but none can bound it, that
 *   boundary is indeterminate rather than silently fabricated.
 * - ALL evaluable earlier rows are examined (not only filled): a
 *   not_filled/censored/expired/cancelled verdict consumed bars through
 *   resolvedBar exactly as a target/stop did.
 * - Rows whose series identity is missing, whose series cannot be bounded in
 *   the later cohort, or whose resolvedBar is absent make the boundary
 *   INDETERMINATE — never silently clean.
 * - Raw integer indices are compared ONLY inside one canonical series
 *   (symbol@timeframe, the same key the candleIndex uses); identical indices
 *   from different files are never treated as overlap.
 */
export function analyzeBoundaryLeakage(
  scenarios: readonly ValidatedScenario[],
  splits: readonly SplitAggregate[],
): BoundaryLeakageReport[] {
  const reports: BoundaryLeakageReport[] = [];
  for (let b = 1; b < splits.length; b++) {
    const boundaryIndex = splits[b].fromScenario;
    const later = scenarios.slice(boundaryIndex, splits[b].toScenario);
    const earlier = scenarios.slice(0, boundaryIndex); // ALL earlier cohorts
    if (later.length === 0 || earlier.length === 0) {
      reports.push({
        boundaryIndex, toCohort: splits[b].name, basis: BOUNDARY_BASIS,
        perSeries: [], earlierEvaluableCount: 0, unverifiableCount: 0,
        contaminatedCount: 0, affectedAnchors: 0, contamination: [],
        status: "clean", note: "empty earlier or later cohort — nothing to leak",
      });
      continue;
    }

    // Per-series later-cohort partition: earliest bounding anchor + the
    // union of later rows' consumed windows (the cohort's consumed domain).
    interface SeriesDomain {
      minAnchor: number;
      boundaryTime?: string;
      rows: number;
      /** Evaluable rows that CAN bound the partition (anchor known). */
      boundingRows: number;
      unboundableRows: number;
      intervals: [number, number][];
    }
    const domains = new Map<string, SeriesDomain>();
    let laterUnkeyedConsuming = 0;
    for (const s of later) {
      const key = seriesKey(s);
      const canBound = s.status !== "unevaluable" && s.anchorBar >= 0;
      if (key === undefined) {
        // A later row whose series is unknown and which may consume bars
        // makes every earlier row's safety unverifiable.
        if (s.status !== "unevaluable" || s.anchorBar >= 0) laterUnkeyedConsuming++;
        continue;
      }
      const d = domains.get(key) ?? { minAnchor: Infinity, rows: 0, boundingRows: 0, unboundableRows: 0, intervals: [] };
      d.rows++;
      if (canBound) {
        d.boundingRows++;
        if (s.anchorBar < d.minAnchor) { d.minAnchor = s.anchorBar; d.boundaryTime = s.anchorTime; }
      } else {
        d.unboundableRows++;
      }
      if (s.status !== "unevaluable" && s.resolvedBar !== undefined && s.anchorBar >= 0) {
        d.intervals.push([s.anchorBar + 1, s.resolvedBar]);
      }
      domains.set(key, d);
    }
    for (const d of domains.values()) d.intervals = mergeIntervals(d.intervals);

    const contamination: BoundaryContamination[] = [];
    const touched: [number, number][] = [];
    let unverifiableCount = 0;
    let earlierEvaluable = 0;
    earlier.forEach((s, i) => {
      if (s.status === "unevaluable") return; // consumed no outcome bars
      earlierEvaluable++;
      const key = seriesKey(s);
      const dom = key === undefined ? undefined : domains.get(key);
      // Unverifiable: unknown series identity, OR a same-series domain that
      // exists but no later row can bound, OR missing resolved timing on a
      // comparable row, OR an unkeyed consuming later row anywhere.
      const seriesPresentButUnboundable = dom !== undefined && dom.boundingRows === 0;
      const possiblyPresent = key === undefined || dom !== undefined || laterUnkeyedConsuming > 0;
      if (key === undefined || s.resolvedBar === undefined || seriesPresentButUnboundable
          || (laterUnkeyedConsuming > 0 && possiblyPresent)) {
        unverifiableCount++;
        return;
      }
      if (dom === undefined) return; // later cohort evaluates nothing on this series — cannot contaminate THIS boundary
      const boundaryAnchor = dom.minAnchor;
      if (s.resolvedBar >= boundaryAnchor + 1) {
        contamination.push({
          setupId: s.setupId, scenarioIndex: i,
          fromCohort: splits.find((sp) => i >= sp.fromScenario && i < sp.toScenario)?.name ?? "train",
          series: key!,
          anchorBar: s.anchorBar, resolvedBar: s.resolvedBar,
          boundaryAnchorBar: boundaryAnchor,
          barsIntoLaterCohort: s.resolvedBar - boundaryAnchor,
        });
        // Intersect the contaminating window with the same-series consumed
        // domain — only bars a later row actually consumed are "touched".
        for (const iv of dom.intervals) {
          const lo = Math.max(s.anchorBar + 1, iv[0]);
          const hi = Math.min(s.resolvedBar, iv[1]);
          if (lo <= hi && hi >= boundaryAnchor + 1) touched.push([lo, hi]);
        }
      }
    });

    const perSeries = [...domains.entries()]
      .filter(([, d]) => d.boundingRows > 0)
      .map(([k, d]) => ({
        series: k, boundaryAnchorBar: d.minAnchor,
        boundaryTime: d.boundaryTime, laterScenarioCount: d.rows,
      }))
      .sort((x, y) => x.boundaryAnchorBar - y.boundaryAnchorBar || x.series.localeCompare(y.series));
    const boundaryAnchorBar = perSeries[0]?.boundaryAnchorBar;
    const indeterminate = unverifiableCount > 0;

    reports.push({
      boundaryIndex,
      toCohort: splits[b].name,
      basis: BOUNDARY_BASIS,
      boundaryAnchorBar,
      boundaryBar: boundaryAnchorBar !== undefined ? boundaryAnchorBar + 1 : undefined,
      boundaryTime: perSeries[0]?.boundaryTime,
      perSeries,
      earlierEvaluableCount: earlierEvaluable,
      unverifiableCount,
      contaminatedCount: contamination.length,
      contaminatedPct: earlierEvaluable > 0
        ? round4(contamination.length / earlierEvaluable) : undefined,
      affectedAnchors: new Set(contamination.map((c) => `${c.series}@${c.anchorBar}`)).size,
      laterBarsTouched: contamination.length > 0
        ? mergeIntervals(touched).reduce((n, [lo, hi]) => n + (hi - lo + 1), 0)
        : undefined,
      contamination,
      status: indeterminate ? "indeterminate"
        : contamination.length > 0 ? "leakage_detected" : "clean",
      ...(indeterminate
        ? { note: `${unverifiableCount} earlier evaluable row(s) have unverifiable series identity, unboundable later partition, or missing resolved timing — cross-boundary safety cannot be established` }
        : {}),
    });
  }
  return reports;
}

/**
 * Purge ONE cohort: exclude its own rows flagged by ANY later boundary
 * (boundaries = reports for cohorts AFTER this one, in order). A row leaking
 * into cohort K+2 is excluded from cohort K's purged statistics exactly as
 * one leaking into K+1. Matching is by absolute scenarioIndex — unique,
 * never name/anchor-derived. Returns unavailableReason (no aggregate) when
 * any applicable boundary is indeterminate.
 */
export function purgeCohortSlice(
  cohortRows: readonly ValidatedScenario[],
  boundaries: readonly BoundaryLeakageReport[],
  cohortFromScenario: number,
): PurgedCohort {
  const indeterminate = boundaries.filter((b) => b.status === "indeterminate");
  if (indeterminate.length > 0) {
    return {
      rule: BOUNDARY_PURGE_RULE, retainedCount: cohortRows.length,
      purgedCount: 0, purgedSetupIds: [], purgeReasons: [],
      unavailableReason: indeterminate
        .map((b) => `boundary → ${b.toCohort}: ${b.note ?? "indeterminate"}`)
        .join(" | "),
    };
  }
  const toScenario = cohortFromScenario + cohortRows.length;
  const flagged = boundaries.flatMap((b) =>
    b.contamination
      .filter((c) => c.scenarioIndex >= cohortFromScenario && c.scenarioIndex < toScenario)
      .map((c) => ({ ...c, intoCohort: b.toCohort })),
  );
  const purgeIdx = new Set(flagged.map((c) => c.scenarioIndex));
  const retained = cohortRows.filter((_, i) => !purgeIdx.has(cohortFromScenario + i));
  const reasons = flagged
    .sort((a, b) => a.scenarioIndex - b.scenarioIndex)
    .map((c) => ({ setupId: c.setupId, intoCohort: c.intoCohort, barsIntoLaterCohort: c.barsIntoLaterCohort }));
  return {
    rule: BOUNDARY_PURGE_RULE,
    retainedCount: retained.length,
    purgedCount: cohortRows.length - retained.length,
    purgedSetupIds: [...new Set(reasons.map((r) => r.setupId))],
    purgeReasons: reasons,
    aggregate: aggregateScenarios([...retained]),
  };
}

/** Overall walk-forward status from boundary reports + whether purging ran. */
export function walkForwardStatus(
  boundaries: readonly BoundaryLeakageReport[],
  purgeEnabled: boolean,
): WalkForwardStatus {
  if (boundaries.some((b) => b.status === "indeterminate")) return "indeterminate";
  if (boundaries.some((b) => b.status === "leakage_detected")) {
    return purgeEnabled ? "purged" : "leakage_detected";
  }
  return "clean";
}

// ---------------------------------------------------------------------------
// Moving-block bootstrap — dependence-aware resampling, fully deterministic
// ---------------------------------------------------------------------------

/** mulberry32 — small deterministic PRNG; same seed ⇒ same stream, always. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One moving-block resample: wrap-around blocks of `blockLen` preserve local
 *  chronological runs — the resampled sequence inherits within-block dependence. */
export function movingBlockResampleIndices(n: number, blockLen: number, rng: () => number): number[] {
  const out: number[] = [];
  while (out.length < n) {
    const start = Math.floor(rng() * n);
    for (let k = 0; k < blockLen && out.length < n; k++) out.push((start + k) % n);
  }
  return out;
}

const BOOTSTRAP_SEED = 0x9E3779B9;
const BOOTSTRAP_B = 2000;
const MIN_BOOTSTRAP_N = 8;
const MIN_INDEPENDENT_CLUSTERS = 3;

/**
 * 95% percentile interval for the mean under a moving-block bootstrap.
 * Resampling unit: chronological scenario outcomes in anchor order. Block
 * length = ceil(sqrt(n)) — a standard zero-data-tuning heuristic that scales
 * with observed dependence span; documented, not fitted to results.
 */
export function blockBootstrapMean(
  values: readonly number[],
  opts: { b?: number; blockLen?: number; seed?: number } = {},
): UncertaintyEstimate | undefined {
  const n = values.length;
  if (n < MIN_BOOTSTRAP_N) return undefined;
  const B = opts.b ?? BOOTSTRAP_B;
  const blockLen = Math.min(n, Math.max(1, opts.blockLen ?? Math.ceil(Math.sqrt(n))));
  const rng = mulberry32(opts.seed ?? BOOTSTRAP_SEED);
  const means: number[] = [];
  for (let b = 0; b < B; b++) {
    const idx = movingBlockResampleIndices(n, blockLen, rng);
    let sum = 0;
    for (const i of idx) sum += values[i];
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const point = round4(values.reduce((a, b) => a + b, 0) / n);
  return {
    method: "moving-block-bootstrap", confidence: 0.95, point,
    lower: round4(means[Math.floor(0.025 * B)]),
    upper: round4(means[Math.min(B - 1, Math.floor(0.975 * B))]),
    n, denominator: "realized scenarios in anchor order (netR values)",
    dependenceHandling: "moving-block-bootstrap",
    bootstrap: { resamples: B, blockLen, seed: BOOTSTRAP_SEED, resamplingUnit: "chronological realized scenario outcomes (anchor order)" },
    caveat: "models within-block dependence only — does NOT correct selection bias, survivorship, regime change, or censoring",
  };
}

/**
 * Assemble the uncertainty block for an aggregate's scenario slice.
 *
 * Denominators: REALIZED outcomes only (terminal statuses) — censored
 * mark-to-market rows are never silently counted as wins or losses.
 *
 * Method choice, applied per metric:
 *  1. Moving-block bootstrap — when n_realized ≥ 8 AND ≥ 3 dependence
 *     clusters exist (enough quasi-independent blocks to resample).
 *  2. Labelled iid fallback (Wilson / Student-t) — when a point estimate
 *     exists but blocks are insufficient; the assumption violation is stated.
 *  3. REFUSAL — denominators too small for any defensible interval.
 */
export function computeUncertainty(
  scenarios: readonly ValidatedScenario[],
  dependence: DependenceDiagnostics,
): ValidationUncertainty {
  const notes: string[] = [];
  const realized = scenarios.filter((s) =>
    s.entryPrice !== undefined && s.netR !== undefined && s.status !== "censored");
  const realizedRs = realized.map((s) => s.netR!);
  const realizedWins = realizedRs.filter((r) => r > 0).length;
  const n = realizedRs.length;
  const blocksOk = dependence.clusters >= MIN_INDEPENDENT_CLUSTERS;
  const bootstrapOk = n >= MIN_BOOTSTRAP_N && blocksOk;

  if (n > 0 && !bootstrapOk) {
    notes.push(
      n < MIN_BOOTSTRAP_N
        ? `dependence-aware bootstrap refused — ${n} realized observations < ${MIN_BOOTSTRAP_N} minimum; falling back to labelled iid intervals`
        : `dependence-aware bootstrap refused — ${dependence.clusters} independent window cluster(s) < ${MIN_INDEPENDENT_CLUSTERS} minimum; falling back to labelled iid intervals`,
    );
  }

  // Realized win rate — bootstrap the 0/1 series when supported, else Wilson.
  let winRate: UncertaintyEstimate | undefined;
  if (bootstrapOk) {
    winRate = blockBootstrapMean(realizedRs.map((r) => (r > 0 ? 1 : 0)));
    if (winRate) winRate = { ...winRate, denominator: "realized scenarios in anchor order (win indicators)" };
  }
  if (winRate === undefined && n >= 1) {
    winRate = wilsonInterval(realizedWins, n);
    if (winRate && dependence.overlappingPairs > 0) {
      winRate = { ...winRate, caveat: `${dependence.overlappingPairs} overlapping window pair(s) — iid assumption violated; interval likely UNDERSTATES true uncertainty` };
    }
  }
  if (winRate === undefined) {
    notes.push("realized win-rate interval omitted — no realized outcomes (denominator = 0)");
  }

  // Realized expectancy — bootstrap netR series when supported, else Student-t.
  let expectancyR: UncertaintyEstimate | undefined;
  if (bootstrapOk) expectancyR = blockBootstrapMean(realizedRs);
  if (expectancyR === undefined && n >= 2) {
    expectancyR = meanTInterval(realizedRs);
    if (expectancyR && dependence.overlappingPairs > 0) {
      expectancyR = { ...expectancyR, caveat: `${dependence.overlappingPairs} overlapping window pair(s) — iid assumption violated; interval likely UNDERSTATES true uncertainty` };
    }
  }
  if (expectancyR === undefined) {
    notes.push(n <= 1
      ? "realized expectancy interval omitted — fewer than 2 realized outcomes; no variance estimate is defensible"
      : "realized expectancy interval omitted");
  }

  const mtm = scenarios.filter((s) => s.status === "censored" && s.netR !== undefined);
  if (mtm.length > 0) {
    notes.push(`${mtm.length} censored scenario(s) carry mark-to-market netR — reported separately, EXCLUDED from realized intervals`);
  }
  notes.push("intervals quantify only the sampling uncertainty of THIS uploaded sample under the stated method — they do not bound market regime change, survivorship, or dataset-selection bias");
  return { ...(winRate ? { winRate } : {}), ...(expectancyR ? { expectancyR } : {}), notes };
}

// ---------------------------------------------------------------------------
// Sensitivity — same frozen scenarios, one assumption varied at a time
// ---------------------------------------------------------------------------

/** Re-price an evaluated scenario under a different cost case. ONLY the
 *  cost-dependent fields change — status, fills, excursions are frozen. */
function repriceScenario(s: ValidatedScenario, costs: ValidationCostConfig | undefined): ValidatedScenario {
  if (s.entryPrice === undefined || s.grossR === undefined || s.initialRisk === undefined || s.initialRisk <= 0) {
    return { ...s, costR: s.costR ?? 0, netR: s.grossR }; // unactivated rows: net = gross = 0/undefined
  }
  const costR = round4(costPrice(costs, s.entryPrice) / s.initialRisk);
  return { ...s, costR, netR: round4(s.grossR - costR) };
}

/**
 * Cost sensitivity — every case reprices the SAME evaluated scenario rows.
 * Scenario generation and selection are untouched; only R arithmetic moves.
 */
export function runCostSensitivity(
  base: readonly ValidatedScenario[],
  cases: ValidationCostConfig[],
  excludedCount: number,
): CostSensitivityCase[] {
  const baseRs = base.map((s) => s.netR);
  const baseExpect = aggregateScenarios([...base], excludedCount).expectancyR;
  const out: CostSensitivityCase[] = [];
  cases.forEach((costs, i) => {
    const repriced = base.map((s) => repriceScenario(s, costs));
    const aggregate = aggregateScenarios(repriced, excludedCount);
    let signFlips = 0;
    repriced.forEach((s, j) => {
      const a = baseRs[j], b = s.netR;
      if (a !== undefined && b !== undefined && a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b)) signFlips++;
    });
    const expectancySignChange = baseExpect !== undefined && aggregate.expectancyR !== undefined
      && baseExpect !== 0 && Math.sign(baseExpect) !== Math.sign(aggregate.expectancyR);
    out.push({
      label: `cost-${i + 1}`,
      costs,
      aggregate,
      expectancyDeltaR: baseExpect !== undefined && aggregate.expectancyR !== undefined
        ? round4(aggregate.expectancyR - baseExpect) : undefined,
      signFlips,
      expectancySignChange,
    });
  });
  return out;
}

/**
 * Horizon sensitivity — re-evaluate the SAME frozen setups at each horizon.
 * Each horizon gets its own truncated candle series and stamp-capped Setup
 * clone inside evaluateScenario, so a horizon can never observe candles or
 * lifecycle events beyond its own cutoff.
 */
export function runHorizonSensitivity(
  setups: readonly Setup[],
  candlesByCell: ReadonlyMap<string, readonly Candle[]>,
  baseConfig: ValidationRunConfig,
  baseScenarios: readonly ValidatedScenario[],
  fullRows: ReadonlyMap<string, SetupOutcome | undefined>,
  horizons: number[],
  excludedCount: number,
): HorizonSensitivityResult[] {
  const out: HorizonSensitivityResult[] = [];
  for (const h of horizons) {
    const cfg = { ...baseConfig, horizonBars: h };
    const scenarios = setups.map((s) => evaluateScenario({
      setup: s,
      candles: candlesByCell.get(`${s.symbol}@${s.timeframe}`) ?? [],
      config: cfg,
      fullRow: fullRows.get(s.id),
    }));
    // Per-horizon dependence is recomputed inside aggregateScenarios via
    // analyzeDependence — windows shrink/grow with the horizon.
    const aggregate = aggregateScenarios(scenarios, excludedCount);
    const transitions: Record<string, number> = {};
    let changed = 0;
    scenarios.forEach((s, i) => {
      const from = baseScenarios[i]?.status ?? "unevaluable";
      if (s.status !== from) {
        const key = `${from}→${s.status}`;
        transitions[key] = (transitions[key] ?? 0) + 1;
        changed++;
      }
    });
    out.push({ horizonBars: h, aggregate, statusTransitions: transitions, changedCount: changed });
  }
  return out;
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
  // REALIZED = terminal statuses; MARK-TO-MARKET = censored rows still open at
  // window end. The two populations are never silently mixed.
  const realized = filled.filter((s) => s.status !== "censored");
  const mtm = filled.filter((s) => s.status === "censored");
  const rs = filled.map((s) => s.netR!);
  const realizedRs = realized.map((s) => s.netR!);
  const mtmRs = mtm.map((s) => s.netR!);
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
  const dependence = analyzeDependence(scenarios);
  const mean = (xs: number[]) => (xs.length > 0 ? round4(xs.reduce((a, b) => a + b, 0) / xs.length) : undefined);
  return {
    scenarioCount: scenarios.length,
    excludedCount,
    counts,
    filledCount: filled.length,
    wins,
    losses,
    breakevens,
    realizedCount: realized.length,
    realizedWins: realizedRs.filter((r) => r > 0).length,
    realizedLosses: realizedRs.filter((r) => r < 0).length,
    realizedBreakevens: realizedRs.filter((r) => r === 0).length,
    mtmCount: mtm.length,
    mtmWins: mtmRs.filter((r) => r > 0).length,
    mtmLosses: mtmRs.filter((r) => r < 0).length,
    mtmBreakevens: mtmRs.filter((r) => r === 0).length,
    realizedWinRate: realized.length > 0 ? round4(realizedRs.filter((r) => r > 0).length / realized.length) : undefined,
    realizedExpectancyR: mean(realizedRs),
    mtmMeanR: mean(mtmRs),
    expectancyR: rs.length > 0 ? round4(rs.reduce((a, b) => a + b, 0) / rs.length) : undefined,
    grossExpectancyR: grossRs.length > 0 ? round4(grossRs.reduce((a, b) => a + b, 0) / grossRs.length) : undefined,
    medianR: sortedR.length === 0 ? undefined
      : sortedR.length % 2 === 1 ? sortedR[(sortedR.length - 1) / 2]
      : round4((sortedR[sortedR.length / 2 - 1] + sortedR[sortedR.length / 2]) / 2),
    totalR: rs.length > 0 ? round4(rs.reduce((a, b) => a + b, 0)) : undefined,
    maxDrawdownR,
    meanBaselineR: baselines.length > 0 ? round4(baselines.reduce((a, b) => a + b, 0) / baselines.length) : undefined,
    uncertainty: computeUncertainty(scenarios, dependence),
    dependence,
    overlappingWindows: dependence.overlappingWindows,
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
  const costsOk = (c: ValidationCostConfig | undefined): boolean => c === undefined || [c.feeBps, c.slippageBps, c.slippagePoints].every((v) => v === undefined || (Number.isFinite(v) && v >= 0));
  if (!costsOk(config.costs)) throw new Error("cost fields must be non-negative finite numbers.");
  if (config.costSensitivity !== undefined) {
    if (!Array.isArray(config.costSensitivity) || config.costSensitivity.length === 0 || config.costSensitivity.length > 4 || !config.costSensitivity.every(costsOk)) {
      throw new Error("costSensitivity must be 1–4 cost cases with non-negative finite fields.");
    }
  }
  if (config.horizonSensitivity !== undefined) {
    const hs = config.horizonSensitivity;
    if (!Array.isArray(hs) || hs.length === 0 || hs.length > 5 ||
        !hs.every((h) => Number.isInteger(h) && h >= 1) ||
        new Set(hs).size !== hs.length || hs.includes(config.horizonBars)) {
      throw new Error("horizonSensitivity must be 1–5 distinct integers ≥ 1 and different from horizonBars.");
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
  const evaluatedSetups: Setup[] = []; // retained ONLY for frozen-scenario sensitivity reruns
  let excluded = 0;
  const candleIndex = new Map(cells.map((c) => [`${c.symbol}@${c.timeframe}`, c.series.candles] as const));
  // Sort by ANCHOR TIME — the wall-clock time of the anchor bar — not by raw
  // confirmBar index: identical indices from different series are incomparable,
  // and cohort membership must follow chronological evaluation order. Rows
  // without a valid anchor fall back to createdAt (their anchorTime does too).
  const anchorTimeOf = (s: Setup): number => {
    const cb = num(s.metadata?.confirmBar);
    const candles = cb !== undefined ? candleIndex.get(`${s.symbol}@${s.timeframe}`) : undefined;
    const t = cb !== undefined && candles !== undefined && cb >= 0 && cb < candles.length
      ? candles[cb].time : undefined;
    if (t !== undefined) return t;
    const created = Date.parse(s.createdAt);
    return Number.isFinite(created) ? created : Number.MAX_SAFE_INTEGER;
  };
  for (const s of [...setups.values()].sort(
    (a, b) => anchorTimeOf(a) - anchorTimeOf(b) ||
      `${a.symbol}@${a.timeframe}`.localeCompare(`${b.symbol}@${b.timeframe}`) ||
      a.id.localeCompare(b.id),
  )) {
    if (hasSelection && !selectedIds.has(s.id)) { excluded++; continue; }
    const candles = candleIndex.get(`${s.symbol}@${s.timeframe}`);
    if (candles === undefined) { excluded++; continue; }
    evaluatedSetups.push(s);
    scenarios.push(evaluateScenario({ setup: s, candles, config, fullRow: fullRows.get(s.id) }));
  }

  // Chronological splits — contiguous cohorts by anchor order. Descriptive only:
  // this workflow performs no parameter selection, so no split can leak tuned state.
  let splits: SplitAggregate[] | undefined;
  let walkForward: WalkForwardReport | undefined;
  if (config.split !== undefined && scenarios.length > 0) {
    const n = scenarios.length;
    const nTrain = Math.floor(n * config.split.trainPct);
    const nVal = Math.floor(n * config.split.validationPct);
    const mk = (name: SplitAggregate["name"], from: number, to: number): SplitAggregate => {
      const slice = scenarios.slice(from, to);
      const aggregate = aggregateScenarios(slice);
      // A cohort with too few filled rows cannot support any conclusion — say so.
      if (aggregate.filledCount > 0 && aggregate.filledCount < 10) {
        warnings.push(`cohort '${name}': only ${aggregate.filledCount} filled scenario(s) — too small to support useful conclusions.`);
      }
      return {
        name, fromScenario: from, toScenario: to,
        anchorFrom: slice[0]?.anchorTime,
        anchorTo: slice[slice.length - 1]?.anchorTime,
        aggregate,
      };
    };
    splits = [mk("train", 0, nTrain), mk("validation", nTrain, nTrain + nVal), mk("test", nTrain + nVal, n)];

    // Boundary leakage — evaluated over ACTUAL consumed windows. Purged
    // cohorts (opt-in) remove the earlier cohort's own contaminating rows;
    // original aggregates and membership are always retained alongside.
    const boundaries = analyzeBoundaryLeakage(scenarios, splits);
    if (config.purgeBoundaries === true) {
      splits = splits.map((sp, i) => {
        if (i === splits!.length - 1) return sp; // final cohort has no later boundary
        const slice = scenarios.slice(sp.fromScenario, sp.toScenario);
        // Purge against EVERY later boundary — a row leaking into cohort K+2
        // contaminates cohort K's purged statistics too.
        return { ...sp, purged: purgeCohortSlice(slice, boundaries.slice(i), sp.fromScenario) };
      });
    }
    walkForward = {
      boundaries,
      status: walkForwardStatus(boundaries, config.purgeBoundaries === true),
      notes: [
        "purging removes only measured cross-boundary outcome-window contamination — it does NOT address regime/selection/survivorship bias, dependence within retained cohorts, or leakage through feature construction",
        ...(config.purgeBoundaries !== true
          ? ["purgeBoundaries not enabled — leakage is reported but cohort statistics remain unpurged"]
          : []),
      ],
    };
  }

  const aggregate = aggregateScenarios(scenarios, excluded);

  if (walkForward !== undefined) {
    for (const b of walkForward.boundaries) {
      if (b.status === "leakage_detected") {
        warnings.push(
          `boundary → ${b.toCohort}: ${b.contaminatedCount} earlier-cohort scenario(s) consumed later-cohort bars (${b.laterBarsTouched ?? "?"} bar(s) touched) — raw cohort statistics are contaminated${config.purgeBoundaries === true ? "; purged aggregates provided separately" : "; enable purgeBoundaries for purged aggregates"}.`,
        );
      } else if (b.status === "indeterminate") {
        warnings.push(`boundary → ${b.toCohort}: INDETERMINATE — ${b.note}`);
      }
    }
  }

  // Dependence disclosure — analyzed over the anchor-sorted run; shared bars
  // mean the rows are not independent observations.
  const dep = aggregate.dependence!;
  if (dep.overlappingPairs > 0) {
    warnings.push(
      `${dep.overlappingPairs} overlapping scenario pair(s) share future bars across ${dep.clusters} dependence cluster(s) — these rows are not independent evidence.`,
    );
  }
  if (dep.uniqueAnchors < scenarios.length) {
    warnings.push(
      `${scenarios.length - dep.uniqueAnchors} scenario(s) share an anchor with another scenario — same-anchor rows are maximally dependent, not independent observations.`,
    );
  }

  // Sensitivity grids — identical frozen scenarios, one assumption varied.
  const sensitivity: HistoricalValidationResult["sensitivity"] = {};
  if (config.costSensitivity !== undefined && config.costSensitivity.length > 0) {
    sensitivity.costs = runCostSensitivity(scenarios, config.costSensitivity, excluded);
    for (const c of sensitivity.costs) {
      if (c.expectancySignChange) {
        warnings.push(`cost case ${c.label} flips the sign of expectancy — the result is classification-sensitive to cost assumptions.`);
      } else if (c.signFlips > 0) {
        warnings.push(`cost case ${c.label} flips ${c.signFlips} scenario(s) from profitable to losing or vice-versa — margins are thin relative to assumed costs.`);
      }
    }
  }
  if (config.horizonSensitivity !== undefined && config.horizonSensitivity.length > 0) {
    sensitivity.horizons = runHorizonSensitivity(
      evaluatedSetups, candleIndex, config, scenarios, fullRows, config.horizonSensitivity, excluded,
    );
    for (const h of sensitivity.horizons) {
      if (h.aggregate.filledCount !== aggregate.filledCount || h.changedCount > 0) {
        warnings.push(
          `horizon ${h.horizonBars}: ${h.aggregate.filledCount} filled (base ${aggregate.filledCount}), ${h.changedCount} status change(s) — outcome composition depends on the horizon; improvements may reflect membership changes, not skill.`,
        );
      }
    }
  }

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
      // Full OHLCV — frame bars drive structure/momentum analysis; a close-only
      // hash would let materially different frames collide to one fingerprint.
      for (const k of f.candles) dataHash.update(`${role}:${k.time},${k.open},${k.high},${k.low},${k.close},${k.volume ?? ""};`);
    }
  }
  const fp = createHash("sha256")
    .update(JSON.stringify({
      v: VALIDATION_CONTRACT_VERSION, config, datasets, engineVersion: engine.versions,
      // Estimation contract — same data+config under a different uncertainty
      // method must NOT collide with this fingerprint.
      uncertaintyMethod: "moving-block-bootstrap v1 (B=2000, blockLen=ceil(sqrt(n)), seed=0x9E3779B9, unit=realized outcomes)",
    }))
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
    ...(walkForward !== undefined ? { walkForward } : {}),
    warnings,
    assumptions,
    ...(Object.keys(sensitivity).length > 0 ? { sensitivity } : {}),
    methodology: {
      metricDefinitions: METRIC_DEFINITIONS,
      uncertaintyMethod: "realized winRate + realized expectancyR: moving-block bootstrap (B=2000, blockLen=ceil(sqrt(n)), seed=0x9E3779B9, resampling unit=chronological realized outcomes) when n_realized≥8 AND ≥3 dependence clusters; otherwise labelled iid fallback (Wilson-score / Student-t) or refusal — censored mark-to-market rows are excluded from realized intervals",
      cohortBoundaries: splits !== undefined
        ? splits.map((s) => `${s.name}=[${s.fromScenario},${s.toScenario}) anchors ${s.anchorFrom ?? "—"}..${s.anchorTo ?? "—"}`).join(" | ")
        : "no chronological split configured",
      boundaryPolicy: splits !== undefined
        ? `${BOUNDARY_BASIS}; ${BOUNDARY_PURGE_RULE}; mode=${config.purgeBoundaries === true ? "purged aggregates emitted" : "diagnostics only"}`
        : "no chronological split configured — no boundaries exist",
    },
    engineDiagnostics: { engineVersions: engine.versions, cells: engine.cells },
    evaluatedAt: new Date().toISOString(),
  };
}
