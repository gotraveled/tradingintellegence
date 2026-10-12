import type { Direction, ID, Metadata, Score, Timeframe, Timestamps } from "./common";

export type SetupType = "reversal" | "breakout" | "continuation";

/**
 * Lifecycle of a setup.
 * developing → confirmed → completed, or → invalidated / expired at any point.
 */
export type SetupStatus = "developing" | "confirmed" | "invalidated" | "completed" | "expired";

export type EvidenceCategory =
  | "market_structure"
  | "supply_demand"
  | "liquidity"
  | "imbalance"
  | "multi_timeframe"
  | "momentum"
  | "historical_validation";

/** One condition that contributes to (or is still missing from) a setup. */
export interface SetupReason {
  id: ID;
  category: EvidenceCategory;
  label: string;
  /** Whether the condition is currently satisfied. */
  met: boolean;
  timeframe?: Timeframe;
  /** Relative contribution to the score, 0–1. */
  weight?: number;
  /** Signals that satisfy this condition. */
  signalIds?: ID[];
}

export interface Setup extends Timestamps {
  id: ID;
  symbol: string;
  timeframe: Timeframe;
  type: SetupType;
  direction: Direction;
  /** Quality score, 0–100. Describes evidence quality, not probability of profit. */
  score: Score;
  status: SetupStatus;
  reasons: SetupReason[];
  zoneIds?: ID[];
  liquidityEventIds?: ID[];
  /** Higher timeframe used for context, if any. */
  contextTimeframe?: Timeframe;
  metadata?: Metadata;
}
