/**
 * DEMO DATA — NOT REAL MARKET DATA. See ./index.ts.
 */
import type { MarketRegimeSnapshot } from "@/lib/types";

export const DEMO_MARKET_REGIMES: MarketRegimeSnapshot[] = [
  {
    symbol: "BTC",
    name: "Bitcoin",
    assetClass: "crypto",
    direction: "bullish",
    regime: "trending",
    strength: 72,
    timeframe: "1D",
  },
  {
    symbol: "ETH",
    name: "Ethereum",
    assetClass: "crypto",
    direction: "neutral",
    regime: "ranging",
    strength: 41,
    timeframe: "1D",
  },
  {
    symbol: "XAUUSD",
    name: "Gold",
    assetClass: "commodities",
    direction: "bullish",
    regime: "expanding",
    strength: 66,
    timeframe: "4h",
  },
  {
    symbol: "NAS100",
    name: "NASDAQ 100",
    assetClass: "indices",
    direction: "neutral",
    regime: "compressing",
    strength: 38,
    timeframe: "4h",
  },
  {
    symbol: "EURUSD",
    name: "Euro / US Dollar",
    assetClass: "forex",
    direction: "bearish",
    regime: "trending",
    strength: 58,
    timeframe: "1D",
  },
];
