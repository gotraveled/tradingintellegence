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
import { analyzeCandles, type SignalAnalysis } from "@/lib/crypto/analysis";
import {
  clearTrades,
  dailyStats,
  evaluateTrade,
  journalKey,
  loadTrades,
  registerSignal,
  saveTrades,
  tradeKey,
  unrealizedR,
  type TradeRecord,
} from "@/lib/crypto/journal";
import { analyzeTechnicals } from "@/lib/crypto/technicals";
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

type VenueId = "binance" | "kraken";

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
};

const VENUE_ORDER: VenueId[] = ["binance", "kraken"];

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
          // Journal the scan's signals and carry open trades on this
          // timeframe forward — every scan bar is a management update.
          if (res.ok && rowAnalysis !== undefined && res.data.candles.length > 0) {
            const set = res.data.candles;
            const closed = res.data.hasFormingCandle ? set.slice(0, -1) : set;
            const key = journalKey(venue.id, symbol, tf);
            updateTrades((prev) => {
              let next = registerSignal(prev, {
                venue: venue.id,
                symbol,
                timeframe: tf,
                signal: rowAnalysis.signal,
                barTime: set[set.length - 1].time,
                now: Date.now(),
              }).trades;
              next = next.map((t) =>
                t.status === "open" && tradeKey(t) === key ? evaluateTrade(t, closed) : t,
              );
              return next;
            });
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
          if (p === undefined && t.status === "open") {
            events.push({
              id: `${t.id}:open`,
              at: Date.now(),
              tone: t.direction,
              text: `New ${t.direction === "bullish" ? "BUY" : "SELL"} ${t.symbol} ${t.timeframe} @ ${t.entry} — SL ${t.stopLoss}`,
            });
          } else if (p !== undefined && p.status === "open" && t.status === "closed") {
            const r = t.realizedR ?? 0;
            events.push({
              id: `${t.id}:closed`,
              at: Date.now(),
              tone: r > 0.01 ? "bullish" : r < -0.01 ? "bearish" : "neutral",
              text: `Closed ${t.symbol} ${t.timeframe}: ${t.exitReason} @ ${t.exitPrice} (${r >= 0 ? "+" : ""}${r}R)`,
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

  // Paper-trade journal: book the live signal once per setup, then carry
  // every open trade on this market forward over newly closed bars.
  // Deferred: journal bookkeeping isn't render-critical and the lint rules
  // forbid synchronous setState inside an effect body.
  useEffect(() => {
    if (!analysis || candles === undefined || candles.length === 0) return;
    const lastBar = candles[candles.length - 1];
    const closed = candlesSet?.hasFormingCandle ? candles.slice(0, -1) : candles;
    const key = journalKey(venueId, symbol, timeframe);
    const signal = analysis.signal;
    const id = setTimeout(() => {
      updateTrades((prev) => {
        let next = registerSignal(prev, {
          venue: venueId,
          symbol,
          timeframe,
          signal,
          barTime: lastBar.time,
          now: Date.now(),
        }).trades;
        next = next.map((t) =>
          t.status === "open" && tradeKey(t) === key ? evaluateTrade(t, closed) : t,
        );
        return next;
      });
    }, 0);
    return () => clearTimeout(id);
  }, [analysis, candles, candlesSet?.hasFormingCandle, venueId, symbol, timeframe, updateTrades]);

  const currentKey = journalKey(venueId, symbol, timeframe);
  const openTrade = trades.find((t) => t.status === "open" && tradeKey(t) === currentKey);
  const openTrades = trades.filter((t) => t.status === "open");
  const stats = dailyStats(trades);
  const lastClose = candles?.[candles.length - 1]?.close;

  // High-impact events: released in the last 30m or coming within 48h.
  const upcomingNews = news.events
    .filter((e) => e.impact === "High")
    .map((e) => ({ ...e, ms: Date.parse(e.time) }))
    .filter((e) => e.ms > now - 30 * 60_000 && e.ms < now + 48 * 3_600_000)
    .sort((a, b) => a.ms - b.ms)
    .slice(0, 6);
  const newsRisk = upcomingNews.find((e) => Math.abs(e.ms - now) <= 60 * 60_000);

  const signalOverlays = useMemo<ChartOverlay[]>(() => {
    if (!analysis) return [];
    const out: ChartOverlay[] = [];
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
  }, [analysis, openTrade]);

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
          description="Every proposed entry is journaled and managed on real bars — TP1 banks half, the stop moves to breakeven, then trails 1R behind the close. A bar touching both stop and target counts the stop first (conservative)."
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
            </div>
          }
        />
        {trades.length === 0 ? (
          <p className="text-sm text-subtle-foreground">
            No trades yet — the engine books a paper trade the moment a signal fires on any
            scanned timeframe, and manages it on every closed bar while that market is being
            watched or scanned.
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
                <h3 className="mb-1.5 text-sm font-medium text-foreground">Running trades</h3>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-subtle-foreground">
                        <th className="py-2 pr-3 font-medium">Market</th>
                        <th className="py-2 pr-3 font-medium">Side</th>
                        <th className="py-2 pr-3 font-medium">Entry</th>
                        <th className="py-2 pr-3 font-medium">Stop (live)</th>
                        <th className="py-2 pr-3 font-medium">TP1</th>
                        <th className="py-2 font-medium">Open R</th>
                      </tr>
                    </thead>
                    <tbody>
                      {openTrades.map((t) => {
                        const info = VENUES[t.venue as VenueId]?.symbolInfo(t.symbol);
                        const p = info?.pricePrecision ?? precision;
                        const tp1 = t.targets[0]?.price;
                        const stopNote = t.tp1Hit
                          ? t.stopLoss === t.entry
                            ? "breakeven"
                            : "trailing"
                          : "initial";
                        const r =
                          tradeKey(t) === currentKey && lastClose !== undefined
                            ? unrealizedR(t, lastClose)
                            : undefined;
                        const meta = DIR_META[t.direction];
                        return (
                          <tr key={t.id} className="border-b border-border last:border-b-0">
                            <td className="py-2.5 pr-3 font-medium text-foreground">
                              {info?.label ?? t.symbol} · {t.timeframe}
                              <span className="ml-1.5 text-xs font-normal text-subtle-foreground">
                                {VENUES[t.venue as VenueId]?.label ?? t.venue}
                              </span>
                            </td>
                            <td className="py-2.5 pr-3">
                              <Badge tone={meta.tone}>{meta.label}</Badge>
                            </td>
                            <td className="numeric py-2.5 pr-3">{fmtPrice(t.entry, p)}</td>
                            <td className="numeric py-2.5 pr-3">
                              {fmtPrice(t.stopLoss, p)}
                              <span className="ml-1 text-xs text-subtle-foreground">
                                {stopNote}
                              </span>
                            </td>
                            <td className="numeric py-2.5 pr-3">
                              {fmtPrice(tp1, p)}
                              {t.tp1Hit && (
                                <span className="ml-1 text-xs text-bullish">banked</span>
                              )}
                            </td>
                            <td
                              className={cn(
                                "numeric py-2.5 font-semibold",
                                r !== undefined && (r >= 0 ? "text-bullish" : "text-bearish"),
                              )}
                            >
                              {r === undefined ? "—" : `${r >= 0 ? "+" : ""}${r}R`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1.5 text-xs text-subtle-foreground">
                  Open R updates live only for the market on the chart; other running trades
                  update when their market is viewed or scanned each minute.
                </p>
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
                        <th className="py-2 font-medium">Net R</th>
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
