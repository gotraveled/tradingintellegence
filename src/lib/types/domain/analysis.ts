import type { Bias, ISODateTime, Score, Timeframe } from "./common";
import type { LiquidityEvent } from "./liquidity";
import type { Opportunity } from "./opportunity";
import type { Setup } from "./setup";
import type { MarketStructure } from "./structure";
import type { Zone } from "./zone";

export type MomentumState = "strengthening" | "weakening" | "neutral" | "diverging";

/**
 * Momentum feature set (docs/engine/09). Small, ATR-normalised, closed-bars-only.
 * Optional secondary features (e.g. RSI) exist for display/ML — no rule may depend on them.
 */
export interface MomentumFeatures {
  /** Signed Σ(close−open) over lookback ÷ ATR — net initiative in ATR units. */
  directionalMove?: number;
  /** (close[t] − close[t−n]) ÷ ATR — ATR-normalised rate of change. */
  rateOfChange?: number;
  /** ATR(14) now ÷ ATR(14) 20 bars ago — expansion/compression. */
  atrTrend?: number;
  /** Mean |close−open| ÷ ATR over lookback. */
  bodyStrength?: number;
  /** Current run of same-direction closes, signed. */
  consecDirection?: number;
  /** 5-bar mean volume ÷ 20-bar mean — absent where volume is unreliable. */
  volumeRatio?: number;
  /** Secondary only — display/ML, never decision input. */
  rsi14?: number;
}

export interface Momentum {
  state: MomentumState;
  bias: Bias;
  /** 0–100 conviction score for the last measured leg (docs/engine/09 Part A). */
  displacementScore?: Score;
  features?: MomentumFeatures;
}

/** Per-timeframe directional vote: +1 bullish, −1 bearish, 0 neutral/transition. */
export type MtfVote = -1 | 0 | 1;

/**
 * Named confluence/conflict states (docs/engine/10 truth table).
 * `realigning_*` and `countertrend_*` are watch states — never a directional bias.
 */
export type MtfAlignmentState =
  | "aligned_bull"
  | "aligned_bear"
  | "pullback_in_trend_bull"
  | "pullback_in_trend_bear"
  | "realigning_bull"
  | "realigning_bear"
  | "countertrend_bull"
  | "countertrend_bear"
  | "htf_dominant"
  | "ltf_directed"
  | "no_context"
  | "neutral";

/** Multi-timeframe combination output (docs/engine/10). Recomputed, never persisted as truth. */
export interface MultiTimeframeAlignment {
  symbol: string;
  /** The timeframe set, e.g. { htf: "4h", itf: "1h", etf: "15m" }. */
  timeframes: { htf: Timeframe; itf: Timeframe; etf: Timeframe };
  votes: { htf: MtfVote; itf: MtfVote; etf: MtfVote };
  /** 0.5·htf + 0.3·itf + 0.2·etf, in [−1, 1]. */
  alignmentScore: number;
  state: MtfAlignmentState;
  computedAt: ISODateTime;
}

/** A section of analysis with a human-readable summary and its structured data. */
export interface AnalysisSection<T> {
  summary: string;
  data: T;
}

/**
 * Snapshot of the engine's analysis for one symbol/timeframe.
 * Consumed by the Chart Intelligence panel.
 */
export interface AnalysisSnapshot {
  symbol: string;
  timeframe: Timeframe;
  generatedAt: ISODateTime;
  structure: AnalysisSection<MarketStructure>;
  liquidity: AnalysisSection<LiquidityEvent[]>;
  zones: AnalysisSection<Zone[]>;
  momentum: AnalysisSection<Momentum>;
  setup?: Setup;
  opportunity?: Opportunity;
}
