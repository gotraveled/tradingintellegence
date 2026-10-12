import type { ID, ISODateTime, Price, Timeframe, UnixMs } from "./common";

export type AssetClass = "equities" | "indices" | "forex" | "crypto" | "commodities" | "futures";

export type MarketSegmentId =
  "crypto" | "forex" | "commodities" | "indices" | "us-stocks" | "indian-markets";

export interface MarketSession {
  id: string;
  name: string;
  /** IANA timezone, e.g. "America/New_York". */
  timezone: string;
  /** Local session open/close in HH:mm (24h) within `timezone`. */
  open: string;
  close: string;
}

/** A venue or grouping of tradable assets (e.g. NSE, US equities, spot crypto). */
export interface Market {
  id: ID;
  segment: MarketSegmentId;
  name: string;
  timezone: string;
  sessions: MarketSession[];
  /** True for markets that trade continuously (e.g. crypto). */
  is24x7?: boolean;
}

/** A tradable instrument. */
export interface Asset {
  id: ID;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  marketId: ID;
  exchange?: string;
  baseCurrency?: string;
  quoteCurrency: string;
  /** Decimal places used when displaying prices. */
  pricePrecision: number;
  tickSize?: number;
  isActive?: boolean;
}

export interface Candle {
  /** Bar open time. */
  time: UnixMs;
  open: Price;
  high: Price;
  low: Price;
  close: Price;
  volume?: number;
}

export interface CandleSeries {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
}

export interface Quote {
  symbol: string;
  last: Price;
  change: number;
  changePercent: number;
  updatedAt: ISODateTime;
}
