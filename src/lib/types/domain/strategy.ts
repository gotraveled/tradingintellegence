import type { ID, ISODateTime, Metadata, Score, Timeframe, Timestamps } from "./common";
import type { MarketSegmentId } from "./market";
import type { EvidenceCategory, SetupType } from "./setup";

/** A required or optional condition in a strategy definition. */
export interface StrategyRule {
  id: ID;
  category: EvidenceCategory;
  label: string;
  required: boolean;
}

export interface Strategy extends Timestamps {
  id: ID;
  name: string;
  description: string;
  setupType?: SetupType;
  rules: StrategyRule[];
  version?: number;
  metadata?: Metadata;
}

/** Parameters for a backtest run. Maps onto the future backtesting API request body. */
export interface BacktestRequest {
  strategyId: ID;
  market?: MarketSegmentId;
  symbols?: string[];
  timeframe: Timeframe;
  period: { from: ISODateTime; to: ISODateTime };
  setupType?: SetupType;
  minScore: Score;
  /** Risk per trade as a percentage of equity, e.g. 1 = 1%. */
  riskPerTradePct: number;
}
