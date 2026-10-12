import type { Bias, ISODateTime, Timeframe } from "./common";
import type { LiquidityEvent } from "./liquidity";
import type { Opportunity } from "./opportunity";
import type { Setup } from "./setup";
import type { MarketStructure } from "./structure";
import type { Zone } from "./zone";

export type MomentumState = "strengthening" | "weakening" | "neutral" | "diverging";

export interface Momentum {
  state: MomentumState;
  bias: Bias;
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
