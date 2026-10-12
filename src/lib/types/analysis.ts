import type { AssetClass, Timeframe } from "./market";
import type { Tone } from "./status";

/**
 * Contracts for the future analysis engine.
 * The UI consumes these shapes only; detection logic lives in a separate service.
 */

export type EvidenceCategory =
  | "market_structure"
  | "supply_demand"
  | "liquidity"
  | "imbalance"
  | "multi_timeframe"
  | "momentum"
  | "historical_validation";

export type SetupType = "reversal" | "breakout" | "continuation";

export type Bias = "bullish" | "bearish" | "neutral";

export type SetupStage = "developing" | "qualified" | "invalidated" | "expired";

export interface Evidence {
  id: string;
  category: EvidenceCategory;
  label: string;
  description: string;
  timeframe: Timeframe;
  tone: Tone;
  /** Relative contribution to the opportunity score, 0–1. */
  weight: number;
}

export interface HistoricalValidation {
  sampleSize: number;
  /** Observed frequency of the setup reaching its first objective, 0–1. */
  hitRate: number;
  averageReward: number;
  averageRisk: number;
  period: { from: string; to: string };
}

export interface Opportunity {
  id: string;
  symbol: string;
  setupType: SetupType;
  bias: Bias;
  stage: SetupStage;
  timeframe: Timeframe;
  /** Confluence score, 0–100. Describes evidence quality, not probability of profit. */
  score: number;
  evidence: Evidence[];
  validation?: HistoricalValidation;
  invalidationLevel?: number;
  explanation?: string;
  detectedAt: string;
}

export type MarketRegime = "trending" | "ranging" | "compressing" | "expanding";

export interface MarketRegimeSnapshot {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  direction: Bias;
  regime: MarketRegime;
  /** Regime strength, 0–100. */
  strength: number;
  timeframe: Timeframe;
}

export interface TradePlan {
  entry: number;
  invalidation: number;
  target: number;
  /** Reward-to-risk multiple, e.g. 2.5 means 2.5R. */
  riskReward: number;
}

/** Compact opportunity shape used by cards and lists. */
export interface OpportunitySummary {
  id: string;
  symbol: string;
  assetClass: AssetClass;
  setupType: SetupType;
  bias: Bias;
  stage: SetupStage;
  timeframe: Timeframe;
  /** Quality score, 0–100. Describes evidence quality, not probability of profit. */
  score: number;
  pricePrecision: number;
  plan: TradePlan;
}

export interface SetupCondition {
  label: string;
  met: boolean;
}

export interface DevelopingSetup {
  id: string;
  symbol: string;
  assetClass: AssetClass;
  setupType: SetupType;
  bias: Bias;
  timeframe: Timeframe;
  score: number;
  conditions: SetupCondition[];
}
