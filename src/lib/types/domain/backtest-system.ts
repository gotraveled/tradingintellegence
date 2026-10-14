/**
 * Spec 26 — System-Level Historical Backtesting & Validation domain types.
 *
 * Orchestration + recording + aggregation only: the engine reuses every upstream semantic
 * (PIT `*StateAt` providers, spec-11 lifecycle, spec-15 scoring, spec-17 outcomes, spec-25
 * scanner). Records carry evaluation-time fields verbatim; `outcomeRef` is a post-hoc join
 * onto the authoritative `SetupOutcome` — never a redefinition, never fabricated.
 */
import type { Direction, ID, Score, Timeframe, UnixMs } from "./common";
import type { CandleSeries } from "./market";
import type { FrameRole } from "../../engines/mtf"; // spec-10 canonical role union (type-only)
import type { SetupOutcome } from "./outcome";
import type { PriceTarget } from "./opportunity";
import type { ScanFilters, StatisticalEvidence } from "./scanner";
import type {
  ScoreContribution,
  SetupReason,
  SetupStatus,
  SetupType,
} from "./setup";

/** One replay unit — caller supplies the data; the engine never fetches. */
export interface BacktestCell {
  symbol: string;
  timeframe: Timeframe;
  series: CandleSeries;
  /**
   * Spec-31 auxiliary MTF series, keyed by role (`config.mtf.set` assigns
   * timeframe→role). The role whose configured timeframe equals `timeframe` is
   * served by `series` — a frame supplied for that role is a caller error
   * (diagnostic, ignored). Absent/empty ⇒ no `alignment` on the causal join —
   * baseline behavior preserved bit-for-bit.
   */
  frames?: Partial<Record<FrameRole, CandleSeries>>;
}

/**
 * EVALUATION window only (spec-18 index semantics, clamped): bounds observation generation
 * — `startIndex <= evaluatedIndex <= endIndex`. Outcome measurement (spec 17) is NOT bounded
 * by `endIndex` — it may consume candles through the end of each cell's series.
 */
export interface BacktestWindow {
  startIndex?: number;
  endIndex?: number;
}

/** Analytical marking only — never removes records (spec-25 vocabulary). */
export interface BacktestSelection {
  filters?: ScanFilters;
  topK?: number;
}

/** Spec-16 plan projection on a record — reuses `ScanPlan` shape. */
export interface BacktestPlan {
  entry?: number;
  stopLoss?: number;
  targets?: PriceTarget[];
  riskReward?: number;
}

/**
 * One ranked scanner observation at one evaluation time — an audit record, never an
 * outcome row. `outcomeRef` is present iff spec 17 produced a `SetupOutcome` for this
 * `setupId`; identical on every observation of that setupId; never fabricated.
 */
export interface BacktestOpportunity {
  setupId: ID;
  symbol: string;
  timeframe: Timeframe;
  setupType: SetupType;
  direction: Direction;
  /** Lifecycle state the PIT pipeline emitted AT this bar — not the end state. */
  status: SetupStatus;
  /** `series.candles[t].time` — the scan's `asOf` (UnixMs). */
  evaluatedAt: UnixMs;
  /** Internal bar index — informational only; causal comparisons use `evaluatedAt`. */
  evaluatedIndex: number;
  /** Spec-25 rank within this cell's scan at this evaluation time. */
  rank: number;
  /** Analytical annotation only — never an execution decision. */
  selected?: boolean;
  score: Score;
  scoreContributions?: ScoreContribution[];
  plan?: BacktestPlan;
  /** Caller-attached, passes through verbatim; `decisionTime <= evaluatedAt` enforced. */
  statisticalEvidence?: StatisticalEvidence;
  /** Post-window join → `SetupOutcome.setupId` — absent iff spec 17 produced no row. */
  outcomeRef?: ID;
}

/** Developing observation at T — minimal projection; no score/rank, never `selected`. */
export interface BacktestDeveloping {
  setupId: ID;
  symbol: string;
  timeframe: Timeframe;
  setupType: SetupType;
  direction: Direction;
  evaluatedAt: UnixMs;
  evaluatedIndex: number;
  /** Unmet reasons only — "what's missing" (spec-25 SetupRef semantics). */
  reasons?: SetupReason[];
  outcomeRef?: ID;
}

/**
 * Pure arithmetic over authoritative fields — no probabilities, no "win" vocabulary.
 * Populations: observation counts key on records; outcome counts/rates key on unique
 * `SetupOutcome` rows (each setup counted exactly once).
 */
export interface BacktestAggregate {
  /** Ranked observations emitted (opportunities.length). */
  observationCount: number;
  /** Developing observations emitted (developing.length). */
  developingObservationCount: number;
  /** Distinct setupIds across both record lists. */
  uniqueSetupCount: number;
  /** Ranked observations with `selected === true`. */
  selectedObservationCount: number;
  /** Outcome rows with outcome ∈ {target, stop, expired} — unique setups. */
  resolvedOutcomeCount: number;
  /** Per-outcome counts over unique setups; `unresolved` = spec-17 `unresolved:true` rows
   *  PLUS observed setupIds with no SetupOutcome at all. */
  outcomeCounts: {
    target: number;
    stop: number;
    expired: number;
    cancelled: number;
    unresolved: number;
  };
  /** target / resolvedOutcomeCount — absent when denominator is 0 (never NaN). */
  targetOutcomeRate?: number;
  stopRate?: number;
  expiredRate?: number;
  /** Arithmetic mean of `rMultiple` over resolved rows where defined — a mean, not a probability. */
  expectancyR?: number;
  medianR?: number;
  totalR?: number;
  /** Same rules, partitioned by existing dims only. */
  bySetupType?: Partial<Record<SetupType, BacktestAggregate>>;
  byDirection?: Partial<Record<Direction, BacktestAggregate>>;
}

/** One deterministic run — everything needed to reproduce it is stamped here. */
export interface SystemBacktestResult {
  /** Caller-supplied label only — never derived. */
  runId?: ID;
  /** Canonical cell order: symbol ASC → timeframe canonical. */
  cells: { symbol: string; timeframe: Timeframe }[];
  window?: BacktestWindow;
  /** Canonical order: (symbol, timeframe, evaluatedIndex, rank). */
  opportunities: BacktestOpportunity[];
  developing: BacktestDeveloping[];
  /** Spec-17 rows verbatim — one per unique measurable setup. */
  outcomes: SetupOutcome[];
  aggregate: BacktestAggregate;
  versions: {
    methodVersion: string;
    /** Grammar: `sel<f|nof>|tk<k|*>` — scanner-owned params only. */
    paramsVersion: string;
    /** `config.version` verbatim — no third versioning mechanism. */
    configVersion: string;
  };
}
