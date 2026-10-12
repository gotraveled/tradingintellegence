import type { Direction, ID, Metadata, Score, Timeframe, Timestamps } from "./common";

export type SetupType = "reversal" | "breakout" | "continuation";

/**
 * Universal setup lifecycle (docs/engine/11). A state machine, not scattered booleans:
 * developing → confirmed → active → partial_target → target_reached,
 * or → invalidated (close through invalidation) / expired (stale) / cancelled (premise disproved).
 * Terminal states are immutable.
 */
export type SetupStatus =
  | "developing"
  | "confirmed"
  | "active"
  | "partial_target"
  | "target_reached"
  | "invalidated"
  | "expired"
  | "cancelled";

/** Per-dimension explainable contribution to the 0–100 score (docs/engine/15). */
export interface ScoreContribution {
  dimension:
    | "structure"
    | "liquidity"
    | "zoneQuality"
    | "displacement"
    | "momentum"
    | "htfAlignment"
    | "freshness"
    | "fvg";
  /** Max points for this dimension after regime modulation. */
  weight: number;
  /** Normalized feature value fᵢ in [0,1]. */
  feature: number;
  /** weight × feature — summed to produce the score. */
  points: number;
  /** Human-readable label of what the evidence is. */
  label: string;
  /** Engine entities that produced this contribution. */
  signalIds?: ID[];
}

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
  /** Per-dimension breakdown — mandatory: a score without contributions is an engine error. */
  scoreContributions?: ScoreContribution[];
  status: SetupStatus;
  reasons: SetupReason[];
  zoneIds?: ID[];
  liquidityEventIds?: ID[];
  /** Higher timeframe used for context, if any. */
  contextTimeframe?: Timeframe;
  metadata?: Metadata;
}
