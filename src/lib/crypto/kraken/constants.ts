import type { Timeframe } from "@/lib/types";

/**
 * Kraken Spot public market-data constants.
 *
 * Public REST base `api.kraken.com/0/public` and WebSocket v2 `ws.kraken.com/v2`
 * serve market data without credentials. Symbol allowlist uses USD-quoted spot
 * pairs (Kraken lists no BNB/USD market, so BNB is Binance-only). Public-
 * display redistribution terms remain unresolved — see the feature's
 * disclosure copy; the feed is labelled venue-specific and never consolidated.
 */

export const KRAKEN_REST_BASE = "https://api.kraken.com";
export const KRAKEN_WS_URL = "wss://ws.kraken.com/v2";

export const VENUE_LABEL = "Kraken Spot";

/**
 * Strict symbol allowlist. `symbol` is the canonical key the UI state carries;
 * `restPair` is the `pair=` argument for REST, `wsSymbol` the v2 channel name.
 * `restKeys` lists the result keys Kraken may return for the pair — REST
 * responds with legacy altnames (e.g. `XXBTZUSD` for `XBTUSD`), which differ
 * per asset and are matched explicitly rather than guessed.
 */
export const KRAKEN_SYMBOLS = [
  {
    symbol: "XBTUSD",
    wsSymbol: "BTC/USD",
    restKeys: ["XBTUSD", "XXBTZUSD"],
    label: "BTC / USD",
    name: "Bitcoin",
    pricePrecision: 1,
  },
  {
    symbol: "ETHUSD",
    wsSymbol: "ETH/USD",
    restKeys: ["ETHUSD", "XETHZUSD"],
    label: "ETH / USD",
    name: "Ethereum",
    pricePrecision: 2,
  },
  {
    symbol: "SOLUSD",
    wsSymbol: "SOL/USD",
    restKeys: ["SOLUSD"],
    label: "SOL / USD",
    name: "Solana",
    pricePrecision: 3,
  },
  {
    symbol: "XRPUSD",
    wsSymbol: "XRP/USD",
    restKeys: ["XRPUSD", "XXRPZUSD"],
    label: "XRP / USD",
    name: "XRP",
    pricePrecision: 4,
  },
  {
    symbol: "ADAUSD",
    wsSymbol: "ADA/USD",
    restKeys: ["ADAUSD"],
    label: "ADA / USD",
    name: "Cardano",
    pricePrecision: 4,
  },
  {
    symbol: "DOGEUSD",
    wsSymbol: "DOGE/USD",
    restKeys: ["DOGEUSD", "XDGUSD", "XXDGZUSD"],
    label: "DOGE / USD",
    name: "Dogecoin",
    pricePrecision: 5,
  },
] as const;

export type KrakenSymbol = (typeof KRAKEN_SYMBOLS)[number]["symbol"];

const KRAKEN_SYMBOL_SET: ReadonlySet<string> = new Set(KRAKEN_SYMBOLS.map((s) => s.symbol));

export function krakenSymbolInfo(symbol: string) {
  return KRAKEN_SYMBOLS.find((s) => s.symbol === symbol);
}

export function isKrakenSymbol(symbol: string): symbol is KrakenSymbol {
  return KRAKEN_SYMBOL_SET.has(symbol);
}

/**
 * Canonical timeframe → Kraken interval minutes. Same UI subset as Binance;
 * all are documented Kraken OHLC intervals (1, 5, 15, 30, 60, 240, 1440 min).
 */
export const KRAKEN_INTERVALS: { timeframe: Timeframe; minutes: number; label: string }[] = [
  { timeframe: "1m", minutes: 1, label: "1m" },
  { timeframe: "5m", minutes: 5, label: "5m" },
  { timeframe: "15m", minutes: 15, label: "15m" },
  { timeframe: "30m", minutes: 30, label: "30m" },
  { timeframe: "1h", minutes: 60, label: "1H" },
  { timeframe: "4h", minutes: 240, label: "4H" },
  { timeframe: "1D", minutes: 1440, label: "1D" },
];

const INTERVAL_MAP: ReadonlyMap<Timeframe, number> = new Map(
  KRAKEN_INTERVALS.map((i) => [i.timeframe, i.minutes]),
);

export function krakenIntervalMinutes(timeframe: Timeframe): number | undefined {
  return INTERVAL_MAP.get(timeframe);
}

export const DEFAULT_KRAKEN_SYMBOL: KrakenSymbol = "XBTUSD";

/** Request bounds (OHLC returns ≤720 rows anyway; we slice to `KLINE_LIMIT`). */
export const KLINE_LIMIT = 500;
export const REST_TIMEOUT_MS = 10_000;

/** Stream freshness + reconnect policy (mirrors the Binance feed). */
export const STALE_AFTER_MS = 30_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
export const MAX_RECONNECT_ATTEMPTS = 8;
