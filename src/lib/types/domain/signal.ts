import type { Bias, ID, ISODateTime, Metadata, Price, Timeframe } from "./common";

/**
 * A Signal is an atomic, detected market event. Signals are evidence; they are not trade
 * instructions. Setups are assembled from multiple signals.
 */
export type SignalType =
  | "bos"
  | "choch"
  | "liquidity_sweep"
  | "zone_tap"
  | "fvg_formed"
  | "fvg_filled"
  | "displacement"
  | "compression"
  | "momentum_shift";

export interface Signal {
  id: ID;
  symbol: string;
  timeframe: Timeframe;
  type: SignalType;
  direction: Bias;
  price?: Price;
  occurredAt: ISODateTime;
  /** Related domain record, e.g. the zone that was tapped. */
  sourceId?: ID;
  metadata?: Metadata;
}
