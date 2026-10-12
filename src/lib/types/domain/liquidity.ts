import type { ID, ISODateTime, Metadata, Price, Timeframe } from "./common";

/** Buy-side liquidity rests above highs; sell-side liquidity rests below lows. */
export type LiquiditySide = "buy_side" | "sell_side";

export type LiquidityEventType =
  | "equal_highs"
  | "equal_lows"
  | "swing_high"
  | "swing_low"
  | "session_high"
  | "session_low"
  | "sweep";

export type LiquidityStatus = "resting" | "approaching" | "swept";

export interface LiquidityEvent {
  id: ID;
  symbol: string;
  timeframe: Timeframe;
  type: LiquidityEventType;
  side: LiquiditySide;
  price: Price;
  status: LiquidityStatus;
  /** When the pool formed or, for sweeps, when the sweep occurred. */
  occurredAt: ISODateTime;
  sweptAt?: ISODateTime;
  metadata?: Metadata;
}
