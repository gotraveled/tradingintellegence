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

/**
 * Hard vetoes that suppress scoring entirely (docs/engine/15 §4) — a veto is not a score of 0.
 * `unconfirmed`/`terminal` cover lifecycle state (spec 16: a plan — and its score — exists only
 * while the setup is confirmed/active/partial_target); the rest are spec-named evidence gates.
 */
export type ScoreGate =
  | "unconfirmed"
  | "terminal"
  | "insufficient_data"
  | "countertrend"
  | "zone_dead"
  | "rr_below_min";

/** Result of opportunity scoring (spec 15): either a scored breakdown or an authoritative gate. */
export interface OpportunityScoreResult {
  /** Present only when the setup was scored — gated results carry `gate` instead. */
  score?: number;
  /** Per-dimension explainable breakdown — mandatory when `score` is present. */
  contributions?: ScoreContribution[];
  gate?: ScoreGate;
  /** The lifecycle state a veto emits instead of a score (spec 15: "developing/cancelled"). */
  emittedStatus?: SetupStatus;
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
