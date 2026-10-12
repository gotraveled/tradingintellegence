/**
 * Engine configuration objects (docs/engine/21-configuration.md).
 * Every threshold in the spec lives here as a named, typed, versioned parameter — magic numbers
 * are never allowed inside engine logic. `EngineParams.values` keys map to these fields.
 */

/** Swing detection (02). Thresholds are ATR multiples, never raw price or %. */
export interface SwingConfig {
  leftBars: number;
  rightBars: number;
  atrLength: number;
  minSignificanceAtr: number;
  equalToleranceAtr: number;
  mergeEqual: boolean;
}

/** Market structure (03). */
export interface StructureConfig {
  classifyToleranceAtr: number;
  minBreakAtr: number;
  failedBreakBars: number;
  minSwingsForTrend: number;
}

/** Liquidity pools + sweeps + break family (04). */
export interface LiquidityConfig {
  equalToleranceAtr: number;
  clusterMinCount: number;
  clusterWidthAtr: number;
  poolExpiryBars: number;
  sweep: {
    minPenetrationAtr: number;
    maxReclaimBars: number;
    displacementBars: number;
    displacementBodyAtr: number;
    displacementRangeAtr: number;
  };
  break: {
    minCloseAtr: number;
    holdBars: number;
    retestWindow: number;
  };
  /** Active-range pool band window (spec 04 pool table: `range.lookbackBars`). */
  range: { lookbackBars: number };
}

/** Demand/supply zones (05–07). `sideOverrides` has no defaults — evidence may set it. */
export interface ZoneConfig {
  /** Leg-in preceding the base (spec 05: `lookbackLeg`, `legMinAtr`). */
  leg: { lookbackBars: number; minMoveAtr: number };
  base: { minBars: number; maxBars: number; maxRangeAtr: number; maxBodyAtr: number };
  departure: {
    minMoveAtr: number;
    maxBars: number;
    displacementBodyAtr: number;
    displacementRangeAtr: number;
  };
  retest: {
    depthMitigatedPct: number;
    invalidateCloseAtr: number;
    maxRetests: number;
    /** remainingStrength decay per completed retest (spec 07). */
    retestDecay: number;
    /** remainingStrength decay vs penetration depth (spec 07). */
    depthDecay: number;
  };
  freshnessMaxBars: number;
  boundaryMode: "extremes" | "bodies";
  /** Sessioned-market rule: open beyond distal edge invalidates without a close (06). */
  gapInvalidates: boolean;
  /** Per-side parameter overrides — empty by default (06). */
  sideOverrides?: { demand?: Record<string, number>; supply?: Record<string, number> };
  /** Strength-score weights — must sum to 1.0 (05). */
  weights: Record<
    | "departureStrength"
    | "structureBreak"
    | "liquidityInteraction"
    | "freshness"
    | "fvgAssociation"
    | "htfConfluence"
    | "volumeExpansion"
    | "zoneWidth",
    number
  >;
}

/** FVG / imbalance (08). */
export interface FVGConfig {
  minGapAtr: number;
  minMidBodyAtr: number;
  partialFillPct: number;
  invalidateAtr: number;
  expiryBars: number;
  /** Bars in the ATR window ending at the middle candle — spec 08's `ATR[i+1]`. */
  atrLength: number;
}

/** Displacement + momentum features (09). */
export interface MomentumConfig {
  lookback: number;
  atrLength: number;
  /** Bars back for the atrTrend baseline (spec 09: "ATR(14) 20 bars ago"). */
  trendShift: number;
  /** Volume mean windows for volumeRatio (spec 09: 5-bar ÷ 20-bar). */
  vol: { fast: number; slow: number };
  /** Derived-state thresholds (spec 09 Part B). */
  state: {
    /** |directionalMove| ≥ this for `strengthening`. */
    strengthMoveAtr: number;
    /** bodyStrength ≥ this for `strengthening`. */
    strengthBodyAtr: number;
    /** weakening when |directionalMove| < this × its lookback mean. */
    weakenFactor: number;
    /** bias threshold on directionalMove, signed. */
    biasMoveAtr: number;
  };
  disp: {
    bars: number;
    threshold: number;
    weights: Record<"body" | "range" | "close" | "dir" | "move" | "vol" | "struct", number>;
  };
}

