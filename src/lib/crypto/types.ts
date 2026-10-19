import type { Candle, MarketDataErrorCode, Timeframe } from "@/lib/types";

/**
 * Live crypto display feed — UI-facing types for the public market-data read
 * path (Binance Spot public endpoints). Deliberately separate from the engine's
 * `HistoricalDataProvider` contract: this feed renders quotes and candles for
 * display only and never feeds Specs 00–35 pipelines.
 */

/** Where the feed stands right now — the UI must render this verbatim. */
export type FeedStatus =
  /** Socket open pending or first message not yet received. */
  | "connecting"
  /** Messages are arriving within the freshness window. */
  | "live"
  /** Socket lost; a reconnect attempt is scheduled or in flight. */
  | "reconnecting"
  /** Socket open but silent beyond the freshness window — values are last-received. */
  | "stale"
  /** Browser offline, retries exhausted, or stream closed deliberately. */
  | "offline";

/** One venue-specific quote — always attributed, never a consolidated price. */
export interface CryptoQuote {
  /** Provider symbol, e.g. "BTCUSDT". */
  symbol: string;
  /** Producing venue label, e.g. "Binance Spot". */
  venue: string;
  last: number;
  /** Signed 24h change, provider-computed where available. */
  change24h: number;
  changePct24h: number;
  high24h: number;
  low24h: number;
  /** 24h quote-currency volume (USDT-quoted pairs → notional). */
  quoteVolume24h: number;
  /** Provider event time (ms epoch, UTC). */
  eventTime: number;
}

/** Kline payload from REST or stream, normalized to the chart's Candle contract. */
export interface CryptoCandleSet {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  /** True when the last candle's close time is still in the future. */
  hasFormingCandle: boolean;
  warnings: string[];
}

export type CryptoError = { code: MarketDataErrorCode; message: string; detail?: string };

export type CryptoResult<T> = { ok: true; data: T } | { ok: false; error: CryptoError };

export function cryptoError(code: MarketDataErrorCode, message: string, detail?: string): CryptoResult<never> {
  return { ok: false, error: { code, message, detail } };
}
