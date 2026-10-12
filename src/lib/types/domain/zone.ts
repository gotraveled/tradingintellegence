import type { Direction, ID, ISODateTime, Metadata, Price, Score, Timeframe } from "./common";

export type ZoneType = "demand" | "supply";

/** fresh = never retested, tested = retested at least once, mitigated = largely consumed. */
export type ZoneFreshness = "fresh" | "tested" | "mitigated";

export type ZoneStatus = "active" | "mitigated" | "invalidated";

export interface Zone {
  id: ID;
  symbol: string;
  timeframe: Timeframe;
  type: ZoneType;
  upperPrice: Price;
  lowerPrice: Price;
  /** Engine-assessed zone quality, 0–100. */
  strength: Score;
  freshness: ZoneFreshness;
  retestCount: number;
  status: ZoneStatus;
  /** Time of the candle where the zone originated. */
  originAt: ISODateTime;
  createdAt: ISODateTime;
  metadata?: Metadata;
}

export type ImbalanceStatus = "open" | "partially_filled" | "filled";

/** Fair value gap / price inefficiency. */
export interface Imbalance {
  id: ID;
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
  upperPrice: Price;
  lowerPrice: Price;
  status: ImbalanceStatus;
  createdAt: ISODateTime;
}
