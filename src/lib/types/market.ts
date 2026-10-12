export type AssetClass = "equities" | "indices" | "forex" | "crypto" | "commodities" | "futures";

export type MarketSegmentId =
  "crypto" | "forex" | "commodities" | "indices" | "us-stocks" | "indian-markets";

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1D" | "1W" | "1M";

export interface Instrument {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  exchange?: string;
  currency: string;
  pricePrecision: number;
}

export interface Candle {
  /** Unix epoch milliseconds (bar open time). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface Quote {
  symbol: string;
  last: number;
  change: number;
  changePercent: number;
  /** Unix epoch milliseconds. */
  updatedAt: number;
}

export interface MarketSession {
  id: string;
  name: string;
  timezone: string;
  /** Local session open/close in HH:mm (24h) within `timezone`. */
  open: string;
  close: string;
}
