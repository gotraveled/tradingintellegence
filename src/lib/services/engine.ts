/**
 * Engine contracts (docs/engine/20-engine-interfaces.md).
 *
 * Interfaces only — no algorithm logic lives here or anywhere in this app. Each engine is a
 * pure, independently testable unit: same inputs + same config → identical output. Engines are
 * composed by the pipeline (00): data → swings → structure → liquidity → zones → imbalances →
 * momentum → setups → score → outcomes.
 */
import type {
  BreakoutConfig,
  CandleSeries,
  ContinuationConfig,
  DetectionEvent,
  EngineConfig,
  FVGConfig,
  ID,
  Imbalance,
  LifecycleConfig,
  LiquidityConfig,
  LiquidityPool,
  MarketStructure,
  Momentum,
  MomentumConfig,
  MomentumFeatures,
  MTFConfig,
  MultiTimeframeAlignment,
  Opportunity,
  OpportunityScoreResult,
  RegimeConfig,
  RegimeLabel,
  ReversalConfig,
  ScanCandidate,
  ScanFilters,
  ScanResult,
  ScanUniverse,
  ScannerConfig,
  ScoringConfig,
  Setup,
  SetupOutcome,
  SystemBacktestResult,
  StatisticalDecision,
  StatsConfig,
  ProbabilityEstimate,
  StructureConfig,
  SwingConfig,
  SwingPoint,
  Timeframe,
  UnixMs,
  Zone,
  ZoneConfig,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Shared envelope — every engine returns the same shape.

/** Failure modes every engine may return (never thrown for expected conditions). */
export type EngineErrorCode =
  | "insufficient_data" // not enough closed bars / missing required fields
  | "invalid_input" // candles unsorted, duplicate identity, negative prices
  | "invalid_config" // weights don't sum to 1, bars < 0, etc.
  | "unavailable" // an upstream stage produced no usable output
  | "internal"; // engine bug — surfaced, never swallowed

export interface EngineError {
  code: EngineErrorCode;
  message: string;
  /** Which input/parameter caused it, when known. */
  detail?: string;
}

/** Run metadata every engine stamps on its output. */
export interface EngineMeta {
  /** Which pipeline stage produced this result. */
  stage: string;
  /** EngineParams/config version — results are comparable only within a version. */
  paramsVersion: string;
  /** Bars consumed (index range of the input). */
  barsConsumed: { from: number; to: number };
  /** Detection events emitted during the run (for the audit trail / UI timeline). */
  events: DetectionEvent[];
  /** Stage-specific diagnostics (rejected candidates, redistribution applied, etc.). */
  diagnostics?: Record<string, number | string | boolean>;
}

export interface EngineResult<T> {
  ok: boolean;
  data?: T;
  errors: EngineError[];
  meta: EngineMeta;
}

// ---------------------------------------------------------------------------
// Stage contracts — each maps 1:1 to a spec document.

/** 02 — Swing detection. */
export interface SwingEngine {
  detect(input: { series: CandleSeries; config: SwingConfig }): EngineResult<SwingPoint[]>;
}

/** 03 — Market structure (HH/HL/LH/LL, trend, BOS/CHOCH). */
export interface MarketStructureEngine {
  analyze(input: {
    series: CandleSeries;
    swings: SwingPoint[];
    config: StructureConfig;
  }): EngineResult<MarketStructure>;
}

/** 04 — Liquidity pools and interactions (sweeps, break family). */
export interface LiquidityEngine {
  analyze(input: {
    series: CandleSeries;
    structure: MarketStructure;
    config: LiquidityConfig;
  }): EngineResult<{ pools: LiquidityPool[]; events: DetectionEvent[] }>;
}

/** 05–07 — Demand/supply zones incl. lifecycle tracking. */
export interface ZoneEngine {
  analyze(input: {
    series: CandleSeries;
    structure: MarketStructure;
    pools: LiquidityPool[];
    config: ZoneConfig;
  }): EngineResult<Zone[]>;
}

/** 08 — Fair value gaps / imbalances. */
export interface ImbalanceEngine {
  analyze(input: { series: CandleSeries; config: FVGConfig }): EngineResult<Imbalance[]>;
}

/** 09 Part A — Displacement scoring for a single leg. */
export interface DisplacementEngine {
  score(input: {
    series: CandleSeries;
    /** Bar index where the leg begins. */
    legStart: number;
    /** Bar index where the leg ends (measured). */
    legEnd: number;
    direction: "bullish" | "bearish";
    structure?: MarketStructure;
    config: MomentumConfig;
  }): EngineResult<{ score: number; components: Record<string, number> }>;
}

/** 09 Part B — Momentum state/features. */
export interface MomentumEngine {
  analyze(input: { series: CandleSeries; config: MomentumConfig }): EngineResult<{
    momentum: Momentum;
    features: MomentumFeatures;
  }>;
}

/** 10 — Multi-timeframe combination. */
export interface MultiTimeframeEngine {
  align(input: {
    symbol: string;
    /** Full per-timeframe analysis from earlier stages. */
    frames: {
      htf: { timeframe: Timeframe; structure: MarketStructure; momentum: Momentum };
      itf: { timeframe: Timeframe; structure: MarketStructure; momentum: Momentum };
      etf: { timeframe: Timeframe; structure: MarketStructure; momentum: Momentum };
    };
    config: MTFConfig;
  }): EngineResult<MultiTimeframeAlignment>;
}

/** 19 — Market regime label. */
export interface MarketRegimeEngine {
  classify(input: {
    structure: MarketStructure;
    features: MomentumFeatures;
    config: RegimeConfig;
  }): EngineResult<{ regime: RegimeLabel }>;
}

/** 11–14 — Setup detection across reversal/breakout/continuation. */
export interface SetupDetectionEngine {
  detect(input: {
    series: CandleSeries;
    structure: MarketStructure;
    pools: LiquidityPool[];
    zones: Zone[];
    imbalances: Imbalance[];
    momentum: Momentum;
    alignment?: MultiTimeframeAlignment;
    config: {
      lifecycle: LifecycleConfig;
      reversal: ReversalConfig;
      breakout: BreakoutConfig;
      continuation: ContinuationConfig;
    };
  }): EngineResult<Setup[]>;
}

/**
 * 15 — Opportunity scoring. Consumes end-of-series snapshots per the contract; the scorer
 * evaluates the setup AT its stamped `metadata.confirmBar` and reconstructs causal pool/zone/FVG
 * status there from bar-indexed stamps — final end-of-series statuses are never used to answer
 * historical questions. Hard vetoes (spec 15 §4) return `data.gate`, never a score.
 */
export interface OpportunityScoringEngine {
  score(input: {
    setup: Setup;
    structure: MarketStructure;
    pools: LiquidityPool[];
    zones: Zone[];
    imbalances: Imbalance[];
    momentum: Momentum;
    alignment?: MultiTimeframeAlignment;
    regime?: RegimeLabel;
    config: ScoringConfig;
  }): EngineResult<OpportunityScoreResult>;
}

/** 17 — Outcome measurement over a historical window. */
export interface OutcomeEngine {
  measure(input: {
    setup: Setup;
    opportunity: Opportunity;
    series: CandleSeries;
    regime?: RegimeLabel;
    /** Score when the setup first became `developing` (spec 17 `scoreAtDetection`) —
     *  caller computes at `candidateBar` on the causal scoring path. */
    scoreAtDetection?: number;
    /** Params version stamped on the row — comparability boundary (spec 17/23). */
    paramsVersion?: string;
  }): EngineResult<SetupOutcome>;
}

/** 26 — System backtest: deterministic re-evaluation over a cell grid + evaluation window.
 *  Orchestration + recording + aggregation only — never trades, positions, or equity. */
export interface BacktestEngine {
  run(input: {
    /** Cell grid — caller supplies the data; the engine never fetches. Order irrelevant. */
    cells: { symbol: string; timeframe: Timeframe; series: CandleSeries }[];
    /** Evaluation window (spec-18 index semantics) — bounds observation generation only;
     *  spec-17 outcome measurement may consume candles through each series' end. */
    window?: { startIndex?: number; endIndex?: number };
    /** Analytical marking only — never removes records. */
    selection?: { filters?: ScanFilters; topK?: number };
    /** Caller-supplied label only — never derived. */
    runId?: ID;
    config: EngineConfig;
  }): EngineResult<SystemBacktestResult>;
}

/** 24 — Statistical validation: empirical outcome frequencies over a comparable cohort. */
export interface StatisticalValidationEngine {
  estimate(input: {
    /** The decision view — only what was knowable at the setup's confirmBar. */
    decision: StatisticalDecision;
    /** The Phase 6 dataset — authoritative rows; the engine never re-measures. */
    outcomes: SetupOutcome[];
    config: StatsConfig;
  }): EngineResult<ProbabilityEstimate>;
}

/** 25 — Scanner: opportunity discovery & ranking over caller-produced PIT artifacts.
 *  Never receives candles; never detects, scores, estimates, or measures. */
export interface ScannerEngine {
  scan(input: {
    /** The point-in-time anchor — candidates are validated against this, not re-evaluated. */
    asOf: UnixMs;
    /** Declared scan extent — the caller owns universe population. */
    universe: ScanUniverse;
    /** Caller-produced PIT artifacts — input order is irrelevant by contract. */
    candidates: ScanCandidate[];
    /** Narrowing dims (the `ScanRequest` filter surface) — absent = unconstrained. */
    filters?: ScanFilters;
    config: ScannerConfig;
  }): EngineResult<ScanResult>;
}
