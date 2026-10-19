"use client";

import {
  ImageUp,
  LineChart,
  Loader2,
  RefreshCw,
  TriangleAlert,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CandlestickChart, type ChartMarker } from "@/components/charts/candlestick-chart";
import type { ChartOverlay } from "@/components/charts/chart-types";
import { ChartAnalystWorkspace } from "@/components/chart-analyst/chart-analyst-workspace";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { analyzeCandles } from "@/lib/crypto/analysis";
import { fetchCryptoKlines, fetchCryptoQuotes } from "@/lib/crypto/binance/client";
import {
  binanceInterval,
  CRYPTO_INTERVALS,
  CRYPTO_SYMBOLS,
  cryptoSymbolInfo,
  DEFAULT_CRYPTO_SYMBOL,
  DEFAULT_CRYPTO_TIMEFRAME,
  VENUE_LABEL,
} from "@/lib/crypto/binance/constants";
import { normalizeStreamKline, normalizeTicker } from "@/lib/crypto/binance/normalize";
import { BinanceStream, klineStream, tickerStreams } from "@/lib/crypto/binance/stream";
import type { CryptoQuote, FeedStatus } from "@/lib/crypto/types";
import type { Candle, Timeframe, Tone } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Crypto Markets workspace — the platform's live public-data surface. Quotes and
 * candles come from Binance Spot public endpoints only (REST for history and the
 * seed quote read; one combined WebSocket for updates). Fully separate from the
 * Polygon-gated provider layer: this feed never unlocks or feeds other modules.
 *
 * Honesty contract: the feed badge renders the stream's real status verbatim;
 * last-received values stay visible but labelled stale when the socket goes
 * silent; venue attribution and a venue-specific-prices disclosure accompany
 * every quote. No synthetic data ever appears here — an unmet fetch is an error.
 */

const FEED_META: Record<FeedStatus, { tone: Tone; label: string; icon: LucideIcon }> = {
  connecting: { tone: "neutral", label: "Connecting", icon: Loader2 },
  live: { tone: "bullish", label: "Live", icon: Wifi },
  reconnecting: { tone: "developing", label: "Reconnecting", icon: RefreshCw },
  stale: { tone: "developing", label: "Stale", icon: TriangleAlert },
  offline: { tone: "inactive", label: "Offline", icon: WifiOff },
};

/** Asset-class tabs — only crypto has a live feed today; others stay honest. */
const ASSET_TABS = [
  { id: "crypto", label: "Crypto", note: "Live — Binance Spot" },
  { id: "forex", label: "Forex", note: "Needs a licensed feed" },
  { id: "india", label: "Indian markets", note: "Needs a licensed feed" },
] as const;
type AssetTab = (typeof ASSET_TABS)[number]["id"];

interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt?: number;
}

/** "12m ago"-style relative stamp for headlines. */
function relTime(ms: number): string {
  const s = Math.max(0, Date.now() - ms) / 1000;
  if (s < 90) return "just now";
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtPrice(value: number, precision: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

/** Provider event time → "14:03:22 UTC". */
function fmtUtcTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19) + " UTC";
}


// Candle state is keyed by the selection it was fetched for — loading is a
// derived property (key mismatch), so no synchronous setState is needed in the
// fetch effect and a stale key never renders under a new selection.
interface CandleSetState {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  hasForming: boolean;
  warnings: string[];
}

interface CandleErrorState {
  symbol: string;
  timeframe: Timeframe;
  message: string;
}

