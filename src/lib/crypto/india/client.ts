import type { Candle, MarketDataErrorCode, Timeframe } from "@/lib/types";
import {
  cryptoError,
  type CryptoCandleSet,
  type CryptoQuote,
  type CryptoResult,
} from "../types";
import { INDIA_SYMBOLS, REST_TIMEOUT_MS, VENUE_LABEL } from "./constants";

/**
 * Browser-side client for the India feed — everything goes through
 * `/api/india-klines`, the same-origin proxy that talks to Yahoo. The
 * route owns the upstream contract; this module only normalizes errors
 * and shapes results into the venue registry types.
 */

interface RouteOk {
  candles: Candle[];
  /** True when today's bars came from the live exchange feed, not Yahoo. */
  live?: boolean;
  meta: {
    price: number;
    eventTime: number;
    prevClose: number;
    dayHigh: number;
    dayLow: number;
  };
}

interface RouteErr {
  error: { code: MarketDataErrorCode; message: string };
}

function timeframeMs(tf: Timeframe): number {
  const map: Record<string, number> = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "1D": 86_400_000,
  };
  return map[tf] ?? 60_000;
}

async function call(symbol: string, timeframe: Timeframe): Promise<CryptoResult<RouteOk>> {
  try {
    const res = await fetch(
      `/api/india-klines?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`,
      { signal: AbortSignal.timeout(REST_TIMEOUT_MS), cache: "no-store" },
    );
    const body = (await res.json()) as RouteOk & RouteErr;
    if (!res.ok || body.error !== undefined) {
      const code = body.error?.code ?? (res.ok ? "provider_error" : "provider_error");
      return cryptoError(code, body.error?.message ?? `Proxy HTTP ${res.status}`);
    }
    return { ok: true, data: body };
  } catch (e) {
    return cryptoError(
      "provider_error",
      `India feed unreachable — ${e instanceof Error ? e.message : "network error"}`,
    );
  }
}

export async function fetchIndiaKlines(
  symbol: string,
  timeframe: Timeframe,
): Promise<CryptoResult<CryptoCandleSet>> {
  const res = await call(symbol, timeframe);
  if (!res.ok) return res;
  const candles = res.data.candles;
  const last = candles[candles.length - 1];
  return {
    ok: true,
    data: {
      symbol,
      timeframe,
      candles,
      // The tail bar is still forming while its close time is in the future.
      hasFormingCandle: last !== undefined && last.time + timeframeMs(timeframe) > Date.now(),
      warnings:
        res.data.live === true
          ? ["Live NSE/BSE exchange feed — index volume is always 0."]
          : ["Yahoo Finance — ~15 min delayed index data; volume is always 0 for indices."],
    },
  };
}

export async function fetchIndiaQuotes(): Promise<CryptoResult<CryptoQuote[]>> {
  const out: CryptoQuote[] = [];
  for (const s of INDIA_SYMBOLS) {
    const res = await call(s.symbol, "1m");
    if (!res.ok) return res;
    const { meta } = res.data;
    const change = meta.price - meta.prevClose;
    out.push({
      symbol: s.symbol,
      venue: VENUE_LABEL,
      last: meta.price,
      change24h: change,
      changePct24h: meta.prevClose !== 0 ? (change / meta.prevClose) * 100 : 0,
      high24h: meta.dayHigh,
      low24h: meta.dayLow,
      quoteVolume24h: 0,
      eventTime: meta.eventTime,
    });
  }
  return { ok: true, data: out };
}
