"use client";

import {
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  Loader2,
  Minus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CandlestickChart, type ChartMarker } from "@/components/charts/candlestick-chart";
import type { ChartOverlay } from "@/components/charts/chart-types";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { analyzeCandles, type SignalAnalysis, type TradeSignal } from "@/lib/crypto/analysis";
import {
  ACCOUNT_CAPITAL_USD,
  clearTrades,
  closeAllPositions,
  closePosition,
  dailyStats,
  equityOf,
  evaluateTrade,
  floatingPnlUsd,
  BIAS_TIMEFRAME,
  entryBlockReason,
  ENTRY_SESSION_UTC,
  journalKey,
  loadTrades,
  pointsCaptured,
  registerSignal,
  saveTrades,
  symbolStats,
  timeframeMs,
  tradeKey,
  unrealizedR,
  unrealizedUsd,
  type TradeRecord,
} from "@/lib/crypto/journal";
import { analyzeTechnicals } from "@/lib/crypto/technicals";
import { newsBlockEvent } from "@/lib/crypto/news";
import { backtestCandles, type BacktestStats } from "@/lib/crypto/backtest";
import { STRATEGIES } from "@/lib/crypto/strategies";
import { markStrongAcross, pinBar, swingZones, victorSignal } from "@/lib/crypto/victor";
import type { CalendarEvent } from "@/app/api/economic-calendar/route";
import { fetchCryptoKlines, fetchCryptoQuotes } from "@/lib/crypto/binance/client";
import {
  binanceInterval,
  CRYPTO_INTERVALS,
  CRYPTO_SYMBOLS,
  cryptoSymbolInfo,
  DEFAULT_CRYPTO_SYMBOL,
  DEFAULT_CRYPTO_TIMEFRAME,
  VENUE_LABEL as BINANCE_VENUE,
} from "@/lib/crypto/binance/constants";
import { normalizeStreamKline, normalizeTicker } from "@/lib/crypto/binance/normalize";
import { BinanceStream, klineStream, tickerStreams } from "@/lib/crypto/binance/stream";
import { fetchKrakenOhlc, fetchKrakenQuotes } from "@/lib/crypto/kraken/client";
import { fetchIndiaKlines, fetchIndiaQuotes } from "@/lib/crypto/india/client";
import {
  DEFAULT_INDIA_SYMBOL,
  INDIA_INTERVALS,
  INDIA_SESSION_UTC,
  INDIA_SYMBOLS,
  indiaSymbolInfo,
  VENUE_LABEL as INDIA_VENUE,
} from "@/lib/crypto/india/constants";
import {
  DEFAULT_KRAKEN_SYMBOL,
  KRAKEN_INTERVALS,
  KRAKEN_SYMBOLS,
  krakenIntervalMinutes,
  krakenSymbolInfo,
  VENUE_LABEL as KRAKEN_VENUE,
} from "@/lib/crypto/kraken/constants";
import { KrakenStream } from "@/lib/crypto/kraken/stream";
import type { CryptoCandleSet, CryptoQuote, CryptoResult, FeedStatus } from "@/lib/crypto/types";
import type { Candle, Direction, Timeframe, Tone } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Live crypto workspace — venue-specific public feeds only (Binance Spot and
 * Kraken Spot). REST seeds history and quotes; one WebSocket per venue streams
 * updates. Fully separate from the Polygon-gated provider layer and from the
 * chart-upload feature, which lives on its own surface.
 *
 * Honesty contract: the feed badge renders the stream's real status verbatim;
 * last-received values stay visible but labelled stale when the socket goes
 * silent; every quote and candle is attributed to its venue — prices are never
 * consolidated across venues and no synthetic data ever appears here.
 */

// ---------- feed plumbing ----------

type VenueId = "binance" | "kraken" | "india";

interface VenueSymbol {
  symbol: string;
  label: string;
  name: string;
  pricePrecision: number;
}

interface VenueDef {
  id: VenueId;
  label: string;
  symbols: readonly VenueSymbol[];
  defaultSymbol: string;
  intervals: { timeframe: Timeframe; label: string }[];
  symbolInfo(symbol: string): VenueSymbol | undefined;
  fetchQuotes(): Promise<CryptoResult<CryptoQuote[]>>;
  fetchKlines(symbol: string, timeframe: Timeframe): Promise<CryptoResult<CryptoCandleSet>>;
  /** Open the venue's live socket. Returns a handle whose close() tears down. */
  connect(opts: {
    symbol: string;
    timeframe: Timeframe;
    onQuote: (quote: CryptoQuote) => void;
    onCandle: (candle: Candle, isClosed: boolean) => void;
    onStatus: (status: FeedStatus, lastEventAt?: number) => void;
  }): { close(): void };
}

const VENUES: Record<VenueId, VenueDef> = {
  binance: {
    id: "binance",
    label: BINANCE_VENUE,
    symbols: CRYPTO_SYMBOLS,
    defaultSymbol: DEFAULT_CRYPTO_SYMBOL,
    intervals: CRYPTO_INTERVALS.map((i) => ({ timeframe: i.timeframe, label: i.label })),
    symbolInfo: cryptoSymbolInfo,
    fetchQuotes: () => fetchCryptoQuotes(CRYPTO_SYMBOLS.map((s) => s.symbol)),
    fetchKlines: (symbol, timeframe) => fetchCryptoKlines(symbol, timeframe),
    connect({ symbol, timeframe, onQuote, onCandle, onStatus }) {
      const streams = [...tickerStreams(CRYPTO_SYMBOLS.map((s) => s.symbol))];
      const interval = binanceInterval(timeframe);
      if (interval !== undefined) streams.push(klineStream(symbol, interval));
      const feed = new BinanceStream({
        streams,
        onStatus,
        onMessage: (envelope) => {
          const [sym, channel] = envelope.stream.split("@");
          const upper = sym.toUpperCase();
          if (channel === "ticker") {
            const quote = normalizeTicker(envelope.data, upper);
            if (quote !== undefined) onQuote(quote);
          } else if (channel.startsWith("kline") && upper === symbol) {
            const update = normalizeStreamKline(envelope.data);
            if (update !== undefined) onCandle(update.candle, update.isClosed);
          }
        },
      });
      feed.start();
      return feed;
    },
  },
  kraken: {
    id: "kraken",
    label: KRAKEN_VENUE,
    symbols: KRAKEN_SYMBOLS,
    defaultSymbol: DEFAULT_KRAKEN_SYMBOL,
    intervals: KRAKEN_INTERVALS.map((i) => ({ timeframe: i.timeframe, label: i.label })),
    symbolInfo: krakenSymbolInfo,
    fetchQuotes: () => fetchKrakenQuotes(),
    fetchKlines: (symbol, timeframe) => fetchKrakenOhlc(symbol, timeframe),
    connect({ symbol, timeframe, onQuote, onCandle, onStatus }) {
      const feed = new KrakenStream({
        symbols: KRAKEN_SYMBOLS.map((s) => s.wsSymbol),
        ohlcIntervalMinutes: krakenIntervalMinutes(timeframe),
        onStatus,
        onMessage: (event) => {
          if (event.kind === "ticker") onQuote(event.quote);
          else if (event.kind === "ohlc" && event.symbol === symbol) {
            // Kraken pushes the forming bar per trade; a new interval_begin
            // means the previous bar is complete — handled in applyCandle.
            onCandle(event.candle, false);
          }
        },
      });
      feed.start();
      return feed;
    },
  },
  india: {
    id: "india",
    label: INDIA_VENUE,
    symbols: INDIA_SYMBOLS,
    defaultSymbol: DEFAULT_INDIA_SYMBOL,
    intervals: INDIA_INTERVALS.map((i) => ({ timeframe: i.timeframe, label: i.label })),
    symbolInfo: indiaSymbolInfo,
    fetchQuotes: fetchIndiaQuotes,
    fetchKlines: (symbol, timeframe) => fetchIndiaKlines(symbol, timeframe),
    connect({ symbol, timeframe, onQuote, onCandle, onStatus }) {
      // No public tick socket exists for NSE/BSE — REST poll every
      // minute; the tail bar arrives forming and closes as its interval
      // ends, so the chart moves without a websocket.
      onStatus("live", Date.now());
      const timer = setInterval(() => {
        void fetchIndiaKlines(symbol, timeframe).then((res) => {
          if (!res.ok) return;
          const tail = res.data.candles[res.data.candles.length - 1];
          if (tail !== undefined) {
            onCandle(tail, !res.data.hasFormingCandle);
            onStatus("live", Date.now());
          }
        });
        void fetchIndiaQuotes().then((res) => {
          if (res.ok) for (const q of res.data) onQuote(q);
        });
      }, 60_000);
      return { close: () => clearInterval(timer) };
    },
  },
};

const VENUE_ORDER: VenueId[] = ["binance", "india", "kraken"];

/** Timeframes scanned continuously for intraday setups. */
const SCAN_TIMEFRAMES: Timeframe[] = ["5m", "15m", "30m", "1h", "4h"];
const SCAN_REFRESH_MS = 60_000;
const CANDLE_FLUSH_MS = 700;

const FEED_META: Record<FeedStatus, { tone: Tone; label: string; icon: LucideIcon }> = {
  connecting: { tone: "neutral", label: "Connecting", icon: Loader2 },
  live: { tone: "bullish", label: "Live", icon: Wifi },
  reconnecting: { tone: "developing", label: "Reconnecting", icon: RefreshCw },
  stale: { tone: "developing", label: "Stale", icon: TriangleAlert },
  offline: { tone: "inactive", label: "Offline", icon: WifiOff },
};

const DIR_META: Record<Direction | "wait" | "ranging", { tone: Tone; label: string; icon: LucideIcon }> = {
  bullish: { tone: "bullish", label: "BUY", icon: ArrowUpRight },
  bearish: { tone: "bearish", label: "SELL", icon: ArrowDownRight },
  wait: { tone: "neutral", label: "WAIT", icon: Minus },
  ranging: { tone: "neutral", label: "Ranging", icon: Minus },
};

interface ScanRow {
  state: "loading" | "ready" | "error";
  analysis?: SignalAnalysis;
  error?: string;
}

type ScanState = Partial<Record<Timeframe, ScanRow>>;

/** A journaled trade event surfaced to the user (in-app feed + browser notification). */
interface TradeAlert {
  id: string;
  text: string;
  at: number;
  tone: "bullish" | "bearish" | "neutral";
}

