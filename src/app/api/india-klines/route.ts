import { NextResponse } from "next/server";
import type { Candle, Timeframe } from "@/lib/types";
import { indiaInterval, isIndiaSymbol, yahooSymbol } from "@/lib/crypto/india/constants";

/**
 * GET /api/india-klines?symbol=NIFTY50&timeframe=5m
 *
 * Tiered Indian-index feed:
 *  1. LIVE — the exchange's own website chart API (NSE `chart-databyindex`,
 *     BSE `StockReachGraph`) supplies today's tick line, resampled into
 *     OHLC bars. Same feed the nseindia.com/bseindia.com charts draw from —
 *     real-time, not the 15-min-delayed vendor tape.
 *  2. HISTORY — Yahoo's v8 chart endpoint fills the lookback (zone context
 *     needs ~30 context-TF bars; a 9:15-AM session has too few live bars).
 *  Live bars override Yahoo's delayed copy of today; Yahoo alone serves
 *  when the exchange endpoint is unreachable.
 *  Strict allowlist on both params; never proxies arbitrary tickers.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const YAHOO_HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
] as const;
const SESSION_MS = 6.25 * 3_600_000; // 09:15–15:30 IST

interface YahooMeta {
  regularMarketPrice?: number;
  regularMarketTime?: number;
  chartPreviousClose?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
}

interface YahooChart {
  chart?: {
    result?: [
      {
        timestamp?: number[];
        meta?: YahooMeta;
        indicators?: {
          quote?: [{ open?: number[]; high?: number[]; low?: number[]; close?: number[] }];
        };
      },
    ] | null;
    error?: { code?: string; description?: string } | null;
  };
}

// ---- NSE live tick line -------------------------------------------------

let nseCookie = "";
let nseCookieAt = 0;

async function nseSession(): Promise<string> {
  if (nseCookie !== "" && Date.now() - nseCookieAt < 5 * 60_000) return nseCookie;
  const res = await fetch("https://www.nseindia.com", {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  nseCookie = (res.headers.getSetCookie() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
  nseCookieAt = Date.now();
  return nseCookie;
}

const NSE_CHART_URL =
  "https://www.nseindia.com/api/chart-databyindex?index=NIFTY50-INDEX&indices=true";

async function nseFetch(cookie: string): Promise<{ t: number; p: number }[] | undefined> {
  const res = await fetch(NSE_CHART_URL, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Referer: "https://www.nseindia.com/",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: cookie,
    },
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { grapthData?: [number, number][] };
  const out = (body.grapthData ?? [])
    .filter(([t, p]) => typeof t === "number" && typeof p === "number")
    .map(([t, p]) => ({ t, p }));
  return out.length > 10 ? out : undefined;
}

/** Today's NIFTY 50 tick line → [epochMs, price] points, real-time. */
async function nseTicks(): Promise<{ t: number; p: number }[] | undefined> {
  try {
    const cookie = await nseSession();
    const first = await nseFetch(cookie);
    if (first !== undefined) return first;
    nseCookie = ""; // maybe a stale session — one refresh + retry
    const fresh = await nseSession();
    return await nseFetch(fresh);
  } catch {
    return undefined;
  }
}

// ---- BSE live tick line -------------------------------------------------

/** Today's SENSEX tick line — api.bseindia.com, the exchange's own feed. */
async function bseTicks(): Promise<{ t: number; p: number }[] | undefined> {
  try {
    const res = await fetch(
      "https://api.bseindia.com/BseIndiaAPI/api/StockReachGraph/w" +
        "?scripcode=1&flag=0&fromdate=&todate=&seriesid=",
      {
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          Referer: "https://www.bseindia.com/",
          Origin: "https://www.bseindia.com",
        },
        signal: AbortSignal.timeout(8_000),
        cache: "no-store",
      },
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      Data?: string | { dttm?: string; vale1?: string | number }[];
    };
    const out: { t: number; p: number }[] = [];
    const push = (dttm: string, vale: string | number): void => {
      // BSE stamps IST wall-clock with no zone — pin it to +05:30.
      const ms = Date.parse(`${dttm.replace(" ", "T")}+05:30`);
      const p = typeof vale === "number" ? vale : Number(vale);
      if (!Number.isNaN(ms) && Number.isFinite(p) && p > 0) out.push({ t: ms, p });
    };
    if (typeof body.Data === "string") {
      for (const pair of body.Data.split(";")) {
        const [dttm, vale] = pair.split("|");
        if (dttm !== undefined && vale !== undefined) push(dttm, vale);
      }
    } else if (Array.isArray(body.Data)) {
      for (const row of body.Data) {
        if (row.dttm !== undefined && row.vale1 !== undefined) push(row.dttm, row.vale1);
      }
    }
    return out.length > 10 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Today's live tick source per symbol — exchange-native, no vendor delay. */
function liveTicks(symbol: string): Promise<{ t: number; p: number }[] | undefined> {
  return symbol === "NIFTY50" ? nseTicks() : bseTicks();
}

// ---- Resample + merge ---------------------------------------------------

function tfMs(tf: Timeframe): number {
  const m: Record<string, number> = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "1D": 86_400_000,
  };
  return m[tf] ?? 60_000;
}

