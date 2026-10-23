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
import type { TradeSignal } from "@/lib/crypto/analysis";
import {
  ACCOUNT_CAPITAL_USD,
  closeAllPositions,
  closePosition,
  dailyStats,
  equityOf,
  evaluateTrade,
  floatingPnlUsd,
  BIAS_TIMEFRAME,
  entryBlockReason,
  journalKey,
  loadTrades,
  pointsCaptured,
  registerSignal,
  saveTrades,
  symbolStats,
  tradeKey,
  unrealizedR,
  unrealizedUsd,
  type TradeRecord,
} from "@/lib/crypto/journal";
import { backtestCandles, type BacktestStats } from "@/lib/crypto/backtest";
import { STRATEGIES, type StrategyFn } from "@/lib/crypto/strategies";
import { majorLevels, srTrendSignal } from "@/lib/crypto/srtrend";
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
  DEFAULT_INDIA_TIMEFRAME,
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
  defaultTimeframe: Timeframe;
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
    defaultTimeframe: DEFAULT_CRYPTO_TIMEFRAME,
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
    defaultTimeframe: DEFAULT_CRYPTO_TIMEFRAME,
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
    defaultTimeframe: DEFAULT_INDIA_TIMEFRAME,
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

/** Journal's strategy tag → the registry's display label. */
function strategyLabel(id: string | undefined): string {
  return STRATEGIES.find((d) => d.id === (id ?? "confluence"))?.label ?? "Confluence";
}

