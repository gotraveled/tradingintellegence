import type { Candle, Timeframe } from "@/lib/types";
import { VENUE_LABEL } from "./constants";
import type { CryptoCandleSet, CryptoQuote } from "../types";

/**
 * Binance wire-format → domain normalization. Every field is validated before
 * use; malformed rows are rejected with reasons, and a structurally invalid
 * payload fails closed — nothing is fabricated or silently repaired.
 *
 * Timestamp convention: Binance `openTime`/event times are Unix epoch ms UTC —
 * the canonical convention (`Candle.time` = bar-open ms). No timezone shift.
 */

function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * One kline row: [openTime, open, high, low, close, volume, closeTime,
 * quoteVolume, tradeCount, takerBase, takerQuote, ignore]. Returns null with a
 * reason pushed to `warnings` when the row is malformed.
 */
export function normalizeKlineRow(
  row: unknown,
  symbol: string,
  timeframe: Timeframe,
  warnings: string[],
): Candle | undefined {
  if (!Array.isArray(row) || row.length < 11) {
    warnings.push(`rejected kline row for ${symbol}: not an array of >= 11 fields`);
    return undefined;
  }
  const openTime = num(row[0]);
  const open = num(row[1]);
  const high = num(row[2]);
  const low = num(row[3]);
  const close = num(row[4]);
  const volume = num(row[5]);
  const closeTime = num(row[6]);
  const tradeCount = num(row[8]);
  if (
    openTime === undefined ||
    open === undefined ||
    high === undefined ||
    low === undefined ||
    close === undefined ||
    closeTime === undefined
  ) {
    warnings.push(`rejected kline row for ${symbol}: non-numeric OHLC/timestamp field`);
    return undefined;
  }
  if (openTime <= 0 || closeTime <= openTime) {
    warnings.push(`rejected kline row for ${symbol}: invalid open/close time (${openTime}, ${closeTime})`);
    return undefined;
  }
  if (high < Math.max(open, close) || low > Math.min(open, close) || low < 0) {
    warnings.push(`rejected kline row for ${symbol}: impossible OHLC relationship (o=${open} h=${high} l=${low} c=${close})`);
    return undefined;
  }
  return {
    time: openTime,
    open,
    high,
    low,
    close,
    volume,
    tradeCount,
    exchange: "BINANCE",
    assetClass: "crypto",
  };
}

/**
 * Normalize a REST `/api/v3/klines` payload. `now` decides whether the final
 * bar is still forming (its `closeTime` lies in the future) — the chart marks
 * it rather than treating it as closed history.
 */
export function normalizeKlines(
  payload: unknown,
  symbol: string,
  timeframe: Timeframe,
  now = Date.now(),
): CryptoCandleSet | { error: string } {
  if (!Array.isArray(payload)) {
    return { error: `malformed klines payload for ${symbol}: expected an array` };
  }
  const warnings: string[] = [];
  const candles: Candle[] = [];
  for (const row of payload) {
    const candle = normalizeKlineRow(row, symbol, timeframe, warnings);
    if (candle !== undefined) candles.push(candle);
  }
  // Ascending + dedup — Binance returns ordered rows, but the contract is enforced, not assumed.
  let prev = -Infinity;
  let outOfOrder = 0;
  const seen = new Set<number>();
  const cleaned = candles.filter((c) => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    if (c.time <= prev) outOfOrder += 1;
    prev = Math.max(prev, c.time);
    return true;
  });
  cleaned.sort((a, b) => a.time - b.time);
  if (outOfOrder > 0) warnings.push(`${outOfOrder} out-of-order kline row(s) re-sorted for ${symbol}`);
  const last = cleaned[cleaned.length - 1];
  const intervalMs = cleaned.length > 1 ? cleaned[1].time - cleaned[0].time : 0;
  const hasFormingCandle =
    last !== undefined && intervalMs > 0 && last.time + intervalMs > now;
  return { symbol, timeframe, candles: cleaned, hasFormingCandle, warnings };
}

/** Binance `24hrTicker` REST object or `@ticker` stream `data` payload. */
export function normalizeTicker(payload: unknown, symbol: string): CryptoQuote | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  const last = num(p.c ?? p.lastPrice);
  const open = num(p.o ?? p.openPrice);
  const high = num(p.h ?? p.highPrice);
  const low = num(p.l ?? p.lowPrice);
  const quoteVolume = num(p.q ?? p.quoteVolume);
  const eventTime = num(p.E ?? p.closeTime);
  if (last === undefined || open === undefined) return undefined;
  const changePct = num(p.P ?? p.priceChangePercent) ?? (open !== 0 ? ((last - open) / open) * 100 : 0);
  const change = num(p.p ?? p.priceChange) ?? last - open;
  return {
    symbol,
    venue: VENUE_LABEL,
    last,
    change24h: change,
    changePct24h: changePct,
    high24h: high ?? last,
    low24h: low ?? last,
    quoteVolume24h: quoteVolume ?? 0,
    eventTime: eventTime ?? Date.now(),
  };
}

/** Combined-stream envelope: `{ stream: "btcusdt@ticker", data: {...} }`. */
export interface StreamEnvelope {
  stream: string;
  data: Record<string, unknown>;
}

export function parseStreamMessage(raw: string): StreamEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const o = parsed as Record<string, unknown>;
  if (typeof o.stream !== "string" || typeof o.data !== "object" || o.data === null) return undefined;
  return { stream: o.stream, data: o.data as Record<string, unknown> };
}

/**
 * `@kline_<interval>` stream payload → updated candle. `k.x` is Binance's
 * own closed-bar flag — the forming/closed distinction comes from the provider,
 * never guessed.
 */
export function normalizeStreamKline(
  data: Record<string, unknown>,
): { candle: Candle; isClosed: boolean; openTime: number } | undefined {
  const k = data.k;
  if (typeof k !== "object" || k === null) return undefined;
  const kk = k as Record<string, unknown>;
  const warnings: string[] = [];
  // Pad to the documented 12-field kline shape (indices 9–11 unused by the validator).
  const candle = normalizeKlineRow(
    [kk.t, kk.o, kk.h, kk.l, kk.c, kk.v, kk.T, kk.q ?? 0, kk.n, 0, 0, 0],
    String(kk.s ?? "?"),
    "1m",
    warnings,
  );
  if (candle === undefined) return undefined;
  return { candle, isClosed: kk.x === true, openTime: candle.time };
}