function fmtPrice(value: number | undefined, precision: number): string {
  if (value === undefined) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

function fmtUsd(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Signed USD P&L — "+$123.40" / "-$55.00". */
function fmtUsdPnl(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** "in 4h 12m" / "in 7m" countdown for upcoming calendar events. */
function fmtCountdown(deltaMs: number): string {
  const m = Math.max(1, Math.round(deltaMs / 60_000));
  if (m >= 60) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
  return `in ${m}m`;
}

function fmtSignedPct(value: number | undefined): string {
  if (value === undefined) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

// ---------- component ----------

export function CryptoMarketsWorkspace() {
  const [venueId, setVenueId] = useState<VenueId>("binance");
  const venue = VENUES[venueId];
  const [symbol, setSymbol] = useState<string>(venue.defaultSymbol);
  const [timeframe, setTimeframe] = useState<Timeframe>(DEFAULT_CRYPTO_TIMEFRAME);
  const [quotes, setQuotes] = useState<Record<string, CryptoQuote>>({});
  const [candlesSet, setCandlesSet] = useState<CryptoCandleSet | undefined>();
  const [restError, setRestError] = useState<string | undefined>();
  const [feedStatus, setFeedStatus] = useState<FeedStatus>("connecting");
  const [lastEventAt, setLastEventAt] = useState<number | undefined>();
  const [scan, setScan] = useState<ScanState>({});
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [alerts, setAlerts] = useState<TradeAlert[]>([]);
  const [bt, setBt] = useState<{ key: string; stats: BacktestStats } | undefined>(undefined);
  const [btBusy, setBtBusy] = useState(false);
  const [btAll, setBtAll] = useState<
    { timeframe: Timeframe; rows: { symbol: string; stats: BacktestStats }[] } | undefined
  >(undefined);
  const [btAllBusy, setBtAllBusy] = useState(false);
  const [tournament, setTournament] = useState<
    { key: string; rows: { label: string; stats: BacktestStats }[] } | undefined
  >(undefined);
  const [tournamentBusy, setTournamentBusy] = useState(false);
  const [notifyOn, setNotifyOn] = useState(false);
  const [news, setNews] = useState<{ events: CalendarEvent[]; error?: string }>({ events: [] });
  const [now, setNow] = useState(0);
  const prevTradesRef = useRef<Map<string, TradeRecord>>(new Map());
  const seededRef = useRef(false);

  // Journal lives in localStorage — load once on mount (deferred so the
  // state write isn't synchronous inside the effect body).
  useEffect(() => {
    const id = setTimeout(() => {
      setTrades(loadTrades());
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        setNotifyOn(true);
      }
    }, 0);
    return () => clearTimeout(id);
  }, []);

  /** Apply a journal mutation and persist when it actually changed anything. */
  const updateTrades = useCallback((fn: (list: TradeRecord[]) => TradeRecord[]) => {
    setTrades((prev) => {
      const next = fn(prev);
      if (next !== prev) saveTrades(next);
      return next;
    });
  }, []);

  // The global scan reads open trades' timeframes without re-subscribing —
  // legacy positions on non-entry timeframes must still be managed.
  const tradesRef = useRef(trades);
  useEffect(() => {
    tradesRef.current = trades;
  }, [trades]);

  // News events arrive asynchronously — the scan reads them via a ref so
  // it doesn't re-subscribe on every calendar tick.
  const newsRef = useRef(news.events);
  useEffect(() => {
    newsRef.current = news.events;
  }, [news.events]);

  const pendingCandle = useRef<Candle | undefined>(undefined);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const feedRef = useRef<{ close(): void } | undefined>(undefined);

  const symbolInfo = venue.symbolInfo(symbol) ?? venue.symbols[0];
  const precision = symbolInfo.pricePrecision;

  const switchVenue = (next: VenueId) => {
    if (next === venueId) return;
    setVenueId(next);
    setSymbol(VENUES[next].defaultSymbol);
    setQuotes({});
    setCandlesSet(undefined);
    setRestError(undefined);
    setScan({});
  };

  const switchSymbol = (next: string) => {
    if (next === symbol) return;
    setSymbol(next);
    setCandlesSet(undefined);
    setRestError(undefined);
    setScan({});
  };

  const switchTimeframe = (next: Timeframe) => {
    if (next === timeframe) return;
    setTimeframe(next);
    setCandlesSet(undefined);
    setRestError(undefined);
  };

  // Coalesced stream-candle application: replaces the forming bar, appends a
  // new bar when the candle's open time advances, repairs a missed bar in
  // place. Provider closed-flag only accelerates the flush.
  const applyStreamCandle = useCallback((candle: Candle) => {
    setCandlesSet((prev) => {
      if (prev === undefined || prev.candles.length === 0) return prev;
      const arr = prev.candles.slice();
      const last = arr[arr.length - 1];
      if (candle.time > last.time) arr.push(candle);
      else if (candle.time === last.time) arr[arr.length - 1] = candle;
      else {
        const idx = arr.findIndex((c) => c.time === candle.time);
        if (idx < 0) return prev;
        arr[idx] = candle;
      }
      return { ...prev, candles: arr, hasFormingCandle: true };
    });
  }, []);

  const flushCandle = useCallback(() => {
    flushTimer.current = undefined;
    const candle = pendingCandle.current;
    pendingCandle.current = undefined;
    if (candle !== undefined) applyStreamCandle(candle);
  }, [applyStreamCandle]);

  const onStreamCandle = useCallback(
    (candle: Candle, isClosed: boolean) => {
      pendingCandle.current = candle;
      if (isClosed) {
        if (flushTimer.current !== undefined) clearTimeout(flushTimer.current);
        flushCandle();
      } else if (flushTimer.current === undefined) {
        flushTimer.current = setTimeout(flushCandle, CANDLE_FLUSH_MS);
      }
    },
    [flushCandle],
  );

  // Seed quotes once per venue; the stream keeps them fresh afterwards.
  // (Venue switches already clear `quotes` via the handler — no reset here.)
  useEffect(() => {
    let cancelled = false;
    void VENUES[venueId].fetchQuotes().then((res) => {
      if (cancelled || !res.ok) return;
      setQuotes(Object.fromEntries(res.data.map((q) => [q.symbol, q])));
    });
    return () => {
      cancelled = true;
    };
  }, [venueId]);

  // Seed candle history for the selected pair/timeframe. Selection handlers
  // clear `candlesSet`/`restError`, so this effect only fetches and applies.
  useEffect(() => {
    let cancelled = false;
    void venue.fetchKlines(symbol, timeframe).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setCandlesSet({
          symbol,
          timeframe,
          candles: res.data.candles,
          hasFormingCandle: res.data.hasFormingCandle,
          warnings: res.data.warnings,
        });
      } else {
        setRestError(`${res.error.message}${res.error.detail ? ` — ${res.error.detail}` : ""}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [venue, symbol, timeframe]);

  // Live socket for the selected venue/symbol/timeframe.
  useEffect(() => {
    feedRef.current?.close();
    const feed = venue.connect({
      symbol,
      timeframe,
      onQuote: (quote) =>
        setQuotes((prev) => ({ ...prev, [quote.symbol]: quote })),
      onCandle: onStreamCandle,
      onStatus: (status, at) => {
        setFeedStatus(status);
        if (at !== undefined) setLastEventAt(at);
      },
    });
    feedRef.current = feed;
    return () => {
      feed.close();
      if (feedRef.current === feed) feedRef.current = undefined;
    };
  }, [venue, symbol, timeframe, onStreamCandle]);

  // Intraday scan: analyze the other scan timeframes over REST, refreshed
  // every minute. The selected timeframe's row comes from the live analysis.
  // Live marks: last close per venue|symbol|tf, fed by every kline fetch
  // (global scan, MTF scan, live chart) — drives floating P&L per trade.
  const [marks, setMarks] = useState<Record<string, number>>({});
  // Why each pair/timeframe did not book this scan tick — makes a quiet
  // market visible instead of looking like a dead engine.
  const [scanWhy, setScanWhy] = useState<{ at: number; cells: Record<string, string> } | undefined>(
    undefined,
  );
  const scanWhyRef = useRef<Record<string, string>>({});

  // Entry strategy — confluence (indicators + structure) or Victor (pure
  // price action: pin bar at MTF-aligned supply/demand). Persisted so a
  // refresh doesn't silently switch the book back.
  const [strategy, setStrategy] = useState<"confluence" | "victor">(() =>
    typeof window !== "undefined" && window.localStorage.getItem("crypto-strategy") === "victor"
      ? "victor"
      : "confluence",
  );
  const strategyRef = useRef(strategy);
  useEffect(() => {
    strategyRef.current = strategy;
    try {
      window.localStorage.setItem("crypto-strategy", strategy);
    } catch {
      /* private mode — keep working */
    }
  }, [strategy]);
  // Latest closed candles per symbol for Victor: 1m entry + 5m/15m zone
  // context. State (not a ref): the chart-zone memo reads it during render.
  const [ctxSets, setCtxSets] = useState<
    Record<string, { m1?: Candle[]; m5?: Candle[]; m15?: Candle[] }>
  >({});

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      for (const tf of SCAN_TIMEFRAMES) {
        if (tf === timeframe) continue;
        void venue.fetchKlines(symbol, tf).then((res) => {
          if (cancelled) return;
          const rowAnalysis = res.ok ? analyzeCandles(res.data.candles) : undefined;
          setScan((prev) => ({
            ...prev,
            [tf]: res.ok
              ? { state: "ready", analysis: rowAnalysis }
              : { state: "error", error: res.error.message },
          }));
          // Management only — entry selection is centralized in the
          // global scan (one trade per pair, best timeframe wins).
          if (res.ok && res.data.candles.length > 0) {
            const set = res.data.candles;
            const closed = res.data.hasFormingCandle ? set.slice(0, -1) : set;
            const key = journalKey(venue.id, symbol, tf);
            setMarks((m) => ({ ...m, [key]: set[set.length - 1].close }));
            updateTrades((prev) =>
              prev.map((t) =>
                t.status === "open" && tradeKey(t) === key ? evaluateTrade(t, closed) : t,
              ),
            );
          }
        });
      }
    };
    run();
    const timer = setInterval(run, SCAN_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [venue, symbol, timeframe, updateTrades]);

  // Global scan: every listed pair on the trading venues (Binance Spot +
  // NSE/BSE India — kept fully separate markets), every minute. BOTH
  // engines run in parallel: Victor takes 1m pin scalps at 5m/15m zones,
  // Confluence takes 5m entries with 15m/1h context. Each pair holds at
  // most one trade PER STRATEGY — two per pair, pairs unlimited.
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      for (const vId of VENUE_ORDER) {
        const v = VENUES[vId];
        for (const s of v.symbols) {
          const sym = s.symbol;
          // Entries trade Binance Spot + NSE/BSE indices — Kraken pairs
          // duplicate Binance markets, so that venue is manage-only
          // (legacy trades still resolve on their own timeframe's bars).
          const trading = vId !== "kraken";
          const legacyTfs = tradesRef.current
            .filter((t) => t.status === "open" && t.venue === vId && t.symbol === sym)
            .map((t) => t.timeframe);
          if (!trading && legacyTfs.length === 0) continue;
          // Both engines scanned: Victor needs 1m/5m/15m, Confluence needs
          // 5m/15m/1h — the union covers both, deduped below.
          const entryTfs = ["1m", "5m", "15m", BIAS_TIMEFRAME] as const;
          const fetchTfs = [
            ...new Set<Timeframe>([...(trading ? entryTfs : []), ...legacyTfs]),
          ];
          void Promise.all(
            fetchTfs.map((tf) => v.fetchKlines(sym, tf).then((res) => ({ tf, res }))),
          ).then((rows) => {
            if (cancelled) return;
            // News guard: a high-impact USD release ±15 min vetoes crypto
            // entries — it doesn't gate NSE index trading.
            const newsOn =
              vId === "binance" && newsBlockEvent(newsRef.current, Date.now()) !== undefined;
            const candidates: {
              venue: string;
              symbol: string;
              timeframe: Timeframe;
              signal: TradeSignal;
              barTime: number;
              edge?: number;
              strategy?: string;
              sessionUtc?: readonly [number, number];
            }[] = [];
            const sessionUtc = vId === "india" ? INDIA_SESSION_UTC : undefined;
            // One slot per strategy per pair — Victor and Confluence are
            // independent books; a running Victor scalp doesn't block a
            // Confluence entry on the same pair.
            const slotBusy = (strat: string) =>
              trading &&
              tradesRef.current.some(
                (t) =>
                  t.status === "open" &&
                  t.venue === vId &&
                  t.symbol === sym &&
                  (t.strategy ?? "confluence") === strat,
              );
            const tfSets = new Map<string, Candle[]>();
            const markEntries: Record<string, number> = {};
            // Higher-timeframe bias first — never take a scalp against the
            // 1h trend. "ranging" or unreadable HTF passes no judgment.
            let bias: Direction | "ranging" | undefined;
            const biasRow = rows.find((r) => r.tf === BIAS_TIMEFRAME);
            if (biasRow !== undefined && biasRow.res.ok && biasRow.res.data.candles.length > 0) {
              const s = biasRow.res.data.candles;
              const c = biasRow.res.data.hasFormingCandle ? s.slice(0, -1) : s;
              bias = analyzeCandles(c)?.trend.direction;
            }
            for (const { tf, res } of rows) {
              if (!res.ok || res.data.candles.length === 0) continue;
              const set = res.data.candles;
              const closed = res.data.hasFormingCandle ? set.slice(0, -1) : set;
              const key = journalKey(vId, sym, tf);
              tfSets.set(key, closed);
              markEntries[key] = set[set.length - 1].close;
            }
            // Entries are decided on CLOSED bars only — a pro waits for
            // the candle to print, never trades a half-formed signal.
            if (trading) {
              // ---- Victor scalp — 1m pin bar at a 5m+15m S/D zone ----
              const m1 = tfSets.get(journalKey(vId, sym, "1m"));
              const m5 = tfSets.get(journalKey(vId, sym, "5m"));
              const m15v = tfSets.get(journalKey(vId, sym, "15m"));
              const vCell = `${sym} vic`;
              const setup =
                m1 !== undefined ? victorSignal(m1, [m5 ?? [], m15v ?? []]) : undefined;
              if (m1 === undefined || setup === undefined) {
                scanWhyRef.current[vCell] = m1 === undefined ? "no data" : "no pin/zone setup";
              } else if (newsOn) {
                scanWhyRef.current[vCell] = "news blackout";
              } else if (slotBusy("victor")) {
                scanWhyRef.current[vCell] = "victor position open";
              } else {
                scanWhyRef.current[vCell] = `victor ${setup.signal.confidence}pts`;
                candidates.push({
                  venue: vId,
                  symbol: sym,
                  timeframe: "1m",
                  signal: setup.signal,
                  barTime: m1[m1.length - 1].time,
                  edge: 0,
                  strategy: "victor",
                  sessionUtc,
                });
              }
              setCtxSets((p) => ({
                ...p,
                [sym]: { m1, m5, m15: m15v },
              }));

              // ---- Confluence — 5m entries; 15m SMC + 1h bias context ----
              {
                const closed5 = tfSets.get(journalKey(vId, sym, "5m"));
                const cell = `${sym} con`;
                const a = closed5 !== undefined ? analyzeCandles(closed5) : undefined;
                if (closed5 === undefined || a === undefined) {
                  scanWhyRef.current[cell] = "warming up";
                } else if (a.signal.direction === "wait") {
                  scanWhyRef.current[cell] =
                    a.trend.direction === "ranging"
                      ? "ranging"
                      : `weak ${a.signal.confidence}pts`;
                } else if (slotBusy("confluence")) {
                  scanWhyRef.current[cell] = "confluence position open";
                } else {
                  const dir = a.signal.direction;
                  const lastBar = closed5[closed5.length - 1].time;
                  const biasBlocks =
                    bias === "bullish" || bias === "bearish" ? bias !== dir : false;
                  // SMC gate on the 15m context — structure must not
                  // contradict the 5m signal.
                  const ctx15 = tfSets.get(journalKey(vId, sym, "15m"));
                  const tech =
                    ctx15 !== undefined ? analyzeTechnicals(ctx15, sym, "15m") : undefined;
                  // Sideways is judged on the ENTRY tape only — the 5m ER
                  // veto inside analyzeCandles already handled that. A 15m
                  // "range" is just consolidation; only a 15m trend that
                  // actively disagrees vetoes the 5m signal.
                  const smcBlocks =
                    tech !== undefined &&
                    ((dir === "bullish" && tech.trend === "downtrend") ||
                      (dir === "bearish" && tech.trend === "uptrend"));
                  if (biasBlocks) {
                    scanWhyRef.current[cell] = `vs 1h ${bias}`;
                  } else if (smcBlocks) {
                    scanWhyRef.current[cell] = `smc ${tech?.trend}`;
                  } else if (newsOn) {
                    scanWhyRef.current[cell] = "news blackout";
                  } else {
                    scanWhyRef.current[cell] = `${dir.slice(0, 4)} ${a.signal.confidence}pts`;
                  }
                  if (!biasBlocks && !smcBlocks && !newsOn) {
                    // Liquidity edge: a fresh confirmed 15m sweep on the
                    // supporting side is where reversals are born — worth
                    // +0.5R in the ranking.
                    const sweepSupport =
                      tech !== undefined &&
                      tech.sweeps.some(
                        (sw) =>
                          (dir === "bullish" ? sw.side === "sell_side" : sw.side === "buy_side") &&
                          lastBar - Date.parse(sw.at) < 20 * timeframeMs("15m"),
                      );
                    candidates.push({
                      venue: vId,
                      symbol: sym,
                      timeframe: "5m",
                      signal: a.signal,
                      barTime: lastBar,
                      edge: sweepSupport ? 0.5 : 0,
                      sessionUtc,
                    });
                  }
                }
              }
            }
            updateTrades((prev) => {
              // Manage every open trade of this pair on its own timeframe's bars.
              let next = prev.map((t) => {
                if (t.status !== "open") return t;
                const set = tfSets.get(tradeKey(t));
                return set === undefined ? t : evaluateTrade(t, set);
              });
              // Book each candidate — registerSignal owns the
              // per-(pair, strategy) slot guard, so Victor and Confluence
              // can enter the same pair in the same tick.
              const now2 = Date.now();
              for (const c of candidates) {
                next = registerSignal(next, { ...c, now: now2 }).trades;
              }
              return next;
            });
            setMarks((m) => ({ ...m, ...markEntries }));
            setScanWhy({ at: Date.now(), cells: { ...scanWhyRef.current } });
          });
        }
      }
    };
    run();
    const timer = setInterval(run, SCAN_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [updateTrades]);

  const candles = candlesSet?.candles;
  const analysis = useMemo(
    () => (candles !== undefined ? analyzeCandles(candles) : undefined),
    [candles],
  );

  // Institutional engine context — structure/liquidity/FVGs, causal only.
  const technicals = useMemo(
    () =>
      candles !== undefined ? analyzeTechnicals(candles, symbol, timeframe) : undefined,
    [candles, symbol, timeframe],
  );

  // High-impact economic calendar (Forex Factory mirror) — every 15 min.
  // `now` is a state tick (render must stay pure — no Date.now() there).
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/economic-calendar")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`calendar ${r.status}`))))
        .then((d: { events?: CalendarEvent[] }) => {
          if (!cancelled) {
            setNews({ events: d.events ?? [] });
            setNow(Date.now());
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setNews({ events: [], error: e instanceof Error ? e.message : "unavailable" });
          }
        });
    };
    load();
    const timer = setInterval(load, 15 * 60_000);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(tick);
    };
  }, []);

  // Trade-event alerts — diff the journal on every change. Deferred (lint
  // forbids synchronous setState in effects); first run only seeds.
  useEffect(() => {
    const id = setTimeout(() => {
      const prev = prevTradesRef.current;
      const events: TradeAlert[] = [];
      if (seededRef.current) {
        for (const t of trades) {
          const p = prev.get(t.id);
          const pr = VENUES[t.venue as VenueId]?.symbolInfo(t.symbol)?.pricePrecision ?? 2;
          if (p === undefined && t.status === "open") {
            events.push({
              id: `${t.id}:open`,
              at: Date.now(),
              tone: t.direction,
              text: `New ${t.direction === "bullish" ? "BUY" : "SELL"} ${t.symbol} ${t.timeframe} @ ${fmtPrice(t.entry, pr)} — SL ${fmtPrice(t.stopLoss, pr)}`,
            });
          } else if (p !== undefined && p.status === "open" && t.status === "closed") {
            const r = t.realizedR ?? 0;
            events.push({
              id: `${t.id}:closed`,
              at: Date.now(),
              tone: r > 0.01 ? "bullish" : r < -0.01 ? "bearish" : "neutral",
              text: `Closed ${t.symbol} ${t.timeframe}: ${t.exitReason} @ ${fmtPrice(t.exitPrice, pr)} (${r >= 0 ? "+" : ""}${r}R)`,
            });
          }
        }
      }
      seededRef.current = true;
      prevTradesRef.current = new Map(trades.map((t) => [t.id, t]));
      if (events.length > 0) {
        setAlerts((a) => [...events, ...a].slice(0, 20));
        for (const e of events) {
          try {
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              new Notification("Trade alert", { body: e.text });
            }
          } catch {
            // Notification constructor can throw on some platforms — non-fatal.
          }
        }
      }
    }, 0);
    return () => clearTimeout(id);
  }, [trades]);

  const enableAlerts = () => {
    if (typeof Notification === "undefined") return;
    void Notification.requestPermission().then((p) => setNotifyOn(p === "granted"));
  };

  // Carry the open trade on this market forward over newly closed bars.
  // Entries are centralized in the global scan (one trade per pair, best
  // timeframe); this effect only keeps management up to tick speed.
  // Deferred: journal bookkeeping isn't render-critical and the lint rules
  // forbid synchronous setState inside an effect body.
  useEffect(() => {
    if (candles === undefined || candles.length === 0) return;
    const closed = candlesSet?.hasFormingCandle ? candles.slice(0, -1) : candles;
    const key = journalKey(venueId, symbol, timeframe);
    const id = setTimeout(() => {
      setMarks((m) => ({ ...m, [key]: candles[candles.length - 1].close }));
      updateTrades((prev) =>
        prev.map((t) =>
          t.status === "open" && tradeKey(t) === key ? evaluateTrade(t, closed) : t,
        ),
      );
    }, 0);
    return () => clearTimeout(id);
  }, [candles, candlesSet?.hasFormingCandle, venueId, symbol, timeframe, updateTrades]);

  const currentKey = journalKey(venueId, symbol, timeframe);
  const openTrade = trades.find((t) => t.status === "open" && tradeKey(t) === currentKey);
  const openTrades = trades.filter((t) => t.status === "open");
  const stats = dailyStats(trades);
  const byPair = symbolStats(trades);
  const balance = equityOf(trades); // realized equity — closed trades only
  const closedTrades = [...trades]
    .filter((t) => t.status === "closed")
    .sort((a, b) => (b.exitTime ?? 0) - (a.exitTime ?? 0))
    .slice(0, 8);
  const lastClose = candles?.[candles.length - 1]?.close;
  const markOf = (t: TradeRecord): number | undefined =>
    tradeKey(t) === currentKey && lastClose !== undefined
      ? lastClose
      : marks[tradeKey(t)];
  const floating = floatingPnlUsd(trades, markOf);
  const liveEquity = Math.round((balance + floating) * 100) / 100;

  // High-impact events: released in the last 30m or coming within 48h.
  const upcomingNews = news.events
    .filter((e) => e.impact === "High")
    .map((e) => ({ ...e, ms: Date.parse(e.time) }))
    .filter((e) => e.ms > now - 30 * 60_000 && e.ms < now + 48 * 3_600_000)
    .sort((a, b) => a.ms - b.ms)
    .slice(0, 6);
  const newsRisk = upcomingNews.find((e) => Math.abs(e.ms - now) <= 60 * 60_000);

  // Victor live readout for the charted symbol — the same evaluation the
  // scan runs: 1m pin + follow-up against 5m/15m strong zones.
  const victorCtx = ctxSets[symbol];
  const victorLive = useMemo(() => {
    if (strategy !== "victor" || victorCtx?.m1 === undefined) return undefined;
    return victorSignal(victorCtx.m1, [victorCtx.m5 ?? [], victorCtx.m15 ?? []]);
  }, [strategy, victorCtx]);
  const victorLastPin =
    victorCtx?.m1 !== undefined && victorCtx.m1.length >= 2
      ? pinBar(victorCtx.m1[victorCtx.m1.length - 2])
      : undefined;

  // Sideways regime is judged on the ENTRY tape only — 1m for Victor,
  // 5m for Confluence — never the charted or context timeframe. Clear
  // zones inside a higher-TF consolidation still mean a live entry tape.
  const entryTf: Timeframe = strategy === "victor" ? "1m" : "5m";
  const entryTape =
    entryTf === timeframe
      ? candles
      : ctxSets[symbol]?.[strategy === "victor" ? "m1" : "m5"];
  const entryRegime = useMemo(
    () =>
      entryTape !== undefined && entryTape.length >= 60
        ? analyzeCandles(entryTape)?.trend.direction
        : undefined,
    [entryTape],
  );

  // Victor zones for the charted symbol — measured on 5m+15m, strong
  // only where the two context timeframes' zones overlap.
  const victorZones = useMemo(() => {
    if (strategy !== "victor") return [];
    const ctx = ctxSets[symbol];
    if (ctx === undefined) return [];
    return markStrongAcross(
      [ctx.m5, ctx.m15].filter((c): c is Candle[] => c !== undefined).map(swingZones),
    );
  }, [strategy, symbol, ctxSets]);

  const signalOverlays = useMemo<ChartOverlay[]>(() => {
    if (!analysis) return [];
    const out: ChartOverlay[] = [];
    if (strategy === "victor") {
      victorZones.forEach((z, i) => {
        out.push({
          kind: "zone",
          id: `vz-${i}`,
          layer: "zones",
          zoneType: z.kind,
          upper: z.upper,
          lower: z.lower,
          label: `${z.strong ? "Strong " : ""}${z.kind} zone`,
        });
      });
    } else {
      analysis.zones.forEach((z, i) => {
      out.push({
        kind: "zone",
        id: `zone-${i}`,
        layer: "zones",
        zoneType: z.kind,
        upper: z.upper,
        lower: z.lower,
        label: z.kind === "demand" ? "Demand zone" : "Supply zone",
      });
    });
    }
    const s = analysis.signal;
    if (s.direction !== "wait") {
      const dir = s.direction;
      if (s.entry !== undefined) {
        out.push({
          kind: "level",
          id: "sig-entry",
          layer: "structure",
          price: s.entry,
          label: "Entry",
          direction: dir,
        });
      }
      if (s.stopLoss !== undefined) {
        out.push({
          kind: "level",
          id: "sig-sl",
          layer: "liquidity",
          price: s.stopLoss,
          label: "Stop loss",
          direction: dir,
        });
      }
      s.targets.forEach((t, i) => {
        out.push({
          kind: "level",
          id: `sig-tp-${i}`,
          layer: "structure",
          price: t.price,
          label: `${t.label} · ${t.rr}R`,
          direction: dir,
        });
      });
    }
    // A running paper trade draws its live stop — the trailing SL after TP1.
    if (openTrade) {
      out.push({
        kind: "level",
        id: "journal-live-sl",
        layer: "liquidity",
        price: openTrade.stopLoss,
        label: openTrade.tp1Hit ? "Trail SL" : "Open SL",
        direction: openTrade.direction,
      });
    }
    return out;
  }, [analysis, openTrade, strategy, victorZones]);

  const signalMarkers = useMemo<ChartMarker[]>(() => {
    const s = analysis?.signal;
    const lastCandle = candles?.[candles.length - 1];
    if (!analysis || s === undefined || s.direction === "wait" || lastCandle === undefined) {
      return [];
    }
    return [
      {
        time: lastCandle.time,
        position: s.direction === "bullish" ? "belowBar" : "aboveBar",
        shape: s.direction === "bullish" ? "arrowUp" : "arrowDown",
        color: s.direction,
        text: `${s.direction === "bullish" ? "BUY" : "SELL"} ${s.confidence}pts`,
      },
    ];
  }, [analysis, candles]);

  const feed = FEED_META[feedStatus];
  const FeedIcon = feed.icon;
  const signal = analysis?.signal;
  const signalMeta = signal ? DIR_META[signal.direction] : DIR_META.wait;
  const SignalIcon = signalMeta.icon;

  const scanRowFor = (tf: Timeframe): ScanRow =>
    tf === timeframe
      ? { state: "ready", analysis }
      : scan[tf] ?? { state: "loading" };

  return (
    <div className="space-y-5">
      {/* Venue + feed status */}
      <div className="flex flex-wrap items-center gap-2">
        {VENUE_ORDER.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => switchVenue(id)}
            aria-pressed={venueId === id}
            className={cn(
              "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
              venueId === id
                ? "border-accent bg-accent/10 text-foreground"
                : "border-border text-subtle-foreground hover:bg-surface-hover hover:text-foreground",
            )}
          >
            {VENUES[id].label}
          </button>
        ))}
        <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-subtle-foreground">
          <FeedIcon
            className={cn("size-3.5", feedStatus === "connecting" && "animate-spin")}
            aria-hidden="true"
          />
          <Badge tone={feed.tone}>{feed.label}</Badge>
          {lastEventAt !== undefined && (
            <span className="numeric">
              last update {new Date(lastEventAt).toLocaleTimeString()}
            </span>
          )}
        </span>
      </div>

      {/* Pair + timeframe selectors */}
      <div className="flex flex-wrap items-center gap-2">
        {venue.symbols.map((s) => {
          const quote = quotes[s.symbol];
          return (
            <button
              key={s.symbol}
              type="button"
              onClick={() => switchSymbol(s.symbol)}
              aria-pressed={symbol === s.symbol}
              className={cn(
                "rounded-md border px-3 py-1.5 text-left transition-colors",
                symbol === s.symbol
                  ? "border-accent bg-accent/10"
                  : "border-border hover:bg-surface-hover",
              )}
            >
              <span className="block text-sm font-medium text-foreground">{s.label}</span>
              <span className="numeric block text-xs text-subtle-foreground">
                {quote ? `${fmtPrice(quote.last, s.pricePrecision)} ${fmtSignedPct(quote.changePct24h)}` : "—"}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {venue.intervals.map((i) => (
          <button
            key={i.timeframe}
            type="button"
            onClick={() => switchTimeframe(i.timeframe)}
            aria-pressed={timeframe === i.timeframe}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              timeframe === i.timeframe
                ? "border-accent bg-accent/10 text-foreground"
                : "border-border text-subtle-foreground hover:bg-surface-hover hover:text-foreground",
            )}
          >
            {i.label}
          </button>
        ))}
      </div>

      {/* Chart view — which engine's overlays/zones to draw. BOTH engines
          scan and trade every listed pair independently of this pick. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-subtle-foreground">Chart strategy</span>
        {(
          [
            { id: "confluence", label: "Confluence · 5m" },
            { id: "victor", label: "Victor — pin bar at S/D zone · 1m" },
          ] as const
        ).map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setStrategy(m.id)}
            aria-pressed={strategy === m.id}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              strategy === m.id
                ? "border-accent bg-accent/10 text-foreground"
                : "border-border text-subtle-foreground hover:bg-surface-hover hover:text-foreground",
            )}
          >
            {m.label}
          </button>
        ))}
        <span className="text-xs text-subtle-foreground">
          both engines trade in parallel — one open slot each per pair
        </span>
        {entryRegime !== undefined && (
          <Badge tone={entryRegime === "ranging" ? "neutral" : "developing"}>
            {entryTf} {entryRegime === "ranging" ? "sideways" : entryRegime}
          </Badge>
        )}
      </div>

      {/* Trading sessions — the entry windows each market obeys */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-subtle-foreground">
        <span className="font-medium text-foreground">Sessions</span>
        {(
          [
            { label: "Crypto EU/US", w: ENTRY_SESSION_UTC, range: "06:00–22:00 UTC" },
            { label: "NSE/BSE India", w: INDIA_SESSION_UTC, range: "04:00–10:00 UTC · 09:30–15:30 IST" },
          ] as const
        ).map((s) => {
          const h = new Date(now).getUTCHours();
          const open = h >= s.w[0] && h < s.w[1];
          return (
            <span key={s.label} className="inline-flex items-center gap-1.5">
              <span
                className={cn("size-1.5 rounded-full", open ? "bg-bullish" : "bg-bearish")}
                aria-hidden="true"
              />
              {s.label} {s.range}
              <span className={open ? "text-bullish" : "text-bearish"}>
                {open ? "open" : "closed"}
              </span>
            </span>
          );
        })}
        <span className="numeric">{new Date(now).toISOString().slice(11, 16)} UTC</span>
      </div>

      {/* Live chart with signal overlays */}
      <Card>
        <CardHeader
          title={`${symbolInfo.label} · ${venue.intervals.find((i) => i.timeframe === timeframe)?.label ?? timeframe}`}
          description={`${venue.label} public feed — candles, zones, and signal levels update live.`}
        />
        {restError !== undefined && (
          <Notice tone="warning" title="Feed error" className="mb-3">
            {restError}
          </Notice>
        )}
        {candles === undefined || candles.length === 0 ? (
          <div className="flex min-h-[420px] items-center justify-center text-sm text-subtle-foreground">
            {restError === undefined ? "Loading candles…" : "No candle data."}
          </div>
        ) : (
          <div className="min-h-[420px]">
            <CandlestickChart
              candles={candles}
              timeframe={timeframe}
              overlays={signalOverlays}
              markers={signalMarkers}
              pricePrecision={precision}
            />
          </div>
        )}
        <p className="mt-3 text-xs text-subtle-foreground">
          Prices are {venue.label}-specific — other venues may trade at different levels.
          {candlesSet?.hasFormingCandle ? " The right-most bar is still forming." : ""}
        </p>
      </Card>

      {/* Victor detail — shown when the strategy is selected */}
      {strategy === "victor" && (
        <Card>
          <CardHeader
            title="Victor scalp — pin bar at supply/demand"
            description="Pure price action. Zones measured on 5m + 15m; a zone is STRONG when both timeframes' zones overlap. Entry fires on a 1m pin bar whose tail rejects a strong zone, confirmed by the next candle. Stop = pin extreme, trailing to the 2nd candle back; target = next opposing zone."
            action={
              victorLive !== undefined && (
                <Badge tone={DIR_META[victorLive.signal.direction as Direction].tone}>
                  {victorLive.signal.direction === "bullish" ? "BUY" : "SELL"} ·{" "}
                  {victorLive.signal.confidence} pts
                </Badge>
              )
            }
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              { label: "Entry", value: victorLive?.signal.entry },
              { label: "Stop (pin extreme)", value: victorLive?.signal.stopLoss },
              { label: "TP1 · next zone", value: victorLive?.signal.targets[0]?.price },
              { label: "TP2 · runner", value: victorLive?.signal.targets[1]?.price },
              { label: "RR", value: victorLive?.signal.riskReward, suffix: "R" },
            ].map((f) => (
              <div key={f.label}>
                <div className="text-xs text-subtle-foreground">{f.label}</div>
                <div className="numeric mt-0.5 text-sm text-foreground">
                  {f.value === undefined ? "—" : `${fmtPrice(f.value, precision)}${f.suffix ?? ""}`}
                </div>
              </div>
            ))}
          </div>
          {victorLive === undefined && (
            <p className="mt-3 text-xs text-subtle-foreground">
              No confirmed setup right now —{" "}
              {victorLastPin !== undefined
                ? `a ${victorLastPin} pin bar printed on 1m but not at a strong zone or unconfirmed`
                : "no qualifying pin bar on the last closed 1m candle"}
              .
            </p>
          )}
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-xs text-subtle-foreground">
              Supply/demand zones — 5m+15m overlap = strong
            </p>
            {victorZones.length === 0 ? (
              <p className="mt-0.5 text-sm text-muted-foreground">Waiting for zone data…</p>
            ) : (
              <ul className="mt-1 space-y-0.5 text-xs">
                {victorZones.slice(0, 6).map((z, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2">
                    <Badge tone={z.kind === "demand" ? "bullish" : "bearish"}>
                      {z.kind}
                    </Badge>
                    <span className="numeric text-foreground">
                      {fmtPrice(z.lower, precision)}–{fmtPrice(z.upper, precision)}
                    </span>
                    {z.strong && <Badge tone="developing">STRONG</Badge>}
                    {z.touches > 0 && (
                      <span className="text-subtle-foreground">{z.touches} touches</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}

      {/* Signal detail — entry / SL / targets / reasoning / points */}
      <Card>
        <CardHeader
          title="Signal analysis"
          description="Deterministic read of the candles on the chart — same data, auditable factors."
          action={
            analysis !== undefined && (
              <Badge tone={signalMeta.tone}>
                <SignalIcon className="mr-1 inline size-3.5" aria-hidden="true" />
                {signalMeta.label}
                {signal && signal.direction !== "wait" ? ` · ${signal.confidence} pts` : ""}
              </Badge>
            )
          }
        />
        {analysis === undefined || signal === undefined ? (
          <p className="text-sm text-subtle-foreground">
            {candles === undefined ? "Waiting for candles…" : "Not enough bars to analyze yet."}
          </p>
        ) : (
          <div className="space-y-4">
            {newsRisk !== undefined && (
              <Badge tone="developing" className="w-fit">
                News risk — {newsRisk.title} ({newsRisk.currency}){" "}
                {newsRisk.ms > now
                  ? `in ${Math.max(1, Math.round((newsRisk.ms - now) / 60_000))}m`
                  : "just released"}
              </Badge>
            )}
            {/* Levels */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[
                { label: "Entry", value: signal.entry },
                { label: "Stop loss", value: signal.stopLoss },
                { label: "TP1", value: signal.targets[0]?.price },
                { label: "TP2", value: signal.targets[1]?.price },
                {
                  label: "Risk : reward",
                  value: undefined,
                  text:
                    signal.riskReward !== undefined ? `${signal.riskReward}R` : "—",
                },
              ].map((cell) => (
                <div key={cell.label} className="rounded-md border border-border p-3">
                  <div className="text-xs text-subtle-foreground">{cell.label}</div>
                  <div className="numeric mt-1 text-sm font-semibold text-foreground">
                    {cell.text ?? fmtPrice(cell.value, precision)}
                  </div>
                </div>
              ))}
            </div>

            {/* Points breakdown */}
            <div>
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-sm font-medium text-foreground">Confluence points</h3>
                <span className="numeric text-sm font-semibold text-foreground">
                  {signal.confidence}/100
                </span>
              </div>
              <ul className="divide-y divide-border rounded-md border border-border">
                {signal.factors.map((f) => (
                  <li key={f.label} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="w-28 shrink-0 font-medium text-foreground">{f.label}</span>
                    <span
                      className={cn(
                        "numeric w-12 shrink-0 text-right font-semibold",
                        f.agrees ? "text-bullish" : "text-subtle-foreground",
                      )}
                    >
                      {f.points}/{f.weight}
                    </span>
                    <span className="truncate text-subtle-foreground">{f.note}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-subtle-foreground">
                Points count agreeing measured factors — they are a confluence score, not a
                win-rate probability.
              </p>
            </div>

            {/* Reasoning */}
            {signal.reasons.length > 0 && (
              <div>
                <h3 className="mb-1.5 text-sm font-medium text-foreground">Why this trade</h3>
                <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
                  {signal.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            )}

            <ul className="space-y-0.5 text-xs text-subtle-foreground">
              {analysis.caveats.map((c) => (
                <li key={c}>· {c}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {/* Pro read — institutional SMC/ICT context + news risk */}
      {technicals !== undefined && (
        <Card>
          <CardHeader
            title="Pro read — SMC & price action"
            description="Market structure, liquidity and imbalances from the institutional engine suite — causal detections only, no look-ahead. Evidence to weigh beside the signal, not a second score."
          />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-xs text-subtle-foreground">Structure</p>
              <p className="mt-0.5 font-semibold capitalize text-foreground">{technicals.trend}</p>
              {technicals.lastBreak !== undefined && (
                <p className="mt-0.5 text-xs text-subtle-foreground">
                  {technicals.lastBreak.type} {technicals.lastBreak.direction} @{" "}
                  {fmtPrice(technicals.lastBreak.price, precision)}
                  {technicals.lastBreak.failed ? " (failed)" : ""}
                </p>
              )}
            </div>
            <div>
              <p className="text-xs text-subtle-foreground">Liquidity sweeps</p>
              {technicals.sweeps.length === 0 ? (
                <p className="mt-0.5 text-sm text-muted-foreground">None confirmed</p>
              ) : (
                <ul className="mt-0.5 space-y-0.5 text-xs text-foreground">
                  {technicals.sweeps.map((sw) => (
                    <li key={`${sw.at}-${sw.level}`}>
                      {sw.side === "sell_side" ? "Sell-side" : "Buy-side"} swept @{" "}
                      {fmtPrice(sw.level, precision)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="text-xs text-subtle-foreground">Resting liquidity</p>
              {technicals.poolsAbove.length === 0 && technicals.poolsBelow.length === 0 ? (
                <p className="mt-0.5 text-sm text-muted-foreground">None tracked</p>
              ) : (
                <ul className="mt-0.5 space-y-0.5 text-xs text-foreground">
                  {technicals.poolsAbove.slice(0, 2).map((p) => (
                    <li key={`a-${p.price}`}>
                      Buyside {fmtPrice(p.price, precision)} · {p.touches}t
                    </li>
                  ))}
                  {technicals.poolsBelow.slice(0, 2).map((p) => (
                    <li key={`b-${p.price}`}>
                      Sellside {fmtPrice(p.price, precision)} · {p.touches}t
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="text-xs text-subtle-foreground">Fair value gaps</p>
              {technicals.fvgs.length === 0 ? (
                <p className="mt-0.5 text-sm text-muted-foreground">None near price</p>
              ) : (
                <ul className="mt-0.5 space-y-0.5 text-xs text-foreground">
                  {technicals.fvgs.map((f) => (
                    <li key={`${f.lower}-${f.upper}`}>
                      {f.direction === "bullish" ? "Bull" : "Bear"} FVG {fmtPrice(f.lower, precision)}–{fmtPrice(f.upper, precision)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-xs text-subtle-foreground">High-impact news — Forex Factory calendar</p>
            {upcomingNews.length === 0 ? (
              <p className="mt-0.5 text-sm text-muted-foreground">
                {news.error !== undefined
                  ? `Calendar unavailable — ${news.error}`
                  : "No high-impact events in the next 48h."}
              </p>
            ) : (
              <ul className="mt-1 space-y-1 text-xs">
                {upcomingNews.map((e) => (
                  <li key={`${e.time}-${e.title}`} className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={Math.abs(e.ms - now) <= 60 * 60_000 ? "developing" : "neutral"}
                    >
                      {e.currency}
                    </Badge>
                    <span className="text-foreground">{e.title}</span>
                    <span className="text-subtle-foreground">
                      {e.ms <= now
                        ? "just released"
                        : fmtCountdown(e.ms - now)}
                      {e.forecast !== undefined ? ` · fcst ${e.forecast}` : ""}
                      {e.previous !== undefined ? ` · prev ${e.previous}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}

      {/* Paper-trade journal — every proposed trade, carried forward on real bars */}
      <Card>
        <CardHeader
          title="Paper trades"
          description={
            "Virtual $10,000 terminal — both engines run on Binance Spot and NSE/BSE indices: Victor scalps 1m pin bars at leg–base–leg S/D zones; Confluence trades 5m with 15m structure + 1h bias. One open position per pair per strategy — pairs unlimited, no loss caps on a paper book. TP1 banks half; stops trail."
          }
          action={
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={enableAlerts}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
              >
                <Bell className="size-3.5" aria-hidden="true" />
                {notifyOn ? "Alerts on" : "Enable alerts"}
              </button>
              {trades.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    clearTrades();
                    setTrades([]);
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  Clear journal
                </button>
              )}
              <button
                type="button"
                disabled={btBusy}
                onClick={() => {
                  setBtBusy(true);
                  void Promise.all([
                    venue.fetchKlines(symbol, timeframe),
                    venue.fetchKlines(symbol, BIAS_TIMEFRAME),
                  ])
                    .then(([res, biasRes]) => {
                      if (res.ok) {
                        const closed = res.data.hasFormingCandle
                          ? res.data.candles.slice(0, -1)
                          : res.data.candles;
                        const bias =
                          biasRes.ok && biasRes.data.candles.length > 0
                            ? biasRes.data.hasFormingCandle
                              ? biasRes.data.candles.slice(0, -1)
                              : biasRes.data.candles
                            : undefined;
                        setBt({
                          key: `${venueId}|${symbol}|${timeframe}`,
                          stats: backtestCandles(closed, {
                            venue: venueId,
                            symbol,
                            timeframe,
                            smc: true,
                            bias,
                            news: newsRef.current,
                          }),
                        });
                      }
                    })
                    .finally(() => setBtBusy(false));
                }}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
              >
                {btBusy ? "Backtesting…" : "Backtest"}
              </button>
              <button
                type="button"
                disabled={btAllBusy}
                onClick={() => {
                  setBtAllBusy(true);
                  void Promise.all(
                    VENUES.binance.symbols.map((s) =>
                      Promise.all([
                        VENUES.binance.fetchKlines(s.symbol, timeframe),
                        VENUES.binance.fetchKlines(s.symbol, BIAS_TIMEFRAME),
                      ]).then(([res, biasRes]) => ({ symbol: s.symbol, res, biasRes })),
                    ),
                  )
                    .then((results) => {
                      const rows = results
                        .flatMap((r) => {
                          if (!r.res.ok || r.res.data.candles.length === 0) return [];
                          const set = r.res.data.candles;
                          const closed = r.res.data.hasFormingCandle
                            ? set.slice(0, -1)
                            : set;
                          const bias =
                            r.biasRes.ok && r.biasRes.data.candles.length > 0
                              ? r.biasRes.data.hasFormingCandle
                                ? r.biasRes.data.candles.slice(0, -1)
                                : r.biasRes.data.candles
                              : undefined;
                          return [
                            {
                              symbol: r.symbol,
                              stats: backtestCandles(closed, {
                                venue: "binance",
                                symbol: r.symbol,
                                timeframe,
                                smc: true,
                                bias,
                                news: newsRef.current,
                              }),
                            },
                          ];
                        })
                        .sort((a, b) => b.stats.netR - a.stats.netR);
                      setBtAll({ timeframe, rows });
                    })
                    .finally(() => setBtAllBusy(false));
                }}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
              >
                {btAllBusy ? "Backtesting all…" : "Backtest all"}
              </button>
              <button
                type="button"
                disabled={tournamentBusy}
                onClick={() => {
                  setTournamentBusy(true);
                  void venue
                    .fetchKlines(symbol, timeframe)
                    .then((res) => {
                      if (!res.ok) return;
                      const closed = res.data.hasFormingCandle
                        ? res.data.candles.slice(0, -1)
                        : res.data.candles;
                      const rows = STRATEGIES.map((d) => ({
                        label: d.label,
                        stats: backtestCandles(closed, {
                          venue: venueId,
                          symbol,
                          timeframe,
                          news: newsRef.current,
                          strategy: { name: d.id, signalFor: d.create() },
                        }),
                      })).sort((a, b) => b.stats.netR - a.stats.netR);
                      setTournament({
                        key: `${venueId}|${symbol}|${timeframe}`,
                        rows,
                      });
                    })
                    .finally(() => setTournamentBusy(false));
                }}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
              >
                {tournamentBusy ? "Running tournament…" : "Strategy tournament"}
              </button>
            </div>
          }
        />
        <div className="mb-4 grid gap-3 sm:grid-cols-4">
          {[
            { label: "Balance", text: fmtUsd(balance), tone: "text-foreground" },
            {
              label: "Floating P&L",
              text: fmtUsdPnl(floating),
              tone: floating >= 0 ? "text-bullish" : "text-bearish",
            },
            {
              label: "Equity",
              text: fmtUsd(liveEquity),
              tone:
                liveEquity - ACCOUNT_CAPITAL_USD >= 0 ? "text-bullish" : "text-bearish",
            },
            { label: "Open positions", text: String(openTrades.length), tone: "text-foreground" },
          ].map((tile) => (
            <div key={tile.label} className="rounded-md border border-border p-3">
              <div className="text-xs text-subtle-foreground">{tile.label}</div>
              <div className={cn("numeric mt-1 text-sm font-semibold", tile.tone)}>
                {tile.text}
              </div>
            </div>
          ))}
        </div>
        {scanWhy !== undefined && (
          <div className="mb-4 rounded-md border border-border bg-surface px-3 py-2 text-xs text-subtle-foreground">
            <span className="font-medium text-foreground">
              Scan {new Date(scanWhy.at).toISOString().slice(11, 16)} UTC
            </span>
            {entryBlockReason(
              trades,
              now,
              undefined,
              venueId === "india" ? INDIA_SESSION_UTC : ENTRY_SESSION_UTC,
            ) !== undefined && (
              <span className="text-warning">
                {" "}· entries paused —{" "}
                {entryBlockReason(
                  trades,
                  now,
                  undefined,
                  venueId === "india" ? INDIA_SESSION_UTC : ENTRY_SESSION_UTC,
                )}
              </span>
            )}
            {Object.entries(
              Object.entries(scanWhy.cells).reduce<Record<string, string[]>>((g, [cell, why]) => {
                (g[why] = g[why] ?? []).push(cell);
                return g;
              }, {}),
            ).map(([why, cells]) => (
              <span key={why}>
                {" "}· {cells.length === 1 ? cells[0] : `${cells.length} pairs`} {why}
              </span>
            ))}
          </div>
        )}
        {bt !== undefined && (
          <div className="mb-4 rounded-md border border-border bg-surface p-3 text-xs">
            <div className="mb-1 font-medium text-foreground">
              Backtest — {bt.key.split("|")[1]} {bt.key.split("|")[2]} ·{" "}
              {bt.stats.evaluatedBars} bars replayed through the live engine
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-subtle-foreground">
              <span>
                {bt.stats.trades} trades
                {bt.stats.openAtEnd > 0 ? ` (+${bt.stats.openAtEnd} open)` : ""}
              </span>
              <span className={bt.stats.winPct >= 50 ? "text-bullish" : "text-bearish"}>
                {bt.stats.winPct}% win
              </span>
              <span className={bt.stats.netR >= 0 ? "text-bullish" : "text-bearish"}>
                {bt.stats.netR >= 0 ? "+" : ""}
                {bt.stats.netR}R net
              </span>
              <span>
                PF {bt.stats.profitFactor === Infinity ? "∞" : bt.stats.profitFactor}
              </span>
              <span>avg win {bt.stats.avgWinR}R / avg loss {bt.stats.avgLossR}R</span>
              <span>max DD {bt.stats.maxDrawdownR}R</span>
              <span>
                exits: {Object.entries(bt.stats.exits).map(([k, n]) => `${k} ${n}`).join(" · ")}
              </span>
            </div>
            <div className="mt-1 text-subtle-foreground">
              Expectancy {bt.stats.expectancyR >= 0 ? "+" : ""}
              {bt.stats.expectancyR}R per trade — the number that decides whether an edge is
              real. Past replay ≠ future results.
            </div>
          </div>
        )}
        {tournament !== undefined && (
          <div className="mb-4 rounded-md border border-border bg-surface p-3 text-xs">
            <div className="mb-1 font-medium text-foreground">
              Strategy tournament — {tournament.key.split("|")[1]}{" "}
              {tournament.key.split("|")[2]} · every method replayed on the same bars,
              same exits, ranked by net R
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-left text-subtle-foreground">
                  <th className="py-1 pr-3 font-medium">Strategy</th>
                  <th className="py-1 pr-3 font-medium">Trades</th>
                  <th className="py-1 pr-3 font-medium">Win %</th>
                  <th className="py-1 pr-3 font-medium">Net R</th>
                  <th className="py-1 pr-3 font-medium">PF</th>
                  <th className="py-1 font-medium">Expectancy</th>
                </tr>
              </thead>
              <tbody>
                {tournament.rows.map((r, i) => (
                  <tr key={r.label} className="border-b border-border last:border-b-0">
                    <td className="py-1.5 pr-3 font-medium text-foreground">
                      {i === 0 && r.stats.trades > 0 && r.stats.netR > 0 ? "★ " : ""}
                      {r.label}
                    </td>
                    <td className="numeric py-1.5 pr-3">{r.stats.trades}</td>
                    <td
                      className={cn(
                        "numeric py-1.5 pr-3",
                        r.stats.trades > 0 &&
                          (r.stats.winPct >= 50 ? "text-bullish" : "text-bearish"),
                      )}
                    >
                      {r.stats.trades > 0 ? `${r.stats.winPct}%` : "—"}
                    </td>
                    <td
                      className={cn(
                        "numeric py-1.5 pr-3",
                        r.stats.netR > 0 ? "text-bullish" : r.stats.netR < 0 ? "text-bearish" : "",
                      )}
                    >
                      {r.stats.netR >= 0 ? "+" : ""}
                      {r.stats.netR}R
                    </td>
                    <td className="numeric py-1.5 pr-3">
                      {r.stats.trades === 0
                        ? "—"
                        : r.stats.profitFactor === Infinity
                          ? "∞"
                          : r.stats.profitFactor}
                    </td>
                    <td
                      className={cn(
                        "numeric py-1.5",
                        r.stats.expectancyR > 0
                          ? "text-bullish"
                          : r.stats.expectancyR < 0
                            ? "text-bearish"
                            : "",
                      )}
                    >
                      {r.stats.trades === 0
                        ? "—"
                        : `${r.stats.expectancyR >= 0 ? "+" : ""}${r.stats.expectancyR}R`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-1 text-subtle-foreground">
              ORB · VWAP bounce/fade · liquidity sweep · EMA20 pullback · range fade vs the
              house engines — identical management, costs, and journal gates for every row.
              Short samples (a few hundred bars) are directional evidence, not proof.
            </div>
          </div>
        )}
        {btAll !== undefined && (
          <div className="mb-4 rounded-md border border-border bg-surface p-3 text-xs">
            <div className="mb-1 font-medium text-foreground">
              Backtest all — every Binance Spot pair on {btAll.timeframe}, ranked by net R
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-left text-subtle-foreground">
                  <th className="py-1 pr-3 font-medium">Pair</th>
                  <th className="py-1 pr-3 font-medium">Trades</th>
                  <th className="py-1 pr-3 font-medium">Win %</th>
                  <th className="py-1 pr-3 font-medium">Net R</th>
                  <th className="py-1 pr-3 font-medium">PF</th>
                  <th className="py-1 font-medium">Expectancy</th>
                </tr>
              </thead>
              <tbody>
                {btAll.rows.map((r) => (
                  <tr key={r.symbol} className="border-b border-border last:border-b-0">
                    <td className="py-1.5 pr-3 font-medium text-foreground">
                      {VENUES.binance.symbolInfo(r.symbol)?.label ?? r.symbol}
                    </td>
                    <td className="numeric py-1.5 pr-3">{r.stats.trades}</td>
                    <td
                      className={cn(
                        "numeric py-1.5 pr-3",
                        r.stats.trades > 0 &&
                          (r.stats.winPct >= 50 ? "text-bullish" : "text-bearish"),
                      )}
                    >
                      {r.stats.trades > 0 ? `${r.stats.winPct}%` : "—"}
                    </td>
                    <td
                      className={cn(
                        "numeric py-1.5 pr-3",
                        r.stats.netR > 0 ? "text-bullish" : r.stats.netR < 0 ? "text-bearish" : "",
                      )}
                    >
                      {r.stats.netR >= 0 ? "+" : ""}
                      {r.stats.netR}R
                    </td>
                    <td className="numeric py-1.5 pr-3">
                      {r.stats.trades === 0
                        ? "—"
                        : r.stats.profitFactor === Infinity
                          ? "∞"
                          : r.stats.profitFactor}
                    </td>
                    <td
                      className={cn(
                        "numeric py-1.5",
                        r.stats.expectancyR > 0
                          ? "text-bullish"
                          : r.stats.expectancyR < 0
                            ? "text-bearish"
                            : "",
                      )}
                    >
                      {r.stats.trades === 0
                        ? "—"
                        : `${r.stats.expectancyR >= 0 ? "+" : ""}${r.stats.expectancyR}R`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-1 text-subtle-foreground">
              Same replay rules as the single backtest — negative rows are pairs the engine
              would have lost on, shown honestly rather than hidden.
            </div>
          </div>
        )}
        {trades.length === 0 ? (
          <p className="text-sm text-subtle-foreground">
            No trades yet — every Binance Spot pair and NSE/BSE index is scanned each
            minute by both engines. Victor needs a 1m pin + follow-up at a leg–base–leg
            zone with RR ≥ 1; Confluence needs ≥3 confirmations (trend, structure, momentum,
            zone, RR, candlestick patterns) at a 5m zone with live volume — inside each
            venue&apos;s session window. One position per pair per strategy.
          </p>
        ) : (
          <div className="space-y-4">
            {alerts.length > 0 && (
              <div>
                <h3 className="mb-1.5 text-sm font-medium text-foreground">Latest events</h3>
                <ul className="space-y-0.5 text-xs">
                  {alerts.slice(0, 5).map((a) => (
                    <li
                      key={a.id}
                      className={cn(
                        a.tone === "bullish"
                          ? "text-bullish"
                          : a.tone === "bearish"
                            ? "text-bearish"
                            : "text-foreground",
                      )}
                    >
                      {a.text}
                      <span className="ml-1.5 text-subtle-foreground">
                        {new Date(a.at).toLocaleTimeString()}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {openTrades.length > 0 && (
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <h3 className="text-sm font-medium text-foreground">Open positions</h3>
                  <button
                    type="button"
                    onClick={() =>
                      updateTrades((prev) => closeAllPositions(prev, markOf, Date.now()))
                    }
                    className="rounded-md border border-bearish/40 px-2.5 py-1 text-xs font-medium text-bearish transition-colors hover:bg-bearish/10"
                  >
                    Exit all
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-subtle-foreground">
                        <th className="py-2 pr-3 font-medium">Symbol</th>
                        <th className="py-2 pr-3 font-medium">Type</th>
                        <th className="py-2 pr-3 font-medium">Score</th>
                        <th className="py-2 pr-3 font-medium">Entry</th>
                        <th className="py-2 pr-3 font-medium">S/L</th>
                        <th className="py-2 pr-3 font-medium">T/P</th>
                        <th className="py-2 pr-3 font-medium">Price</th>
                        <th className="py-2 pr-3 font-medium">Pts</th>
                        <th className="py-2 pr-3 font-medium">Risked</th>
                        <th className="py-2 pr-3 font-medium">Opened</th>
                        <th className="py-2 pr-3 font-medium">Held</th>
                        <th className="py-2 pr-3 font-medium">Profit</th>
                        <th className="py-2 font-medium">Exit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {openTrades.map((t) => {
                        const info = VENUES[t.venue as VenueId]?.symbolInfo(t.symbol);
                        const p = info?.pricePrecision ?? precision;
                        const tp1 = t.targets[0]?.price;
                        const stopNote = t.tp1Hit
                          ? t.stopLoss === t.entry
                            ? "BE"
                            : "trail"
                          : "";
                        const mark = markOf(t);
                        const r = mark !== undefined ? unrealizedR(t, mark) : undefined;
                        const pnl = mark !== undefined ? unrealizedUsd(t, mark) : undefined;
                        const pts = mark !== undefined ? pointsCaptured(t, mark) : undefined;
                        const meta = DIR_META[t.direction];
                        return (
                          <tr key={t.id} className="border-b border-border last:border-b-0">
                            <td className="py-2.5 pr-3 font-medium text-foreground">
                              {info?.label ?? t.symbol} · {t.timeframe}
                              <span className="ml-1.5 text-xs font-normal text-subtle-foreground">
                                {VENUES[t.venue as VenueId]?.label ?? t.venue}
                              </span>
                              <Badge
                                tone={t.strategy === "victor" ? "developing" : "neutral"}
                                className="ml-1.5"
                              >
                                {t.strategy === "victor" ? "Victor" : "Conf"}
                              </Badge>
                            </td>
                            <td className="py-2.5 pr-3">
                              <Badge tone={meta.tone}>
                                {t.direction === "bullish" ? "BUY" : "SELL"}
                              </Badge>
                            </td>
                            <td className="numeric py-2.5 pr-3">{t.confidence}</td>
                            <td className="numeric py-2.5 pr-3">{fmtPrice(t.entry, p)}</td>
                            <td className="numeric py-2.5 pr-3">
                              {fmtPrice(t.stopLoss, p)}
                              {stopNote !== "" && (
                                <span className="ml-1 text-xs text-subtle-foreground">
                                  {stopNote}
                                </span>
                              )}
                            </td>
                            <td className="numeric py-2.5 pr-3">
                              {fmtPrice(tp1, p)}
                              {t.tp1Hit && (
                                <span className="ml-1 text-xs text-bullish">banked</span>
                              )}
                            </td>
                            <td className="numeric py-2.5 pr-3 text-foreground">
                              {mark !== undefined ? fmtPrice(mark, p) : "—"}
                            </td>
                            <td
                              className={cn(
                                "numeric py-2.5 pr-3",
                                pts !== undefined &&
                                  (pts >= 0 ? "text-bullish" : "text-bearish"),
                              )}
                            >
                              {pts === undefined
                                ? "—"
                                : `${pts >= 0 ? "+" : ""}${fmtPrice(pts, p)}`}
                            </td>
                            <td className="numeric py-2.5 pr-3">
                              {t.riskUsd !== undefined ? fmtUsd(t.riskUsd) : "—"}
                            </td>
                            <td className="numeric py-2.5 pr-3 text-subtle-foreground">
                              {new Date(t.openedAt).toISOString().slice(11, 16)}Z
                            </td>
                            <td className="numeric py-2.5 pr-3 text-subtle-foreground">
                              {t.barsHeld}×{t.timeframe}
                            </td>
                            <td
                              className={cn(
                                "numeric py-2.5 font-semibold",
                                pnl !== undefined &&
                                  (pnl >= 0 ? "text-bullish" : "text-bearish"),
                              )}
                            >
                              {pnl === undefined
                                ? "—"
                                : `${fmtUsdPnl(pnl)} (${r! >= 0 ? "+" : ""}${r}R)`}
                            </td>
                            <td className="py-2.5">
                              <button
                                type="button"
                                onClick={() =>
                                  updateTrades((prev) =>
                                    prev.map((x) =>
                                      x.id === t.id ? closePosition(x, mark, Date.now()) : x,
                                    ),
                                  )
                                }
                                className="rounded border border-border px-2 py-0.5 text-xs text-subtle-foreground transition-colors hover:border-bearish/40 hover:text-bearish"
                              >
                                Exit
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1.5 text-xs text-subtle-foreground">
                  Price and profit tick live for the market on the chart; every other position
                  re-marks each minute on its own timeframe&apos;s bars.
                </p>
              </div>
            )}
            {closedTrades.length > 0 && (
              <div>
                <h3 className="mb-1.5 text-sm font-medium text-foreground">
                  Trade history — profit & loss
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-subtle-foreground">
                        <th className="py-2 pr-3 font-medium">Symbol</th>
                        <th className="py-2 pr-3 font-medium">Type</th>
                        <th className="py-2 pr-3 font-medium">Entry → Exit</th>
                        <th className="py-2 pr-3 font-medium">Closed by</th>
                        <th className="py-2 pr-3 font-medium">Bars</th>
                        <th className="py-2 pr-3 font-medium">Points</th>
                        <th className="py-2 pr-3 font-medium">R</th>
                        <th className="py-2 font-medium">Profit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {closedTrades.map((t) => {
                        const info = VENUES[t.venue as VenueId]?.symbolInfo(t.symbol);
                        const p = info?.pricePrecision ?? precision;
                        const r = t.realizedR ?? 0;
                        const pnl = r * (t.riskUsd ?? 0);
                        const pts = pointsCaptured(t);
                        return (
                          <tr key={t.id} className="border-b border-border last:border-b-0">
                            <td className="py-2.5 pr-3 font-medium text-foreground">
                              {info?.label ?? t.symbol} · {t.timeframe}
                              <span className="ml-1.5 text-xs font-normal text-subtle-foreground">
                                {VENUES[t.venue as VenueId]?.label ?? t.venue}
                              </span>
                              {t.strategy === "victor" && (
                                <Badge tone="developing" className="ml-1.5">
                                  Victor
                                </Badge>
                              )}
                            </td>
                            <td className="py-2.5 pr-3">
                              <Badge tone={DIR_META[t.direction].tone}>
                                {t.direction === "bullish" ? "BUY" : "SELL"}
                              </Badge>
                            </td>
                            <td className="numeric py-2.5 pr-3">
                              {fmtPrice(t.entry, p)} → {fmtPrice(t.exitPrice, p)}
                            </td>
                            <td className="py-2.5 pr-3 text-subtle-foreground">
                              {t.exitReason}
                            </td>
                            <td className="numeric py-2.5 pr-3">{t.barsHeld}</td>
                            <td
                              className={cn(
                                "numeric py-2.5 pr-3",
                                pts > 0 ? "text-bullish" : pts < 0 ? "text-bearish" : "",
                              )}
                            >
                              {pts >= 0 ? "+" : ""}
                              {fmtPrice(pts, p)}
                            </td>
                            <td
                              className={cn(
                                "numeric py-2.5 pr-3",
                                r > 0.01 ? "text-bullish" : r < -0.01 ? "text-bearish" : "",
                              )}
                            >
                              {r >= 0 ? "+" : ""}
                              {r}R
                            </td>
                            <td
                              className={cn(
                                "numeric py-2.5 font-semibold",
                                pnl > 0.01
                                  ? "text-bullish"
                                  : pnl < -0.01
                                    ? "text-bearish"
                                    : "",
                              )}
                            >
                              {fmtUsdPnl(pnl)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {stats.length > 0 ? (
              <div>
                <h3 className="mb-1.5 text-sm font-medium text-foreground">Daily record</h3>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-subtle-foreground">
                        <th className="py-2 pr-3 font-medium">Day</th>
                        <th className="py-2 pr-3 font-medium">Trades</th>
                        <th className="py-2 pr-3 font-medium">Wins</th>
                        <th className="py-2 pr-3 font-medium">Losses</th>
                        <th className="py-2 pr-3 font-medium">Flat</th>
                        <th className="py-2 pr-3 font-medium">Win %</th>
                        <th className="py-2 pr-3 font-medium">Net R</th>
                        <th className="py-2 font-medium">Net $</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.map((d) => (
                        <tr key={d.day} className="border-b border-border last:border-b-0">
                          <td className="numeric py-2.5 pr-3 font-medium text-foreground">
                            {d.day}
                          </td>
                          <td className="numeric py-2.5 pr-3">{d.trades}</td>
                          <td className="numeric py-2.5 pr-3 text-bullish">{d.wins}</td>
                          <td className="numeric py-2.5 pr-3 text-bearish">{d.losses}</td>
                          <td className="numeric py-2.5 pr-3">{d.flats}</td>
                          <td className="numeric py-2.5 pr-3 font-semibold text-foreground">
                            {d.winPct}%
                          </td>
                          <td
                            className={cn(
                              "numeric py-2.5 font-semibold",
                              d.netR >= 0 ? "text-bullish" : "text-bearish",
                            )}
                          >
                            {d.netR >= 0 ? "+" : ""}
                            {d.netR}R
                          </td>
                          <td
                            className={cn(
                              "numeric py-2.5 font-semibold",
                              d.netUsd >= 0 ? "text-bullish" : "text-bearish",
                            )}
                          >
                            {fmtUsdPnl(d.netUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1.5 text-xs text-subtle-foreground">
                  Wins/losses are measured paper outcomes of the engine&apos;s signals — a
                  record of the past, not a promise. A TP1-banked trade stopped at breakeven
                  still counts as a win.
                </p>
              </div>
            ) : (
              <p className="text-sm text-subtle-foreground">
                No closed trades yet — the daily win/loss record appears once the first paper
                trade resolves.
              </p>
            )}
            {byPair.length > 0 && (
              <div>
                <h3 className="mb-1.5 text-sm font-medium text-foreground">
                  By pair — where is the engine most consistent?
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-subtle-foreground">
                        <th className="py-2 pr-3 font-medium">Pair</th>
                        <th className="py-2 pr-3 font-medium">Venue</th>
                        <th className="py-2 pr-3 font-medium">Trades</th>
                        <th className="py-2 pr-3 font-medium">Open</th>
                        <th className="py-2 pr-3 font-medium">W</th>
                        <th className="py-2 pr-3 font-medium">L</th>
                        <th className="py-2 pr-3 font-medium">Flat</th>
                        <th className="py-2 pr-3 font-medium">Win %</th>
                        <th className="py-2 pr-3 font-medium">Net R</th>
                        <th className="py-2 font-medium">Net $</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byPair.map((r) => {
                        const info = VENUES[r.venue as VenueId]?.symbolInfo(r.symbol);
                        return (
                          <tr
                            key={`${r.venue}|${r.symbol}`}
                            className="border-b border-border last:border-b-0"
                          >
                            <td className="py-2.5 pr-3 font-medium text-foreground">
                              {info?.label ?? r.symbol}
                            </td>
                            <td className="py-2.5 pr-3 text-subtle-foreground">
                              {VENUES[r.venue as VenueId]?.label ?? r.venue}
                            </td>
                            <td className="numeric py-2.5 pr-3">{r.closed}</td>
                            <td className="numeric py-2.5 pr-3">{r.open}</td>
                            <td className="numeric py-2.5 pr-3 text-bullish">{r.wins}</td>
                            <td className="numeric py-2.5 pr-3 text-bearish">{r.losses}</td>
                            <td className="numeric py-2.5 pr-3">{r.flats}</td>
                            <td className="numeric py-2.5 pr-3 font-semibold text-foreground">
                              {r.closed > 0 ? `${r.winPct}%` : "—"}
                            </td>
                            <td
                              className={cn(
                                "numeric py-2.5 font-semibold",
                                r.closed === 0
                                  ? "text-subtle-foreground"
                                  : r.netR >= 0
                                    ? "text-bullish"
                                    : "text-bearish",
                              )}
                            >
                              {r.closed > 0 ? `${r.netR >= 0 ? "+" : ""}${r.netR}R` : "—"}
                            </td>
                            <td
                              className={cn(
                                "numeric py-2.5 font-semibold",
                                r.closed === 0
                                  ? "text-subtle-foreground"
                                  : r.netUsd >= 0
                                    ? "text-bullish"
                                    : "text-bearish",
                              )}
                            >
                              {r.closed > 0 ? fmtUsdPnl(r.netUsd) : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1.5 text-xs text-subtle-foreground">
                  Every Binance Spot pair is scanned every minute; pairs with
                  closed trades rank first by win %. A few trades is noise — judge a pair
                  after a meaningful sample.
                </p>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Intraday scan across 5m–4h */}
      <Card>
        <CardHeader
          title="Intraday scan"
          description={`${symbolInfo.label} on ${venue.label} — every scan timeframe re-analyzed each minute. A row shows a trade only when the engine's criteria are met.`}
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-subtle-foreground">
                <th className="py-2 pr-3 font-medium">Timeframe</th>
                <th className="py-2 pr-3 font-medium">Signal</th>
                <th className="py-2 pr-3 font-medium">Points</th>
                <th className="py-2 pr-3 font-medium">Entry</th>
                <th className="py-2 pr-3 font-medium">Stop loss</th>
                <th className="py-2 font-medium">TP1</th>
              </tr>
            </thead>
            <tbody>
              {SCAN_TIMEFRAMES.map((tf) => {
                const row = scanRowFor(tf);
                const a = row.analysis;
                const s = a?.signal;
                const dir = s?.direction ?? "wait";
                const meta = DIR_META[dir];
                const RowIcon = meta.icon;
                return (
                  <tr
                    key={tf}
                    className={cn(
                      "border-b border-border last:border-b-0",
                      tf === timeframe && "bg-accent/5",
                    )}
                  >
                    <td className="py-2.5 pr-3 font-medium text-foreground">
                      {venue.intervals.find((i) => i.timeframe === tf)?.label ?? tf}
                      {tf === timeframe && (
                        <span className="ml-1.5 text-xs text-subtle-foreground">(live)</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      {row.state === "loading" ? (
                        <span className="text-xs text-subtle-foreground">…</span>
                      ) : row.state === "error" ? (
                        <span className="text-xs text-subtle-foreground" title={row.error}>
                          unavailable
                        </span>
                      ) : (
                        <Badge tone={meta.tone}>
                          <RowIcon className="mr-1 inline size-3" aria-hidden="true" />
                          {meta.label}
                        </Badge>
                      )}
                    </td>
                    <td className="numeric py-2.5 pr-3">
                      {s ? `${s.confidence}/100` : "—"}
                    </td>
                    <td className="numeric py-2.5 pr-3">{fmtPrice(s?.entry, precision)}</td>
                    <td className="numeric py-2.5 pr-3">{fmtPrice(s?.stopLoss, precision)}</td>
                    <td className="numeric py-2.5">{fmtPrice(s?.targets[0]?.price, precision)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
