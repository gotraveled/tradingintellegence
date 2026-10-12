import type { AssetClass, MarketSegmentId, MarketSession, Timeframe } from "@/lib/types";

export interface MarketSegment {
  id: MarketSegmentId;
  label: string;
  description: string;
  /** Representative instruments (names only, no market data). */
  examples: string[];
  hours: string;
}

export const MARKET_SEGMENTS: MarketSegment[] = [
  {
    id: "crypto",
    label: "Crypto",
    description: "Major digital assets and USD-quoted pairs.",
    examples: ["BTC", "ETH", "SOL", "XRP"],
    hours: "24/7",
  },
  {
    id: "forex",
    label: "Forex",
    description: "Major, minor, and cross currency pairs.",
    examples: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD"],
    hours: "24/5",
  },
  {
    id: "commodities",
    label: "Commodities",
    description: "Precious metals, energy, and agricultural markets.",
    examples: ["Gold", "Silver", "WTI Crude", "Natural Gas"],
    hours: "Near 24/5",
  },
  {
    id: "indices",
    label: "Indices",
    description: "Global equity benchmarks.",
    examples: ["NASDAQ 100", "S&P 500", "DAX", "Nikkei 225"],
    hours: "Exchange hours",
  },
  {
    id: "us-stocks",
    label: "US Stocks",
    description: "Listed US equities across sectors.",
    examples: ["AAPL", "MSFT", "NVDA", "AMZN"],
    hours: "NYSE / NASDAQ hours",
  },
  {
    id: "indian-markets",
    label: "Indian Markets",
    description: "NSE / BSE equities and benchmark indices.",
    examples: ["NIFTY 50", "BANKNIFTY", "RELIANCE", "HDFCBANK"],
    hours: "NSE / BSE hours",
  },
];

export function getMarketSegment(id: string) {
  return MARKET_SEGMENTS.find((segment) => segment.id === id);
}

export const ASSET_CLASSES: { value: AssetClass; label: string }[] = [
  { value: "equities", label: "Equities" },
  { value: "indices", label: "Indices" },
  { value: "forex", label: "Forex" },
  { value: "commodities", label: "Commodities" },
  { value: "futures", label: "Futures" },
  { value: "crypto", label: "Crypto" },
];

export const TIMEFRAMES: { value: Timeframe; label: string }[] = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "1D", label: "1D" },
  { value: "1W", label: "1W" },
  { value: "1M", label: "1M" },
];

export const DEFAULT_TIMEFRAME: Timeframe = "4h";

export const MARKET_SESSIONS: MarketSession[] = [
  { id: "sydney", name: "Sydney", timezone: "Australia/Sydney", open: "07:00", close: "16:00" },
  { id: "tokyo", name: "Tokyo", timezone: "Asia/Tokyo", open: "09:00", close: "15:00" },
  { id: "london", name: "London", timezone: "Europe/London", open: "08:00", close: "16:30" },
  { id: "new-york", name: "New York", timezone: "America/New_York", open: "09:30", close: "16:00" },
];
