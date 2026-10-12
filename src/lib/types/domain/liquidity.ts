import type { ID, ISODateTime, Metadata, Price, Score, Timeframe } from "./common";

/** Buy-side liquidity rests above highs; sell-side liquidity rests below lows. */
export type LiquiditySide = "buy_side" | "sell_side";

/** Sources a pool can form from (docs/engine/04-liquidity.md). */
export type LiquidityPoolType =
  | "equal_highs"
  | "equal_lows"
  | "swing_high"
  | "swing_low"
  | "prev_day_high"
  | "prev_day_low"
  | "prev_week_high"
  | "prev_week_low"
  | "range_high"
  | "range_low"
  | "cluster_high"
  | "cluster_low";

/**
 * A price band where resting stops/orders concentrate (docs/engine/04-liquidity.md).
 * Pools formed from several sources at one level merge into a single pool with `sources`.
 */
export type LiquidityPoolStatus = "resting" | "approaching" | "swept" | "broken" | "expired";

export interface LiquidityPool {
  id: ID;
  symbol: string;
  timeframe: Timeframe;
  side: LiquiditySide;
  /** All pool types detected at this level — never double-counted. */
  sources: LiquidityPoolType[];
  /** Representative level (extreme for singles, band mid for clusters/ranges). */
  price: Price;
  /** Band bounds for cluster/range pools. */
  lowerPrice?: Price;
  upperPrice?: Price;
  /** Swings/approaches that formed the pool. */
  touches: number;
  /** 0–100: touches, source count, recency, tightness. */
  strength: Score;
  status: LiquidityPoolStatus;
  formedAt: ISODateTime;
  lastTouchedAt: ISODateTime;
  sweptAt?: ISODateTime;
  expiredAt?: ISODateTime;
  metadata?: Metadata;
}

export type LiquidityEventType =
  | "equal_highs"
  | "equal_lows"
  | "swing_high"
  | "swing_low"
  | "session_high"
  | "session_low"
  | "sweep"
  | "break_attempt"
  | "breakout_success"
  | "false_breakout";

export type LiquidityStatus = "resting" | "approaching" | "swept";

export interface LiquidityEvent {
  id: ID;
  symbol: string;
  timeframe: Timeframe;
  type: LiquidityEventType;
  side: LiquiditySide;
  price: Price;
  status: LiquidityStatus;
  /** When the pool formed or, for sweeps/breaks, when the interaction occurred. */
  occurredAt: ISODateTime;
  sweptAt?: ISODateTime;
  /** Pool this interaction targeted (sweeps/breaks). */
  poolId?: ID;
  metadata?: Metadata;
}
