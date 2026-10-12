import type { Direction, ID, Metadata, Price, Score, Timeframe, Timestamps } from "./common";
import type { AssetClass, MarketSegmentId } from "./market";
import type { ScoreContribution, SetupReason, SetupStatus, SetupType } from "./setup";

/** An Opportunity shares the setup lifecycle (docs/engine/11). */
export type OpportunityStatus = SetupStatus;

/** How certain the engine is in its detection. Not a probability of profit. */
export type ConfidenceLevel = "low" | "medium" | "high";

export interface PriceTarget {
  label: string;
  price: Price;
  reached?: boolean;
}

/**
 * An actionable view of a Setup, enriched with a trade plan.
 * Fields the intelligence engine has not produced yet are optional.
 */
export interface Opportunity extends Timestamps {
  id: ID;
  setupId?: ID;
  assetId?: ID;
  symbol: string;
  assetClass: AssetClass;
  market?: MarketSegmentId;
  setupType: SetupType;
  direction: Direction;
  /** Quality score, 0–100. Describes evidence quality, not probability of profit. */
  score: Score;
  /** Per-dimension breakdown (docs/engine/15) — the score is always explainable. */
  scoreContributions?: ScoreContribution[];
  timeframe: Timeframe;
  status: OpportunityStatus;
  entry?: Price;
  stopLoss?: Price;
  targets?: PriceTarget[];
  /** Reward-to-risk multiple to the final target, e.g. 2.5 means 2.5R. */
  riskReward?: number;
  confidence?: ConfidenceLevel;
  reasons?: SetupReason[];
  /** Plain-language explanation from the AI layer. */
  explanation?: string;
  /** Display precision denormalised from the asset. */
  pricePrecision?: number;
  metadata?: Metadata;
}
