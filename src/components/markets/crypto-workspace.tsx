"use client";

import {
  Loader2,
  RefreshCw,
  TriangleAlert,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CandlestickChart } from "@/components/charts/candlestick-chart";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { TableShell, type TableColumn } from "@/components/ui/table-shell";
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

const QUOTE_COLUMNS: TableColumn[] = [
  { key: "symbol", label: "Pair" },
  { key: "venue", label: "Venue" },
  { key: "last", label: "Last", align: "right" },
  { key: "change", label: "24h change", align: "right" },
  { key: "high", label: "24h high", align: "right" },
  { key: "low", label: "24h low", align: "right" },
  { key: "volume", label: "24h volume (USDT)", align: "right" },
];

function fmtPrice(value: number, precision: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

function fmtVolume(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(0);
}

/** Provider event time → "14:03:22 UTC". */
function fmtUtcTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19) + " UTC";
}

function QuoteSkeletonRows() {
  return (
    <>
      {CRYPTO_SYMBOLS.map((s) => (
        <tr key={s.symbol} className="border-b border-border last:border-b-0">
          <td className="px-5 py-3" colSpan={QUOTE_COLUMNS.length}>
            <div className="h-4 w-2/3 animate-pulse rounded bg-surface-hover" />
          </td>
        </tr>
      ))}
    </>
  );
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
  const [quotesLoaded, setQuotesLoaded] = useState(false);
  const [candlesSet, setCandlesSet] = useState<CandleSetState | undefined>(undefined);
  const [candlesError, setCandlesError] = useState<CandleErrorState | undefined>(undefined);
  const [feedStatus, setFeedStatus] = useState<FeedStatus>("connecting");
  const [lastEventAt, setLastEventAt] = useState<number | undefined>();
  const [restSeedTick, setRestSeedTick] = useState(0); // manual retry counter

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
      setQuotesLoaded(true);
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

  return (
    <div className="space-y-6">
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

      <Notice tone="info" title="Venue-specific prices">
        Quotes and candles are {VENUE_LABEL} prices — they may differ from other exchanges and are
        not a consolidated global price. Public market data requires no credentials; redistribution
        terms for public websites are under review, so this page is currently a labelled development
        feature.
      </Notice>

      {/* Market overview */}
      <Card>
        <CardHeader
          title="Market overview"
          description={`Live ${VENUE_LABEL} quotes via WebSocket, seeded by REST. Select a pair to load its chart.`}
          action={
            <Badge tone={feedMeta.tone}>
              <FeedIcon aria-hidden="true" />
              <span>{feedMeta.label}</span>
            </Badge>
          }
        />
        {quotesError !== undefined ? (
          <div className="px-5 py-4">
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
          </div>
        ) : null}
        <TableShell caption="Binance Spot market overview" columns={QUOTE_COLUMNS}>
          {!quotesLoaded ? (
            <QuoteSkeletonRows />
          ) : (
            CRYPTO_SYMBOLS.map((s) => {
              const q = quotes[s.symbol];
              const selected = s.symbol === symbol;
              return (
                <tr
                  key={s.symbol}
                  className={cn(
                    "border-b border-border last:border-b-0 transition-colors",
                    selected ? "bg-primary-muted/40" : "hover:bg-surface-hover",
                  )}
                >
                  <th scope="row" className="px-5 py-3 text-left">
                    <button
                      type="button"
                      onClick={() => setSymbol(s.symbol)}
                      aria-pressed={selected}
                      className="text-left"
                    >
                      <span className="numeric font-semibold">{s.label}</span>
                      <span className="block text-xs font-normal text-subtle-foreground">
                        {s.name}
                      </span>
                    </button>
                  </th>
                  <td className="px-5 py-3 text-xs text-muted-foreground">{VENUE_LABEL}</td>
                  <td className="numeric px-5 py-3 text-right font-medium">
                    {q ? fmtPrice(q.last, s.pricePrecision) : "—"}
                  </td>
                  <td
                    className={cn(
                      "numeric px-5 py-3 text-right",
                      q === undefined
                        ? "text-subtle-foreground"
                        : q.changePct24h >= 0
                          ? "text-bullish"
                          : "text-bearish",
                    )}
                  >
                    {q ? `${q.changePct24h >= 0 ? "+" : ""}${q.changePct24h.toFixed(2)}%` : "—"}
                  </td>
                  <td className="numeric px-5 py-3 text-right text-muted-foreground">
                    {q ? fmtPrice(q.high24h, s.pricePrecision) : "—"}
                  </td>
                  <td className="numeric px-5 py-3 text-right text-muted-foreground">
                    {q ? fmtPrice(q.low24h, s.pricePrecision) : "—"}
                  </td>
                  <td className="numeric px-5 py-3 text-right text-muted-foreground">
                    {q ? fmtVolume(q.quoteVolume24h) : "—"}
                  </td>
                </tr>
              );
            })
          )}
        </TableShell>
      </Card>

      {/* Historical + forming candles */}
      <Card>
        <CardHeader
          title={`${info?.label ?? symbol} — ${VENUE_LABEL}`}
          description="OHLCV from the provider's public klines endpoint; the final bar updates live while forming."
        />
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-5 py-3">
          {CRYPTO_SYMBOLS.map((s) => (
            <button
              key={s.symbol}
              type="button"
              onClick={() => setSymbol(s.symbol)}
              aria-pressed={s.symbol === symbol}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                s.symbol === symbol
                  ? "bg-primary-muted text-foreground"
                  : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
          <span className="mx-2 h-4 w-px bg-border" aria-hidden="true" />
          {CRYPTO_INTERVALS.map((i) => (
            <button
              key={i.timeframe}
              type="button"
              onClick={() => setTimeframe(i.timeframe)}
              aria-pressed={i.timeframe === timeframe}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                i.timeframe === timeframe
                  ? "bg-primary-muted text-foreground"
                  : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
              )}
            >
              {i.label}
            </button>
          ))}
        </div>
        <div className="flex min-h-[340px] flex-col p-2">
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
    </div>
  );
}
