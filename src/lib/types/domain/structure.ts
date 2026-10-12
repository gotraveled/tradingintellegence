import type { Bias, Direction, ISODateTime, Price, Score, Timeframe } from "./common";
import type { AssetClass } from "./market";

/** HH = higher high, HL = higher low, LH = lower high, LL = lower low. */
export type SwingType = "HH" | "HL" | "LH" | "LL";

export interface SwingPoint {
  type: SwingType;
  price: Price;
  time: ISODateTime;
}

/** BOS = break of structure (continuation), CHOCH = change of character (potential reversal). */
export type StructureBreakType = "BOS" | "CHOCH";

export interface StructureBreak {
  type: StructureBreakType;
  direction: Direction;
  price: Price;
  time: ISODateTime;
  /** Whether the break was confirmed by a candle close beyond the level. */
  confirmed: boolean;
}

export type TrendState = "uptrend" | "downtrend" | "range" | "transition";

export interface MarketStructure {
  symbol: string;
  timeframe: Timeframe;
  trend: TrendState;
  bias: Bias;
  swings: SwingPoint[];
  lastBreak?: StructureBreak;
  /** Key levels derived from structure (e.g. last protected high/low). */
  keyLevels?: { label: string; price: Price }[];
  updatedAt: ISODateTime;
}

export type MarketRegime = "trending" | "ranging" | "compressing" | "expanding";

export interface MarketRegimeSnapshot {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  direction: Bias;
  regime: MarketRegime;
  /** Regime strength, 0–100. */
  strength: Score;
  timeframe: Timeframe;
}
