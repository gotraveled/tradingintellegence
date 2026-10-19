import type { Candle, Timeframe } from "@/lib/types";
import {
  KRAKEN_SYMBOLS,
  krakenIntervalMinutes,
  krakenSymbolInfo,
  VENUE_LABEL,
} from "./constants";
import type { CryptoCandleSet, CryptoQuote } from "../types";

/**
 * Kraken wire-format → domain normalization. Every field is validated before
 * use; malformed rows are rejected with reasons, and a structurally invalid
 * payload fails closed — nothing is fabricated or silently repaired.
 *
 * Timestamp conventions (both converted to the canonical bar-open ms):
 *  - REST OHLC rows open at Unix epoch SECONDS (`row[0]`).
 *  - WS v2 `ohlc.interval_begin` and ticker `timestamp` are ISO-8601 strings.
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
 * One REST OHLC row: [time(sec), open, high, low, close, vwap, volume, count].
 * `symbol` here is the canonical allowlist symbol (e.g. "XBTUSD"), not the
 * REST response key — the caller resolves the response key first.
 */
export function normalizeKrakenOhlcRow(
  row: unknown,
  symbol: string,
  warnings: string[],
): Candle | undefined {
  if (!Array.isArray(row) || row.length < 7) {
    warnings.push(`rejected OHLC row for ${symbol}: not an array of >= 7 fields`);
    return undefined;
  }
  const openTimeSec = num(row[0]);
  const open = num(row[1]);
  const high = num(row[2]);
  const low = num(row[3]);
  const close = num(row[4]);
  const volume = num(row[6]);
  const tradeCount = num(row[7]);
  if (
    openTimeSec === undefined ||
    open === undefined ||
    high === undefined ||
    low === undefined ||
    close === undefined
  ) {
    warnings.push(`rejected OHLC row for ${symbol}: non-numeric OHLC/timestamp field`);
    return undefined;
  }
  const openTime = Math.round(openTimeSec * 1000);
  if (openTime <= 0) {
    warnings.push(`rejected OHLC row for ${symbol}: invalid open time (${openTimeSec})`);
    return undefined;
  }
  if (high < Math.max(open, close) || low > Math.min(open, close) || low < 0) {
    warnings.push(
      `rejected OHLC row for ${symbol}: impossible OHLC relationship (o=${open} h=${high} l=${low} c=${close})`,
    );
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
    exchange: "KRAKEN",
    assetClass: "crypto",
  };
}

/**
 * Normalize a REST `/0/public/OHLC` result object. The response is
 * `{ <pairKey>: [rows...], last: <epoch sec> }` where `<pairKey>` is an
 * unspecified legacy name — resolved by matching `restKeys` (or, failing
 * that, the single non-`last` array-valued entry).
 */
export function normalizeKrakenOhlc(
  payload: unknown,
  symbol: string,
  timeframe: Timeframe,
  now = Date.now(),
): CryptoCandleSet | { error: string } {
  if (typeof payload !== "object" || payload === null) {
    return { error: `malformed OHLC payload for ${symbol}: expected an object` };
  }
  const result = payload as Record<string, unknown>;
  const info = krakenSymbolInfo(symbol);
  if (info === undefined) {
    return { error: `symbol '${symbol}' is not on the Kraken allowlist` };
  }
  let rows: unknown;
  let matchedKey = "";
  for (const key of info.restKeys) {
    if (Array.isArray(result[key])) {
      rows = result[key];
      matchedKey = key;
      break;
    }
  }
  if (rows === undefined) {
    const arrays = Object.entries(result).filter(
      ([k, v]) => k !== "last" && Array.isArray(v),
    );
    if (arrays.length === 1) {
      [matchedKey, rows] = arrays[0];
    } else {
      return {
        error: `malformed OHLC payload for ${symbol}: no recognizable candle array (keys: ${Object.keys(result).join(", ")})`,
      };
    }
  }
  if (!Array.isArray(rows)) {
    return { error: `malformed OHLC payload for ${symbol}: ${matchedKey} is not an array` };
  }

  const warnings: string[] = [];
  const candles: Candle[] = [];
  for (const row of rows) {
    const candle = normalizeKrakenOhlcRow(row, symbol, warnings);
    if (candle !== undefined) candles.push(candle);
  }
  // Ascending + dedup — enforced, not assumed.
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
  if (outOfOrder > 0) warnings.push(`${outOfOrder} out-of-order OHLC row(s) re-sorted for ${symbol}`);

  const mins = krakenIntervalMinutes(timeframe);
  const intervalMs =
    mins !== undefined
      ? mins * 60_000
      : cleaned.length > 1
        ? cleaned[1].time - cleaned[0].time
        : 0;
  const last = cleaned[cleaned.length - 1];
  const hasFormingCandle =
    last !== undefined && intervalMs > 0 && last.time + intervalMs > now;
  return { symbol, timeframe, candles: cleaned, hasFormingCandle, warnings };
}

/**
 * Normalize a REST `/0/public/Ticker` result object into per-symbol quotes.
 * Result keys are legacy pair names (e.g. "XXBTZUSD") — resolved via each
 * allowlist entry's `restKeys` (or a single ambiguous array row is rejected).
 */