/** Multi-timeframe combination (10). */
export interface MTFConfig {
  set: { htf: string; itf: string; etf: string };
  weights: { htf: number; itf: number; etf: number };
}

/** Setup lifecycle (11). */
export interface LifecycleConfig {
  expiryBars: number;
  invalidateAtr: number;
}

/** Reversal setup (12). */
export interface ReversalConfig {
  zoneMaxAgeBars: number;
  zoneMinStrength: number;
  sweepMaxAgeBars: number;
  dispMinScore: number;
  entryZoneDepth: number;
  invalidateAtr: number;
}

/** Breakout setup (13). */
export interface BreakoutConfig {
  rangeMinBars: number;
  rangeMaxWidthAtr: number;
  compressionRatio: number;
  compressionBars: number;
  breakAtr: number;
  dispMinScore: number;
  /** Spec 13: "breakout bar or the next dispBars bars" — displacement detection window.
   *  Distinct from `holdBars` (acceptance) and `momentum.disp.bars` (leg scoring window). */
  dispBars: number;
  holdBars: number;
  retestWindow: number;
  volumeMinRatio: number;
  /** Boundary-pool anchor matching tolerance in ATR — spec ties the boundary to a
   *  `range_high`/`range_low` pool (04) but defines no match tolerance. */
  anchorNearAtr: number;
}

/** Continuation setup (14). */
export interface ContinuationConfig {
  minTrendSwings: number;
  impulseMinAtr: number;
  /** Spec 14: impulse leg "formed within `impulseMaxBars` (default 15) bars" — required by the
   *  spec but absent from the contract; added as the smallest additive typed change. */
  impulseMaxBars: number;
  pullbackMinPct: number;
  pullbackMaxPct: number;
  pullbackMinBars: number;
  recoveryBodyAtr: number;
  confirmCloseAtr: number;
}

/** Opportunity score (15). */
export interface ScoringConfig {
  minRR: number;
  weights: Record<
    | "structure"
    | "liquidity"
    | "zoneQuality"
    | "displacement"
    | "momentum"
    | "htfAlignment"
    | "freshness"
    | "fvg",
    number
  >;
  /** Per-regime, per-setup-type weight multipliers (15 §3). */
  regimeMatrix: Record<string, Record<string, Record<string, number>>>;
}

/** Market regime (19). */
export interface RegimeConfig {
  expandAtrTrend: number;
  compressAtrTrend: number;
  atrLength: number;
  atrLookback: number;
  minBars: number;
}

/** Statistical validation (24). */
export interface StatsConfig {
  /** Eligibility floor per cohort level — below it the estimate is insufficient_data. */
  minSamples: number;
  /** Ascending score-band edges within [0,100] — cohort axis boundaries (24). */
  scoreBands: number[];
  /** Methodology stamp: estimator + eligibility + cohort axes + ladder order. */
  methodVersion: string;
}

/** Opportunity scanner (25). */
export interface ScannerConfig {
  /** Ranked-output bound — 0 = unbounded, still fully ranked (25). */
  topK: number;
  /** Surface developing setups in the unranked bucket (25). */
  includeDeveloping: boolean;
  /** Methodology stamp: provenance rules + eligibility + dedup + tie-breaks. */
  methodVersion: string;
}

/** The complete engine parameter set — one object, versioned, reproducible. */
export interface EngineConfig {
  version: string;
  marketData: { maxMissingBarPct: number };
  swing: SwingConfig;
  structure: StructureConfig;
  liquidity: LiquidityConfig;
  stats?: StatsConfig;
  scanner?: ScannerConfig;
  zone: ZoneConfig;
  fvg: FVGConfig;
  momentum: MomentumConfig;
  mtf: MTFConfig;
  lifecycle: LifecycleConfig;
  reversal: ReversalConfig;
  breakout: BreakoutConfig;
  continuation: ContinuationConfig;
  scoring: ScoringConfig;
  regime: RegimeConfig;
}
