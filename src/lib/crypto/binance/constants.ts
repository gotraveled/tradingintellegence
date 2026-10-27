import type { Timeframe } from "@/lib/types";

/**
 * Binance Spot public market-data constants.
 *
 * Verified 2026-10-19 from this environment (IST): `api.binance.com` and all
 * listed fallbacks answer `/api/v3/ping` with 200; `exchangeInfo` reports every
 * symbol below `status: "TRADING"`; `stream.binance.com:9443` accepts
 * connections and streams `miniTicker`/`ticker`/`kline` events. Public
 * endpoints need no credentials. Public-display redistribution terms remain
 * unresolved — see the feature's disclosure copy; the feed is labelled
 * venue-specific and never consolidated.
 */

export const BINANCE_REST_HOSTS = [
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api-gcp.binance.com",
  "https://data-api.binance.vision",
] as const;

export const BINANCE_WS_BASE = "wss://stream.binance.com:9443";

export const VENUE_LABEL = "Binance Spot";

/**
 * Strict symbol allowlist — each entry was verified `TRADING` via
 * `GET /api/v3/exchangeInfo` before being added. Never accepts arbitrary input:
 * the UI and any proxy must reject unlisted symbols rather than fetch them.
 */
export const CRYPTO_SYMBOLS = [
  { symbol: "BTCUSDT", label: "BTC / USDT", name: "Bitcoin", pricePrecision: 2 },
  { symbol: "ETHUSDT", label: "ETH / USDT", name: "Ethereum", pricePrecision: 2 },
] as const;

export type CryptoSymbol = (typeof CRYPTO_SYMBOLS)[number]["symbol"];

export const CRYPTO_SYMBOL_SET: ReadonlySet<string> = new Set(CRYPTO_SYMBOLS.map((s) => s.symbol));

export function cryptoSymbolInfo(symbol: string) {
  return CRYPTO_SYMBOLS.find((s) => s.symbol === symbol);
}

export function isCryptoSymbol(symbol: string): symbol is CryptoSymbol {
  return CRYPTO_SYMBOL_SET.has(symbol);
}

/**
 * Canonical timeframe → Binance kline interval. Only this subset is offered in
 * the UI; all are documented Binance intervals (verified against the exchange
 * info / klines contract).
 */
export const CRYPTO_INTERVALS: { timeframe: Timeframe; binance: string; label: string }[] = [
  { timeframe: "1m", binance: "1m", label: "1m" },
  { timeframe: "5m", binance: "5m", label: "5m" },
  { timeframe: "15m", binance: "15m", label: "15m" },
  { timeframe: "30m", binance: "30m", label: "30m" },
  { timeframe: "1h", binance: "1h", label: "1H" },
  { timeframe: "4h", binance: "4h", label: "4H" },
  { timeframe: "1D", binance: "1d", label: "1D" },
];

const INTERVAL_MAP: ReadonlyMap<Timeframe, string> = new Map(
  CRYPTO_INTERVALS.map((i) => [i.timeframe, i.binance]),
);

export function binanceInterval(timeframe: Timeframe): string | undefined {
  return INTERVAL_MAP.get(timeframe);
}

export const DEFAULT_CRYPTO_SYMBOL: CryptoSymbol = "BTCUSDT";
export const DEFAULT_CRYPTO_TIMEFRAME: Timeframe = "5m";

/** REST + stream request bounds. */
export const KLINE_LIMIT = 500;
export const KLINE_LIMIT_MAX = 500;
export const REST_TIMEOUT_MS = 10_000;

/** Stream freshness + reconnect policy. */
export const STALE_AFTER_MS = 30_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
export const MAX_RECONNECT_ATTEMPTS = 8;

/** Build a combined-stream URL. Streams are `symbol@streamName` lowercased. */
export function binanceStreamUrl(streams: readonly string[]): string {
  return `${BINANCE_WS_BASE}/stream?streams=${streams.map((s) => s.toLowerCase()).join("/")}`;
}