/** Tick line → OHLC bars bucketed on wall-clock interval boundaries. */
function resample(points: { t: number; p: number }[], iv: number): Candle[] {
  const bars = new Map<number, Candle>();
  for (const { t, p } of points) {
    const open = Math.floor(t / iv) * iv;
    const bar = bars.get(open);
    if (bar === undefined) {
      bars.set(open, { time: open, open: p, high: p, low: p, close: p, volume: 0 });
    } else {
      bar.high = Math.max(bar.high, p);
      bar.low = Math.min(bar.low, p);
      bar.close = p;
    }
  }
  return [...bars.values()].sort((a, b) => a.time - b.time);
}

/** Live today bars replace Yahoo's delayed copy of the same bar opens. */
function merge(history: Candle[], live: Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of history) m.set(c.time, c);
  for (const c of live) m.set(c.time, c); // live wins same-open collisions
  return [...m.values()].sort((a, b) => a.time - b.time);
}

// ---- Yahoo history ------------------------------------------------------

async function yahooHistory(
  ticker: string,
  interval: { yahoo: string; range: string },
): Promise<{ candles: Candle[]; meta: YahooMeta } | undefined> {
  const path = `/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval.yahoo}&range=${interval.range}`;
  for (const host of YAHOO_HOSTS) {
    try {
      const res = await fetch(`${host}${path}`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      if (!res.ok) continue;
      const body = (await res.json()) as YahooChart;
      const result = body.chart?.result?.[0];
      if (result === undefined || !Array.isArray(result.timestamp)) return undefined;
      const q = result.indicators?.quote?.[0];
      const candles = (result.timestamp ?? [])
        .map((t, i) => {
          const o = q?.open?.[i];
          const h = q?.high?.[i];
          const l = q?.low?.[i];
          const c = q?.close?.[i];
          if (o == null || h == null || l == null || c == null) return undefined;
          return { time: t * 1000, open: o, high: h, low: l, close: c, volume: 0 };
        })
        .filter((c): c is NonNullable<typeof c> => c !== undefined);
      if (candles.length === 0) return undefined;
      return { candles, meta: result.meta ?? {} };
    } catch {
      // try next host
    }
  }
  return undefined;
}

// ---- Route --------------------------------------------------------------

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol") ?? "";
  const timeframe = searchParams.get("timeframe") ?? "";

  if (!isIndiaSymbol(symbol)) {
    return NextResponse.json(
      { error: { code: "unsupported_symbol", message: `Unknown symbol "${symbol}"` } },
      { status: 400 },
    );
  }
  const interval = indiaInterval(timeframe as Timeframe);
  if (interval === undefined) {
    return NextResponse.json(
      { error: { code: "unsupported_timeframe", message: `Unknown timeframe "${timeframe}"` } },
      { status: 400 },
    );
  }

  const iv = tfMs(timeframe as Timeframe);
  const [live, hist] = await Promise.all([
    timeframe === "1D" ? Promise.resolve(undefined) : liveTicks(symbol),
    yahooHistory(yahooSymbol(symbol)!, interval),
  ]);

  const liveBars = live !== undefined ? resample(live, iv) : [];
  const candles = hist !== undefined ? merge(hist.candles, liveBars) : liveBars;
  if (candles.length === 0) {
    return NextResponse.json(
      {
        error: {
          code: "provider_error",
          message: "Both the exchange feed and Yahoo history failed",
        },
      },
      { status: 502 },
    );
  }

  const m = hist?.meta ?? {};
  const livePrice = live?.[live.length - 1]?.p;
  const today = candles.filter((c) => Date.now() - c.time < SESSION_MS + 3_600_000);
  return NextResponse.json({
    candles,
    live: live !== undefined,
    meta: {
      price: livePrice ?? m.regularMarketPrice ?? candles[candles.length - 1].close,
      eventTime:
        live !== undefined
          ? live[live.length - 1].t
          : m.regularMarketTime !== undefined
            ? m.regularMarketTime * 1000
            : Date.now(),
      prevClose: m.chartPreviousClose ?? candles[0].open,
      dayHigh: Math.max(m.regularMarketDayHigh ?? 0, ...today.map((c) => c.high)),
      dayLow:
        today.length > 0
          ? Math.min(m.regularMarketDayLow ?? Infinity, ...today.map((c) => c.low))
          : (m.regularMarketDayLow ?? candles[candles.length - 1].low),
    },
  });
}