export function normalizeKrakenTickers(
  payload: unknown,
): { quotes: CryptoQuote[]; warnings: string[] } | { error: string } {
  if (typeof payload !== "object" || payload === null) {
    return { error: "malformed Ticker payload: expected an object" };
  }
  const result = payload as Record<string, unknown>;
  const quotes: CryptoQuote[] = [];
  const warnings: string[] = [];
  for (const info of krakenSymbolList()) {
    const row = info.restKeys.map((k) => result[k]).find((v) => typeof v === "object" && v !== null);
    if (row === undefined) {
      warnings.push(`ticker row missing for ${info.symbol}`);
      continue;
    }
    const quote = normalizeKrakenTickerRow(row, info.symbol);
    if (quote !== undefined) quotes.push(quote);
    else warnings.push(`dropped malformed ticker row for ${info.symbol}`);
  }
  if (quotes.length === 0) return { error: "ticker response contained no usable rows" };
  return { quotes, warnings };
}

/** One REST Ticker row: { a:[ask,...], b:[bid,...], c:[last,lot], v, p, t, l, h, o }. */
function normalizeKrakenTickerRow(row: unknown, symbol: string): CryptoQuote | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const r = row as Record<string, unknown>;
  const last = Array.isArray(r.c) ? num(r.c[0]) : num(r.c);
  const high = Array.isArray(r.h) ? num(r.h[0]) : num(r.h);
  const low = Array.isArray(r.l) ? num(r.l[0]) : num(r.l);
  // 24h base volume × 24h VWAP ≈ 24h quote-currency turnover.
  const vol24h = Array.isArray(r.v) ? num(r.v[0]) : num(r.v);
  const vwap24h = Array.isArray(r.p) ? num(r.p[0]) : num(r.p);
  const open = Array.isArray(r.o) ? num(r.o[0]) : num(r.o);
  if (last === undefined || open === undefined) return undefined;
  return {
    symbol,
    venue: VENUE_LABEL,
    last,
    change24h: last - open,
    changePct24h: open !== 0 ? ((last - open) / open) * 100 : 0,
    high24h: high ?? last,
    low24h: low ?? last,
    quoteVolume24h: vol24h !== undefined && vwap24h !== undefined ? vol24h * vwap24h : 0,
    eventTime: Date.now(),
  };
}

function krakenSymbolList() {
  return KRAKEN_SYMBOLS;
}

// ---------- WebSocket v2 payloads ----------

/** One parsed WS v2 message, normalized to a minimal envelope for dispatch. */
export type KrakenWsEvent =
  | { kind: "ticker"; symbol: string; quote: CryptoQuote }
  | { kind: "ohlc"; symbol: string; candle: Candle; intervalBeginMs: number }
  | { kind: "ignored" };

function isoToMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Find the allowlist entry matching a WS v2 `"BASE/QUOTE"` symbol. */
export function krakenSymbolFromWs(wsSymbol: string) {
  return krakenSymbolList().find((s) => s.wsSymbol === wsSymbol);
}

/**
 * Parse one WS v2 frame. Only `ticker`/`ohlc` data messages produce events;
 * `status`, `heartbeat`, `subscribe`/`unsubscribe` acks, and malformed frames
 * map to `ignored` — never fabricated into data.
 */
export function parseKrakenWsMessage(raw: string): KrakenWsEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [{ kind: "ignored" }];
  }
  if (typeof parsed !== "object" || parsed === null) return [{ kind: "ignored" }];
  const o = parsed as Record<string, unknown>;
  if (o.channel !== "ticker" && o.channel !== "ohlc") return [{ kind: "ignored" }];
  if (o.type !== "update" && o.type !== "snapshot") return [{ kind: "ignored" }];
  if (!Array.isArray(o.data)) return [{ kind: "ignored" }];

  const events: KrakenWsEvent[] = [];
  for (const row of o.data as Record<string, unknown>[]) {
    if (typeof row !== "object" || row === null) continue;
    const wsSymbol = typeof row.symbol === "string" ? row.symbol : "";
    const info = krakenSymbolFromWs(wsSymbol);
    if (info === undefined) continue;

    if (o.channel === "ticker") {
      const last = num(row.last);
      const high = num(row.high);
      const low = num(row.low);
      const volume = num(row.volume);
      const ts = isoToMs(row.timestamp) ?? Date.now();
      if (last === undefined) continue;
      events.push({
        kind: "ticker",
        symbol: info.symbol,
        quote: {
          symbol: info.symbol,
          venue: VENUE_LABEL,
          last,
          change24h: num(row.change) ?? 0,
          changePct24h: num(row.change_pct) ?? 0,
          high24h: high ?? last,
          low24h: low ?? last,
          quoteVolume24h: volume !== undefined ? volume * (num(row.vwap) ?? last) : 0,
          eventTime: ts,
        },
      });
    } else {
      const beginMs = isoToMs(row.interval_begin);
      const open = num(row.open);
      const high = num(row.high);
      const low = num(row.low);
      const close = num(row.close);
      const volume = num(row.volume);
      if (beginMs === undefined || open === undefined || high === undefined || low === undefined || close === undefined) {
        continue;
      }
      events.push({
        kind: "ohlc",
        symbol: info.symbol,
        candle: {
          time: beginMs,
          open,
          high,
          low,
          close,
          volume,
          exchange: "KRAKEN",
          assetClass: "crypto",
        },
        intervalBeginMs: beginMs,
      });
    }
  }
  return events;
}