export function CryptoMarketsWorkspace() {
  const [symbol, setSymbol] = useState<string>(DEFAULT_CRYPTO_SYMBOL);
  const [timeframe, setTimeframe] = useState<Timeframe>(DEFAULT_CRYPTO_TIMEFRAME);
  const [quotes, setQuotes] = useState<Record<string, CryptoQuote>>({});
  const [quotesError, setQuotesError] = useState<string | undefined>();
  const [candlesSet, setCandlesSet] = useState<CandleSetState | undefined>(undefined);
  const [candlesError, setCandlesError] = useState<CandleErrorState | undefined>(undefined);
  const [feedStatus, setFeedStatus] = useState<FeedStatus>("connecting");
  const [lastEventAt, setLastEventAt] = useState<number | undefined>();
  const [restSeedTick, setRestSeedTick] = useState(0); // manual retry counter
  const [asset, setAsset] = useState<AssetTab>("crypto");
  const [mode, setMode] = useState<"live" | "upload">("live");
  const [news, setNews] = useState<NewsItem[] | undefined>();
  const [newsError, setNewsError] = useState<string | undefined>();

  // Pending forming-candle update — coalesced so a 250ms kline stream doesn't
  // rebuild the chart on every message. Closed bars flush immediately.
  const pendingCandle = useRef<Candle | undefined>(undefined);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flushCandle = useCallback(() => {
    const pending = pendingCandle.current;
    pendingCandle.current = undefined;
    if (pending === undefined) return;
    setCandlesSet((state) => {
      if (state === undefined || state.symbol !== symbol || state.timeframe !== timeframe) {
        return state;
      }
      const candles = state.candles;
      const last = candles[candles.length - 1];
      let next: Candle[];
      if (last !== undefined && pending.time === last.time) {
        next = [...candles.slice(0, -1), pending];
      } else if (last !== undefined && pending.time > last.time) {
        next = [...candles.slice(-499), pending];
      } else {
        return state; // out-of-order stream frame — drop, never reorder history
      }
      return { ...state, candles: next, hasForming: true };
    });
  }, [symbol, timeframe]);

  // REST seed: quotes (all allowlisted symbols) + klines for the selection.
  useEffect(() => {
    let cancelled = false;
    void fetchCryptoQuotes(CRYPTO_SYMBOLS.map((s) => s.symbol)).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setQuotesError(undefined);
        setQuotes((prev) => {
          const next = { ...prev };
          for (const q of res.data) next[q.symbol] = q;
          return next;
        });
      } else {
        setQuotesError(res.error.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [restSeedTick]);

  useEffect(() => {
    let cancelled = false;
    void fetchCryptoKlines(symbol, timeframe).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setCandlesSet({
          symbol,
          timeframe,
          candles: res.data.candles,
          hasForming: res.data.hasFormingCandle,
          warnings: res.data.warnings,
        });
        setCandlesError(undefined);
      } else {
        setCandlesError({ symbol, timeframe, message: res.error.message });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe, restSeedTick]);

  // Public headlines — one cached server-side fetch, honest on failure.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/crypto-news")
      .then(async (r) => {
        const body = (await r.json()) as { items?: NewsItem[]; error?: { message?: string } };
        if (cancelled) return;
        if (!r.ok || !body.items) {
          setNewsError(body.error?.message ?? `news failed (HTTP ${r.status})`);
          setNews([]);
        } else {
          setNews(body.items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNewsError("news feed unreachable");
          setNews([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live feed — one combined stream: per-symbol tickers + selected kline.
  // Rebuilt when the chart selection changes; torn down on unmount.
  useEffect(() => {
    const interval = binanceInterval(timeframe);
    const streams = [...tickerStreams(CRYPTO_SYMBOLS.map((s) => s.symbol))];
    if (interval !== undefined) streams.push(klineStream(symbol, interval));
    const feed = new BinanceStream({
      streams,
      onStatus: (status, lastEvent) => {
        setFeedStatus(status);
        if (lastEvent !== undefined) setLastEventAt(lastEvent);
      },
      onMessage: (envelope) => {
        if (envelope.stream.endsWith("@ticker")) {
          const sym = envelope.stream.split("@")[0].toUpperCase();
          const quote = normalizeTicker(envelope.data, sym);
          if (quote !== undefined) {
            setQuotes((prev) => ({ ...prev, [sym]: quote }));
          }
          return;
        }
        if (envelope.stream.includes("@kline_")) {
          const sym = envelope.stream.split("@")[0].toUpperCase();
          if (sym !== symbol) return;
          const update = normalizeStreamKline(envelope.data);
          if (update === undefined) return;
          pendingCandle.current = update.candle;
          if (update.isClosed) {
            if (flushTimer.current !== undefined) clearTimeout(flushTimer.current);
            flushCandle();
            setCandlesSet((state) =>
              state !== undefined && state.symbol === symbol && state.timeframe === timeframe
                ? { ...state, hasForming: false }
                : state,
            );
            return;
          }
          if (flushTimer.current === undefined) {
            flushTimer.current = setTimeout(() => {
              flushTimer.current = undefined;
              flushCandle();
            }, 700);
          }
        }
      },
    });
    feed.start();
    return () => feed.close();
  }, [symbol, timeframe, flushCandle]);

  const feedMeta = FEED_META[feedStatus];
  const FeedIcon = feedMeta.icon;
  const info = cryptoSymbolInfo(symbol);
  const quotesStale = feedStatus === "stale" || feedStatus === "offline";
  // Loading is derived: state exists only for a matching selection.
  const candlesFresh =
    candlesSet !== undefined && candlesSet.symbol === symbol && candlesSet.timeframe === timeframe
      ? candlesSet
      : undefined;
  const candlesErrorFresh =
    candlesError !== undefined &&
    candlesError.symbol === symbol &&
    candlesError.timeframe === timeframe
      ? candlesError
      : undefined;

  // Deterministic signal analysis over the exact bars on screen — recomputed
  // on every candle update so the live forming bar keeps the read honest.
  const analysis = useMemo(
    () => (candlesFresh && candlesFresh.candles.length >= 60 ? analyzeCandles(candlesFresh.candles) : undefined),
    [candlesFresh],
  );

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
        out.push({ kind: "level", id: "sig-entry", layer: "structure", price: s.entry, label: "Entry", direction: dir });
      }
      if (s.stopLoss !== undefined) {
        out.push({ kind: "level", id: "sig-sl", layer: "liquidity", price: s.stopLoss, label: "Stop loss", direction: dir });
      }
      s.targets.forEach((t, i) => {
        out.push({ kind: "level", id: `sig-tp-${i}`, layer: "structure", price: t.price, label: `${t.label} · ${t.rr}R`, direction: dir });
      });
    }
    return out;
  }, [analysis]);

  const signalMarkers = useMemo<ChartMarker[]>(() => {
    const s = analysis?.signal;
    const lastCandle = candlesFresh?.candles[candlesFresh.candles.length - 1];
    if (!analysis || s === undefined || s.direction === "wait" || lastCandle === undefined) return [];
    return [
      {
        time: lastCandle.time,
        position: s.direction === "bullish" ? "belowBar" : "aboveBar",
        shape: s.direction === "bullish" ? "arrowUp" : "arrowDown",
        color: s.direction,
        text: `${s.direction === "bullish" ? "BUY" : "SELL"} ${s.confidence}%`,
      },
    ];
  }, [analysis, candlesFresh]);

  const chipCls = (active: boolean) =>
    cn(
      "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
      active
        ? "bg-primary-muted text-foreground"
        : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
    );

  return (
    <div className="grid gap-6 lg:grid-cols-[230px_minmax(0,1fr)]">
      {/* Left rail — asset class picker + headlines */}
      <div className="space-y-4">
        <Card>
          <CardHeader title="Markets" description="Pick an asset class." />
          <div className="flex flex-col gap-1 px-2 pb-3" role="tablist" aria-label="Asset classes">
            {ASSET_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={asset === t.id}
                onClick={() => setAsset(t.id)}
                className={cn(
                  "flex flex-col rounded-md px-3 py-2 text-left transition-colors",
                  asset === t.id
                    ? "bg-primary-muted text-foreground"
                    : "text-muted-foreground hover:bg-surface-hover",
                )}
              >
                <span className="text-sm font-medium">{t.label}</span>
                <span className="text-[11px] text-subtle-foreground">{t.note}</span>
              </button>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Market news" description="Public headlines — CryptoCompare, cached 5 min." />
          <div className="px-3 pb-3">
            {news === undefined ? (
              <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Loading headlines…
              </div>
            ) : newsError !== undefined || news.length === 0 ? (
              <p className="py-1 text-xs text-muted-foreground">
                {newsError ?? "No headlines returned."}
              </p>
            ) : (
              <ul className="space-y-2.5">
                {news.map((n, i) => (
                  <li key={i}>
                    <a
                      href={n.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block text-xs leading-snug text-foreground hover:underline"
                    >
                      {n.title}
                      <span className="mt-0.5 block text-[10px] text-subtle-foreground">
                        {n.source}
                        {n.publishedAt !== undefined ? ` · ${relTime(n.publishedAt)}` : ""}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      {/* Main column */}
      <div className="min-w-0 space-y-4">
        <div className="flex gap-1.5" role="tablist" aria-label="Analysis mode">
          <button type="button" role="tab" aria-selected={mode === "live"} onClick={() => setMode("live")} className={chipCls(mode === "live")}>
            <LineChart className="size-3.5" aria-hidden="true" /> Live chart
          </button>
          <button type="button" role="tab" aria-selected={mode === "upload"} onClick={() => setMode("upload")} className={chipCls(mode === "upload")}>
            <ImageUp className="size-3.5" aria-hidden="true" /> Upload a chart
          </button>
        </div>

        {mode === "upload" ? (
          <ChartAnalystWorkspace />
        ) : asset !== "crypto" ? (
          <Notice tone="info" title={`${ASSET_TABS.find((t) => t.id === asset)?.label ?? "This market"} — no live feed connected`}>
            This platform has no licensed {asset === "forex" ? "forex" : "Indian market"} data feed, so
            nothing is shown rather than unverified prices. You can still use{" "}
            <button type="button" onClick={() => setMode("upload")} className="font-medium underline">
              Upload a chart
            </button>{" "}
            to analyse a screenshot, or pick Crypto for the live Binance feed.
          </Notice>
        ) : (
          <>
            {/* Feed status strip — real stream state, verbatim. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-surface px-4 py-3">
              <Badge tone={feedMeta.tone}>
                <FeedIcon
                  className={cn(feedStatus === "connecting" && "animate-spin")}
                  aria-hidden="true"
                />
                <span>{feedMeta.label}</span>
              </Badge>
              <span className="text-xs text-muted-foreground">
                Source: <span className="font-medium text-foreground">{VENUE_LABEL}</span> public feed
              </span>
              {lastEventAt !== undefined ? (
                <span className="numeric text-xs text-muted-foreground">
                  Last update {fmtUtcTime(lastEventAt)}
                  {quotesStale ? " — values are last-received" : ""}
                </span>
              ) : (
                <span className="text-xs text-subtle-foreground">Awaiting first update</span>
              )}
            </div>

            {quotesError !== undefined ? (
              <Notice
                tone="error"
                title="Quotes unavailable"
                action={
                  <button
                    type="button"
                    onClick={() => setRestSeedTick((n) => n + 1)}
                    className="rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-surface-hover"
                  >
                    Retry
                  </button>
                }
              >
                {quotesError}. No substitute data is shown.
              </Notice>
            ) : null}

            {/* Pair picker — compact chips with live last price + 24h change. */}
            <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Trading pairs">
              {CRYPTO_SYMBOLS.map((s) => {
                const q = quotes[s.symbol];
                return (
                  <button
                    key={s.symbol}
                    type="button"
                    role="tab"
                    aria-selected={s.symbol === symbol}
                    onClick={() => setSymbol(s.symbol)}
                    className={cn(
                      "flex flex-col rounded-md border px-2.5 py-1.5 text-left transition-colors",
                      s.symbol === symbol
                        ? "border-primary/50 bg-primary-muted/40"
                        : "border-border hover:bg-surface-hover",
                    )}
                  >
                    <span className="text-xs font-semibold">{s.label}</span>
                    <span className="numeric text-[11px] text-muted-foreground">
                      {q ? fmtPrice(q.last, s.pricePrecision) : "—"}
                      {q ? (
                        <span className={q.changePct24h >= 0 ? " text-bullish" : " text-bearish"}>
                          {" "}{q.changePct24h >= 0 ? "+" : ""}{q.changePct24h.toFixed(2)}%
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Live chart + signal overlays */}
            <Card>
              <CardHeader
                title={`${info?.label ?? symbol} — ${VENUE_LABEL}`}
                description="OHLCV from the provider's public klines endpoint; the final bar updates live while forming."
                action={
                  <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Timeframes">
                    {CRYPTO_INTERVALS.map((i) => (
                      <button
                        key={i.timeframe}
                        type="button"
                        role="tab"
                        aria-selected={i.timeframe === timeframe}
                        onClick={() => setTimeframe(i.timeframe)}
                        className={chipCls(i.timeframe === timeframe)}
                      >
                        {i.label}
                      </button>
                    ))}
                  </div>
                }
              />
              <div className="flex min-h-[380px] flex-col p-2">
                {candlesErrorFresh !== undefined ? (
                  <div className="p-4">
                    <Notice
                      tone="error"
                      title="Candles unavailable"
                      action={
                        <button
                          type="button"
                          onClick={() => setRestSeedTick((n) => n + 1)}
                          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-surface-hover"
                        >
                          Retry
                        </button>
                      }
                    >
                      {candlesErrorFresh.message}. Historical values are not substituted.
                    </Notice>
                  </div>
                ) : candlesFresh === undefined ? (
                  <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Loading {info?.label} candles…
                  </div>
                ) : candlesFresh.candles.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    The provider returned no candles for this window.
                  </div>
                ) : (
                  <>
                    <CandlestickChart
                      candles={candlesFresh.candles}
                      timeframe={timeframe}
                      overlays={signalOverlays}
                      markers={signalMarkers}
                      pricePrecision={info?.pricePrecision ?? 2}
                    />
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 pb-2 text-[11px] text-subtle-foreground">
                      <span>
                        {candlesFresh.candles.length} bars · {VENUE_LABEL}
                      </span>
                      {candlesFresh.hasForming ? <span>Last bar still forming</span> : null}
                      {candlesFresh.warnings.length > 0 ? (
                        <span className="text-warning">
                          {candlesFresh.warnings.length} normalization warning(s)
                        </span>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            </Card>

            {/* Signal card — deterministic read of the bars on screen. */}
            <Card>
              <CardHeader
                title="Signal analysis"
                description="Measured from the candles on this chart — EMA trend, swing structure, demand/supply zones, ATR sizing."
                action={
                  analysis !== undefined && analysis.signal.direction !== "wait" ? (
                    <Badge tone={analysis.signal.direction === "bullish" ? "bullish" : "bearish"}>
                      {analysis.signal.direction === "bullish" ? "BUY" : "SELL"} · confluence {analysis.signal.confidence}%
                    </Badge>
                  ) : analysis !== undefined ? (
                    <Badge tone="neutral">WAIT · confluence {analysis.signal.confidence}%</Badge>
                  ) : undefined
                }
              />
              <div className="px-5 pb-5">
                {candlesFresh === undefined || candlesFresh.candles.length < 60 ? (
                  <p className="py-2 text-xs text-muted-foreground">
                    {candlesFresh === undefined ? "Waiting for candles…" : "Need at least 60 bars for a structural read."}
                  </p>
                ) : analysis === undefined ? (
                  <p className="py-2 text-xs text-muted-foreground">Analysing…</p>
                ) : (
                  <div className="space-y-4">
                    {analysis.signal.direction !== "wait" ? (
                      <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                        <div>
                          <p className="text-subtle-foreground">Entry</p>
                          <p className="numeric text-sm font-medium">{fmtPrice(analysis.signal.entry ?? 0, info?.pricePrecision ?? 2)}</p>
                        </div>
                        <div>
                          <p className="text-subtle-foreground">Stop loss</p>
                          <p className="numeric text-sm font-medium text-bearish">{fmtPrice(analysis.signal.stopLoss ?? 0, info?.pricePrecision ?? 2)}</p>
                        </div>
                        {analysis.signal.targets.map((t) => (
                          <div key={t.label}>
                            <p className="text-subtle-foreground">{t.label} ({t.rr}R)</p>
                            <p className="numeric text-sm font-medium text-bullish">{fmtPrice(t.price, info?.pricePrecision ?? 2)}</p>
                          </div>
                        ))}
                      </div>
                    ) : null}

                    <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                      <div>
                        <p className="text-subtle-foreground">Trend</p>
                        <p className="font-medium capitalize">{analysis.trend.direction}</p>
                      </div>
                      <div>
                        <p className="text-subtle-foreground">Structure</p>
                        <p className="font-medium">{analysis.structure.note}</p>
                      </div>
                      <div>
                        <p className="text-subtle-foreground">RSI (14)</p>
                        <p className="numeric font-medium">{analysis.momentum.rsi14.toFixed(0)}</p>
                      </div>
                      <div>
                        <p className="text-subtle-foreground">ATR (14)</p>
                        <p className="numeric font-medium">{fmtPrice(analysis.volatility.atr14, info?.pricePrecision ?? 2)}</p>
                      </div>
                    </div>

                    {analysis.signal.reasons.length > 0 ? (
                      <div>
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle-foreground">Why</p>
                        <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                          {analysis.signal.reasons.map((r, i) => <li key={i}>{r}</li>)}
                        </ul>
                      </div>
                    ) : null}

                    <p className="text-[11px] leading-relaxed text-subtle-foreground">
                      {analysis.caveats.join(" ")}
                    </p>
                  </div>
                )}
              </div>
            </Card>

            <Notice tone="info" title="Venue-specific prices">
              Quotes and candles are {VENUE_LABEL} prices — they may differ from other exchanges and
              are not a consolidated global price. Signals are deterministic measurements of the
              chart you see, not financial advice.
            </Notice>
          </>
        )}
      </div>
    </div>
  );
}
