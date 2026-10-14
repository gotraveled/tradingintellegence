import type { Direction, ID, ISODateTime, Price, Score, Timeframe } from "./common";
import type { PriceTarget } from "./opportunity";
import type { ScoreContribution, SetupReason } from "./setup";

/**
 * Structured analytical plan for a confirmed/active setup (docs/engine/16).
 * Analysis only — never an order, never broker-bound, never a recommendation.
 */
export interface TradePlan {
  setupId: ID;
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
  /** Entry band with the evidence that produced it (zone/FVG/boundary). */
  entryZone: { low: Price; high: Price; basis: string };
  /** closeOnly is always true — wicks never invalidate. */
  invalidation: { price: Price; basis: string; closeOnly: true };
  targets: PriceTarget[];
  /** Reward-to-risk to the final target; absent until entry+targets exist. */
  riskReward?: number;
  score: Score;
  /** Mandatory explainability — a score without contributions is an engine error. */
  scoreContributions: ScoreContribution[];
  reasons: SetupReason[];
  /** Unmet conditions — the plan is honest about gaps. */
  conditionsPending?: SetupReason[];
  /** Bars after which the plan stales (setup.expiryBars). */
  expiryBars: number;
  /** `true` when the setup resolved terminally — the frozen plan outcome measurement scores (16). */
  final?: boolean;
  createdAt: ISODateTime;
  /** EngineParams version that produced it — comparability boundary. */
  paramsVersion: string;
}