function fmtSignedPct(value: number | undefined): string {
  if (value === undefined) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

// ---------- component ----------

export function CryptoMarketsWorkspace({
  venues = VENUE_ORDER,
  initialVenue = "binance",
}: {
  /** Venue tabs offered in the UI. The paper-trade scan still covers every venue. */
  venues?: VenueId[];
  initialVenue?: VenueId;
}) {
  const [venueId, setVenueId] = useState<VenueId>(initialVenue);
  const venue = VENUES[venueId];
  const [symbol, setSymbol] = useState<string>(VENUES[initialVenue].defaultSymbol);
  const [timeframe, setTimeframe] = useState<Timeframe>(VENUES[initialVenue].defaultTimeframe);
  const [quotes, setQuotes] = useState<Record<string, CryptoQuote>>({});
  const [candlesSet, setCandlesSet] = useState<CryptoCandleSet | undefined>();
  const [restError, setRestError] = useState<string | undefined>();
  const [feedStatus, setFeedStatus] = useState<FeedStatus>("connecting");
  const [lastEventAt, setLastEventAt] = useState<number | undefined>();
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [alerts, setAlerts] = useState<TradeAlert[]>([]);
  const [selectedTradeId, setSelectedTradeId] = useState<string | undefined>(undefined);
  const [bt, setBt] = useState<{ key: string; stats: BacktestStats } | undefined>(undefined);
  const [btBusy, setBtBusy] = useState(false);
  const [btStrategy, setBtStrategy] = useState<string>("sr");
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
  // Which registered strategy is the live trading engine — button row below.
  // The fn lives in state so the render path stays ref-free; it keeps its
  // run-local memory (e.g. ORB's one-trade-per-session) for the scan.
  const [engineId, setEngineId] = useState<string>(STRATEGIES[0]?.id ?? "sr");
  const [engineFn, setEngineFn] = useState<StrategyFn>(
    () => STRATEGIES.find((d) => d.id === (STRATEGIES[0]?.id ?? "sr"))?.create() ?? srTrendSignal,
  );
  const engineIdRef = useRef(engineId);
  const engineFnRef = useRef(engineFn);
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
    // Venues offer different interval sets (India has no 4h) — keep the
    // current timeframe when supported, else fall back to the venue's own.
    setTimeframe((tf) =>
      VENUES[next].intervals.some((i) => i.timeframe === tf)
        ? tf
        : VENUES[next].defaultTimeframe,
    );
    setQuotes({});
    setCandlesSet(undefined);
    setRestError(undefined);
  };

  const switchSymbol = (next: string) => {
    if (next === symbol) return;
    setSymbol(next);
    setCandlesSet(undefined);
    setRestError(undefined);
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

  // Live marks: last close per venue|symbol|tf, fed by every kline fetch
  // (global scan, live chart) — drives floating P&L per trade.
  const [marks, setMarks] = useState<Record<string, number>>({});
  // Why each pair did not book this scan tick — makes a quiet
  // market visible instead of looking like a dead engine.
  const [scanWhy, setScanWhy] = useState<{ at: number; cells: Record<string, string> } | undefined>(
    undefined,
  );
  const scanWhyRef = useRef<Record<string, string>>({});

  // The strategy buttons pick the engine — a fresh StrategyFn is created
  // on each switch so its internal session state starts clean.
  const engineDef = STRATEGIES.find((d) => d.id === engineId);
  const selectEngine = (id: string) => {
    const def = STRATEGIES.find((d) => d.id === id);
    const fn = def !== undefined ? def.create() : srTrendSignal;
    engineIdRef.current = id;
    engineFnRef.current = fn;
    setEngineId(id);
    // Wrap it — a bare function passed to setState is treated as an updater.
    setEngineFn(() => fn);
  };

  // Global scan: every listed pair on the trading venues (Binance Spot +
  // NSE/BSE India — kept fully separate markets), every minute. One engine
  // — S/R levels on 5m — one open position per pair.
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
          // The engine trades the 5m tape; legacy open trades keep their
          // own timeframe's bars fetched for management.
          const fetchTfs = [
            ...new Set<Timeframe>([...(trading ? ["5m" as Timeframe] : []), ...legacyTfs]),
          ];
          void Promise.all(
            fetchTfs.map((tf) => v.fetchKlines(sym, tf).then((res) => ({ tf, res }))),
          ).then((rows) => {
            if (cancelled) return;
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
            // One open position per pair — the single engine's slot.
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
              // ---- The selected strategy's 5m signal — one engine,
              // one timeframe, every pair. ----
              const closed5 = tfSets.get(journalKey(vId, sym, "5m"));
              let setup: ReturnType<StrategyFn>;
              try {
                setup = closed5 !== undefined ? engineFnRef.current(closed5) : undefined;
              } catch {
                setup = undefined; // engine threw on this tape — skip the pair
              }
              if (closed5 === undefined) {
                scanWhyRef.current[sym] = "warming up";
              } else if (setup === undefined) {
                scanWhyRef.current[sym] = "no level setup";
              } else if (slotBusy(engineIdRef.current)) {
                scanWhyRef.current[sym] = "position open";
              } else {
                scanWhyRef.current[sym] =
                  `${setup.direction === "bullish" ? "buy" : "sell"} ${setup.confidence}pts`;
                candidates.push({
                  venue: vId,
                  symbol: sym,
                  timeframe: "5m",
                  signal: setup,
                  barTime: closed5[closed5.length - 1].time,
                  edge: 0,
                  strategy: engineIdRef.current,
                  sessionUtc,
                });
              }
            }
            updateTrades((prev) => {
              // Manage every open trade of this pair on its own timeframe's bars.
              let next = prev.map((t) => {
                if (t.status !== "open") return t;
                const set = tfSets.get(tradeKey(t));
                return set === undefined ? t : evaluateTrade(t, set);
              });
              // Book each candidate — registerSignal owns the per-pair
              // slot guard, so a pair never stacks positions.
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
  // Separate markets: this page's book is the subset of the shared journal
  // on this market's venues. The scan still manages every open trade.
  const pageTrades = trades.filter((t) => venues.includes(t.venue as VenueId));
  const openTrades = pageTrades.filter((t) => t.status === "open");
  const stats = dailyStats(pageTrades);
  const byPair = symbolStats(pageTrades);
  const balance = equityOf(pageTrades); // realized equity — closed trades only
  const closedTrades = [...pageTrades]
    .filter((t) => t.status === "closed")
    .sort((a, b) => (b.exitTime ?? 0) - (a.exitTime ?? 0))
    .slice(0, 8);
  const selectedTrade = trades.find((t) => t.id === selectedTradeId);
  const lastClose = candles?.[candles.length - 1]?.close;
  const markOf = (t: TradeRecord): number | undefined =>
    tradeKey(t) === currentKey && lastClose !== undefined
      ? lastClose
      : marks[tradeKey(t)];
  const floating = floatingPnlUsd(pageTrades, markOf);
  const liveEquity = Math.round((balance + floating) * 100) / 100;

  // Live engine readout for the charted market — the same evaluation the
  // scan runs on every pair's 5m tape.
  const closedChart = useMemo(
    () =>
      candles !== undefined
        ? candlesSet?.hasFormingCandle
          ? candles.slice(0, -1)
          : candles
        : undefined,
    [candles, candlesSet],
  );
  const engineLive = useMemo(() => {
    if (closedChart === undefined) return undefined;
    try {
      return engineFn(closedChart);
    } catch {
      return undefined; // a strategy that throws just has no signal — never crash the page
    }
  }, [closedChart, engineFn]);
  const srLevels = useMemo(
    () => (closedChart !== undefined && engineId === "sr" ? majorLevels(closedChart) : []),
    [closedChart, engineId],
  );

  const signalOverlays = useMemo<ChartOverlay[]>(() => {
    const out: ChartOverlay[] = [];
    // Major swing levels only — the S/R the engine trades off, capped to
    // the ones nearest price so the chart stays clean.
    [...srLevels]
      .sort((a, b) => Math.abs(a.price - (lastClose ?? 0)) - Math.abs(b.price - (lastClose ?? 0)))
      .slice(0, 6)
      .forEach((l, i) => {
      out.push({
        kind: "level",
        id: `sr-${i}`,
        layer: "structure",
        price: l.price,
        label: `${l.kind === "support" ? "S" : "R"} ×${l.touches}`,
        direction: l.kind === "support" ? "bullish" : "bearish",
      });
    });
    const s = engineLive;
    if (s !== undefined && s.direction !== "wait") {
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
    // Broker-style plan levels — the position on this chart draws its
    // entry, live stop (trail/BE once TP1 banked), and both targets.
    const planTrade =
      openTrade ??
      (selectedTrade !== undefined && tradeKey(selectedTrade) === currentKey
        ? selectedTrade
        : undefined);
    if (planTrade) {
      out.push({
        kind: "level",
        id: "jt-entry",
        layer: "structure",
        price: planTrade.entry,
        label: "Entry",
        direction: planTrade.direction,
      });
      out.push({
        kind: "level",
        id: "jt-sl",
        layer: "liquidity",
        price: planTrade.stopLoss,
        label:
          planTrade.tp1Hit && planTrade.stopLoss === planTrade.entry
            ? "SL → breakeven"
            : planTrade.tp1Hit
              ? "Trail SL"
              : "Stop loss",
        direction: planTrade.direction,
      });
      planTrade.targets.forEach((tgt, i) => {
        out.push({
          kind: "level",
          id: `jt-tp-${i}`,
          layer: "structure",
          price: tgt.price,
          label: `${tgt.label} · ${tgt.rr}R`,
          direction: planTrade.direction,
        });
      });
    }
    return out;
  }, [srLevels, engineLive, openTrade, selectedTrade, currentKey, lastClose]);

  const signalMarkers = useMemo<ChartMarker[]>(() => {
    const s = engineLive;
    const lastCandle = candles?.[candles.length - 1];
    if (s === undefined || s.direction === "wait" || lastCandle === undefined) {
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
  }, [engineLive, candles]);

  const feed = FEED_META[feedStatus];
  const FeedIcon = feed.icon;

  return (
    <div className="space-y-5">
      {/* Venue + feed status */}
      <div className="flex flex-wrap items-center gap-2">
        {venues.map((id) => (
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

      {/* Strategy buttons — the picked strategy IS the live engine:
          every listed pair is scanned with it each minute. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-foreground">Engine</span>
        {STRATEGIES.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => selectEngine(d.id)}
            aria-pressed={engineId === d.id}
            title={d.blurb}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              engineId === d.id
                ? "border-accent bg-accent/10 text-foreground"
                : "border-border text-subtle-foreground hover:bg-surface-hover hover:text-foreground",
            )}
          >
            {d.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-subtle-foreground">
        {engineDef?.blurb ?? ""} — trades the 5m tape, one position per pair.
      </p>

      {/* Trading sessions — the entry windows each market obeys */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-subtle-foreground">
        <span className="font-medium text-foreground">Sessions</span>
        {(
          [
            { label: "Crypto", w: [0, 24] as readonly [number, number], range: "24/7" },
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

      {/* Engine detail — the selected strategy's live read on this market */}
      <Card>
        <CardHeader
          title={`${engineDef?.label ?? "Engine"} — the trading engine`}
          description={engineDef?.blurb ?? ""}
          action={
            engineLive !== undefined && (
              <Badge tone={DIR_META[engineLive.direction].tone}>
                {engineLive.direction === "bullish" ? "BUY" : "SELL"} ·{" "}
                {engineLive.confidence} pts
              </Badge>
            )
          }
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            { label: "Entry", value: engineLive?.entry },
            { label: "Stop", value: engineLive?.stopLoss },
            { label: "TP1", value: engineLive?.targets[0]?.price },
            { label: "TP2", value: engineLive?.targets[1]?.price },
            { label: "RR", value: engineLive?.riskReward, suffix: "R" },
          ].map((f) => (
            <div key={f.label}>
              <div className="text-xs text-subtle-foreground">{f.label}</div>
              <div className="numeric mt-0.5 text-sm text-foreground">
                {f.value === undefined ? "—" : `${fmtPrice(f.value, precision)}${f.suffix ?? ""}`}
              </div>
            </div>
          ))}
        </div>
        {engineLive === undefined ? (
          <p className="mt-3 text-xs text-subtle-foreground">
            No setup right now — {engineDef?.label ?? "the engine"} is waiting for its entry
            conditions.
          </p>
        ) : (
          engineLive.reasons.length > 0 && (
            <ul className="mt-3 list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
              {engineLive.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )
        )}
        {engineId === "sr" && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-xs text-subtle-foreground">
              Support / resistance — every swing high/low; N respects = strength
            </p>
            {srLevels.length === 0 ? (
              <p className="mt-0.5 text-sm text-muted-foreground">Waiting for level data…</p>
            ) : (
              <ul className="mt-1 space-y-0.5 text-xs">
                {[...srLevels]
                  .sort(
                    (a, b) =>
                      Math.abs(a.price - (lastClose ?? 0)) -
                      Math.abs(b.price - (lastClose ?? 0)),
                  )
                  .slice(0, 6)
                  .map((l, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2">
                    <Badge tone={l.kind === "support" ? "bullish" : "bearish"}>
                      {l.kind}
                    </Badge>
                    <span className="numeric text-foreground">
                      {fmtPrice(l.price, precision)}
                    </span>
                    <span className="text-subtle-foreground">{l.touches} respects</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      {/* Paper-trade journal — every proposed trade, carried forward on real bars */}
      <Card>
        <CardHeader
          title="Paper trades"
          description={
            `Virtual $10,000 terminal — ${engineDef?.label ?? "the selected strategy"} auto-trades every Binance Spot pair and NSE/BSE index on the 5m tape. One open position per pair; TP1 banks half and the stop trails candle by candle.`
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
                  onClick={() =>
                    updateTrades((prev) =>
                      prev.filter((t) => !venues.includes(t.venue as VenueId)),
                    )
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  Clear journal
                </button>
              )}
              <select
                value={btStrategy}
                onChange={(e) => setBtStrategy(e.target.value)}
                aria-label="Backtest strategy"
                className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-subtle-foreground"
              >
                {STRATEGIES.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={btBusy}
                onClick={() => {
                  setBtBusy(true);
                  const def = STRATEGIES.find((d) => d.id === btStrategy);
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
                          key: `${venueId}|${symbol}|${timeframe}|${def?.id ?? "confluence"}`,
                          stats: backtestCandles(closed, {
                            venue: venueId,
                            symbol,
                            timeframe,
                            news: newsRef.current,
                            // SMC veto + 1h bias stay Confluence-only —
                            // other methods replay on their own rules so
                            // results compare cleanly with the tournament.
                            ...(def === undefined || def.id === "confluence"
                              ? { smc: true, bias }
                              : {}),
                            strategy:
                              def !== undefined && def.id !== "confluence"
                                ? { name: def.id, signalFor: def.create() }
                                : undefined,
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
              venueId === "india" ? INDIA_SESSION_UTC : undefined,
            ) !== undefined && (
              <span className="text-warning">
                {" "}· entries paused —{" "}
                {entryBlockReason(
                  trades,
                  now,
                  undefined,
                  venueId === "india" ? INDIA_SESSION_UTC : undefined,
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
            minute by {engineDef?.label ?? "the selected engine"}. The moment its
            entry condition prints on a closed 5m bar, a paper trade opens here
            with its reason, stop, targets and running P&L. One position per pair.
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
                          <tr
                            key={t.id}
                            onClick={() =>
                              setSelectedTradeId((cur) => (cur === t.id ? undefined : t.id))
                            }
                            className={cn(
                              "cursor-pointer border-b border-border last:border-b-0 transition-colors hover:bg-surface-hover",
                              selectedTradeId === t.id && "bg-surface-hover",
                            )}
                          >
                            <td className="py-2.5 pr-3 font-medium text-foreground">
                              {info?.label ?? t.symbol} · {t.timeframe}
                              <span className="ml-1.5 text-xs font-normal text-subtle-foreground">
                                {VENUES[t.venue as VenueId]?.label ?? t.venue}
                              </span>
                              <Badge tone="developing" className="ml-1.5">
                                {strategyLabel(t.strategy)}
                              </Badge>
                              {(t.reasons?.length ?? 0) > 0 && (
                                <span className="mt-0.5 block max-w-xs truncate text-xs font-normal text-subtle-foreground">
                                  {t.reasons?.[0]}
                                </span>
                              )}
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
                                onClick={(e) => {
                                  e.stopPropagation();
                                  updateTrades((prev) =>
                                    prev.map((x) =>
                                      x.id === t.id ? closePosition(x, mark, Date.now()) : x,
                                    ),
                                  );
                                }}
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
                          <tr
                            key={t.id}
                            onClick={() =>
                              setSelectedTradeId((cur) => (cur === t.id ? undefined : t.id))
                            }
                            className={cn(
                              "cursor-pointer border-b border-border last:border-b-0 transition-colors hover:bg-surface-hover",
                              selectedTradeId === t.id && "bg-surface-hover",
                            )}
                          >
                            <td className="py-2.5 pr-3 font-medium text-foreground">
                              {info?.label ?? t.symbol} · {t.timeframe}
                              <span className="ml-1.5 text-xs font-normal text-subtle-foreground">
                                {VENUES[t.venue as VenueId]?.label ?? t.venue}
                              </span>
                              <Badge tone="developing" className="ml-1.5">
                                {strategyLabel(t.strategy)}
                              </Badge>
                              {(t.reasons?.length ?? 0) > 0 && (
                                <span className="mt-0.5 block max-w-xs truncate text-xs font-normal text-subtle-foreground">
                                  {t.reasons?.[0]}
                                </span>
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

    </div>
  );
}