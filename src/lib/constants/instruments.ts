import type { Asset, MarketSegmentId } from "@/lib/types";

/**
 * Static instrument catalog used by selectors until a market-data provider supplies the
 * universe. Contains reference metadata only — no prices or market data.
 */
export const FEATURED_INSTRUMENTS: Asset[] = [
  {
    id: "btcusdt",
    symbol: "BTCUSDT",
    name: "Bitcoin / Tether",
    assetClass: "crypto",
    marketId: "crypto",
    quoteCurrency: "USDT",
    pricePrecision: 0,
  },
  {
    id: "ethusdt",
    symbol: "ETHUSDT",
    name: "Ethereum / Tether",
    assetClass: "crypto",
    marketId: "crypto",
    quoteCurrency: "USDT",
    pricePrecision: 2,
  },
  {
    id: "xauusd",
    symbol: "XAUUSD",
    name: "Gold Spot",
    assetClass: "commodities",
    marketId: "commodities",
    quoteCurrency: "USD",
    pricePrecision: 2,
  },
  {
    id: "eurusd",
    symbol: "EURUSD",
    name: "Euro / US Dollar",
    assetClass: "forex",
    marketId: "forex",
    quoteCurrency: "USD",
    pricePrecision: 5,
  },
  {
    id: "gbpusd",
    symbol: "GBPUSD",
    name: "British Pound / US Dollar",
    assetClass: "forex",
    marketId: "forex",
    quoteCurrency: "USD",
    pricePrecision: 5,
  },
  {
    id: "nas100",
    symbol: "NAS100",
    name: "NASDAQ 100",
    assetClass: "indices",
    marketId: "indices",
    quoteCurrency: "USD",
    pricePrecision: 1,
  },
  {
    id: "aapl",
    symbol: "AAPL",
    name: "Apple Inc.",
    assetClass: "equities",
    marketId: "us-stocks",
    exchange: "NASDAQ",
    quoteCurrency: "USD",
    pricePrecision: 2,
  },
  {
    id: "nifty50",
    symbol: "NIFTY 50",
    name: "Nifty 50 Index",
    assetClass: "indices",
    marketId: "indian-markets",
    exchange: "NSE",
    quoteCurrency: "INR",
    pricePrecision: 1,
  },
];

export function getInstrument(symbol: string) {
  return FEATURED_INSTRUMENTS.find((asset) => asset.symbol === symbol);
}

/** Catalog instruments for a market segment — identity only, no market data. */
export function instrumentsBySegment(marketId: MarketSegmentId): Asset[] {
  return FEATURED_INSTRUMENTS.filter((asset) => asset.marketId === marketId);
}
