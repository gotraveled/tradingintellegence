"use client";

import { CandlestickChart, Crosshair, RefreshCw, ShieldAlert, TriangleAlert, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TradePlan } from "@/components/opportunities/trade-plan";
import { DemoBadge } from "@/components/shared/demo";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { getInstrument, ROUTES, timeframeLabel } from "@/lib/constants";
import { CandlesClientError, fetchCandles } from "@/lib/services/candles-runner";
import type { ServiceStatus } from "@/lib/services/system-status";
import {
  chartAnalysisRequest,
  pickCell,
  pickOpportunities,
  runAnalysis,
} from "@/lib/services/analysis-runner";
import type { DataSource } from "@/lib/services/intelligence";
import { ServiceUnavailableError } from "@/lib/services/types";
import type { AnalysisSnapshot, CandlesResult, Timeframe } from "@/lib/types";
import {
  buildChartHref,
  buildChartQuery,
  cn,
  parseChartSelection,
  serializeQuery,
  type ChartQuery,
} from "@/lib/utils";
import { AnalysisPanel } from "./analysis-panel";
import { ChartCapabilityStrip } from "./chart-capability-strip";
import { selectChartOverlays, selectTradePlanView, type OverlayLayer } from "./chart-types";
import { LiveAnalysisPanel, type LiveAnalysisView } from "./live-analysis-panel";
import type { CandlestickChartHandle } from "./candlestick-chart";
import { ChartToolbar, type ChartStyle } from "./chart-toolbar";
import { PriceChart } from "./price-chart";

type MobilePanel = "chart" | "plan" | "analysis";

const MOBILE_PANELS: { id: MobilePanel; label: string }[] = [
  { id: "chart", label: "Chart" },
  { id: "plan", label: "Trade plan" },
  { id: "analysis", label: "Analysis" },
];

interface ChartWorkspaceProps {
  snapshots: Record<string, AnalysisSnapshot>;
  source: DataSource;
  /** Resolved `/chart` search params — the URL is the selection source of truth. */
  searchParams: ChartQuery;
  /** Server-derived service status — rendered verbatim, never probed client-side. */
  services: ServiceStatus[];
}

const DEFAULT_LAYERS: Record<OverlayLayer, boolean> = {
  structure: true,
  zones: true,
  liquidity: true,
  imbalance: false,
};

/** Bars fetched per symbol/timeframe — bounded by the server (CANDLES_MAX_BARS). */
const CHART_BARS = 300;

type CandlesState =
  | { status: "loading" }
  | { status: "success"; result: CandlesResult }
  | { status: "empty"; result: CandlesResult }
  /** Provider answered with data too sparse to chart honestly — not an error,
   *  not a usable chart: distinct from both `empty` and `success`. */
  | { status: "insufficient"; result: CandlesResult }
  | { status: "unsupported"; message: string }
  | { status: "unconfigured"; message: string }
  | { status: "error"; message: string };

function candlesFailure(error: unknown): CandlesState {
  if (error instanceof ServiceUnavailableError) {
    return { status: "unconfigured", message: error.message };
  }
  if (error instanceof CandlesClientError) {
    const unsupported =
      error.code === "unsupported_symbol" ||
      error.code === "unsupported_timeframe" ||
      error.code === "data_not_available";
    return unsupported
      ? { status: "unsupported", message: error.message }
      : { status: "error", message: error.message };
  }
  return { status: "error", message: error instanceof Error ? error.message : "Chart failed." };
}

type LiveState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; view: LiveAnalysisView }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

/** Module-level fetch helper — the effect body contains no setState call. */
function loadCandles(
  symbol: string,
  timeframe: Timeframe,
  signal: AbortSignal,
  done: (state: CandlesState) => void,
): void {
  fetchCandles({ symbol, timeframe, bars: CHART_BARS }, { signal })
    .then((result) =>
      done(
        result.candleCount === 0
          ? { status: "empty", result }
          : result.sufficiency === "insufficient"
            ? { status: "insufficient", result }
            : { status: "success", result },
      ),
    )
    .catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      done(candlesFailure(error));
    });
}

export function ChartWorkspace({
  snapshots,
  source,
  searchParams,
  services,
}: ChartWorkspaceProps) {
  const router = useRouter();
  const urlSelection = parseChartSelection(searchParams);
  const {
    symbol: urlSymbol,
    autoAnalyze,
    normalized,
  } = urlSelection;
  // A valid `timeframe` param always wins. When it's absent, the symbol's demo
  // snapshot timeframe is the documented fallback (snapshot overlays only exist
  // for that timeframe), else the shared DEFAULT_TIMEFRAME.
  const urlTimeframe = urlSelection.timeframeFromUrl
    ? urlSelection.timeframe
    : snapshots[urlSymbol]?.timeframe ?? urlSelection.timeframe;
  const [symbol, setSymbol] = useState(urlSymbol);
  const [timeframe, setTimeframe] = useState<Timeframe>(urlTimeframe);
  const [appliedUrl, setAppliedUrl] = useState(`${urlSymbol}|${urlTimeframe}`);
  const [chartStyle, setChartStyle] = useState<ChartStyle>("candles");
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  const [panel, setPanel] = useState<MobilePanel>("chart");
  const [retryCount, setRetryCount] = useState(0);
  // The latest completed fetch, tagged with the request that produced it. When the
  // selection changes, the key mismatch itself renders `loading` — no synchronous
  // setState inside the effect is needed.
  const [fetched, setFetched] = useState<{ key: string; state: CandlesState }>({
    key: "",
    state: { status: "loading" },
  });
  const [chartReady, setChartReady] = useState(false);
  const [live, setLive] = useState<{ key: string; state: LiveState }>({
    key: "",
    state: { status: "idle" },
  });
  const chartHandle = useRef<CandlestickChartHandle | undefined>(undefined);
  const analyzeAbort = useRef<AbortController | undefined>(undefined);
  /** Armed by `?analyze=1`, consumed by the first successful candle load. */
  const pendingAutoAnalyze = useRef(false);
  /** Below xl only the selected panel is shown; at xl and up all panels are visible. */
  const visibleOn = (id: MobilePanel) => (panel === id ? "" : "hidden xl:block");

  const snapshot = snapshots[symbol];
  const precision = getInstrument(symbol)?.pricePrecision ?? 2;
  const demo = source === "demo";
  const timeframeMismatch = snapshot && snapshot.timeframe !== timeframe;

  const requestKey = `${symbol}|${timeframe}|${retryCount}`;
  const candlesState: CandlesState =
    fetched.key === requestKey ? fetched.state : { status: "loading" };

  // Real candles per [symbol, timeframe] — the in-flight request aborts when the
  // selection changes; setState only ever runs inside async callbacks.
  useEffect(() => {
    const controller = new AbortController();
    loadCandles(symbol, timeframe, controller.signal, (state) =>
      setFetched({ key: requestKey, state }),
    );
    return () => controller.abort();
  }, [symbol, timeframe, requestKey]);

  // External navigation (links, back/forward, refresh) is the source of truth:
  // adopt the URL's resolved selection. Render-time reset — the `appliedUrl` key
  // only diverges when searchParams actually changed (analyzed once per commit),
  // so this can never revert an in-progress user selection or loop.
  const urlKey = `${urlSymbol}|${urlTimeframe}`;
  if (appliedUrl !== urlKey) {
    setAppliedUrl(urlKey);
    setSymbol(urlSymbol);
    setTimeframe(urlTimeframe);
  }

  // URL hygiene: arm the one-shot auto-analyze intent and normalize the URL —
  // invalid `symbol`/`timeframe` params are rewritten to the resolved selection
  // and `analyze` is always stripped so a refresh or remount cannot refire it.
  // `buildChartQuery` is canonical: on an already-normalized URL it produces the
  // same string as `serializeQuery`, so the replace runs at most once per URL.
  useEffect(() => {
    if (autoAnalyze) pendingAutoAnalyze.current = true;
    if (!autoAnalyze && !normalized) return;
    const nextQuery = buildChartQuery(searchParams, {
      symbol: urlSymbol,
      timeframe: urlTimeframe,
    });
    if (nextQuery === serializeQuery(searchParams)) return;
    router.replace(`${ROUTES.chart}?${nextQuery}`, { scroll: false });
  }, [autoAnalyze, normalized, searchParams, urlSymbol, urlTimeframe, router]);

  /** User-driven selection → update state and the URL (replace — no history spam). */
  const applySelection = (nextSymbol: string, nextTimeframe: Timeframe) => {
    // A deliberate reselection ends any pending auto-analyze — it was requested
    // for the linked selection, not whatever the user picks next.
    pendingAutoAnalyze.current = false;
    setSymbol(nextSymbol);
    setTimeframe(nextTimeframe);
    router.replace(
      buildChartHref(searchParams, { symbol: nextSymbol, timeframe: nextTimeframe }),
      { scroll: false },
    );
  };

  const handleSymbolChange = (next: string) => {
    const nextSnapshot = snapshots[next];
    applySelection(next, nextSnapshot ? nextSnapshot.timeframe : timeframe);
  };

  const handleTimeframeChange = (next: Timeframe) => applySelection(symbol, next);

  // An in-flight analysis is obsolete the moment the selection changes — abort it.
  // A returned result can only ever display for the request that produced it: `live`
  // entries are tagged with the analyze key and stale keys render as `idle`.
  useEffect(() => {
    return () => analyzeAbort.current?.abort();
  }, [requestKey]);

  const candlesResult =
    candlesState.status === "success" ||
    candlesState.status === "empty" ||
    candlesState.status === "insufficient"
      ? candlesState.result
      : undefined;
  const marketDataAvailability = services.find(
    (service) => service.id === "market-data",
  )?.dataAvailability;
  const enabledTimeframes = marketDataAvailability?.timeframes;
  const candles = candlesResult?.candles;
  const analysisEnabled =
    candlesState.status === "success" && live.state.status !== "loading";

  const analyze = useCallback(() => {
    if (!candlesResult || candlesResult.candleCount === 0) return;
    const key = `${symbol}|${timeframe}|${candlesResult.window.end}`;
    analyzeAbort.current?.abort();
    const controller = new AbortController();
    analyzeAbort.current = controller;
    const built = chartAnalysisRequest({
      symbol,
      timeframe,
      windowEnd: candlesResult.window.end,
      windowStart: candlesResult.window.start,
    });
    setLive({ key, state: { status: "loading" } });
    runAnalysis(built.request, { signal: controller.signal })
      .then((result) => {
        setLive({
          key,
          state: {
            status: "success",
            view: {
              result,
              cell: pickCell(result, symbol, timeframe),
              opportunities: pickOpportunities(result, symbol, timeframe),
              windowClamped: built.windowClamped,
              lookbackDays: built.lookbackDays,
            },
          },
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLive({
          key,
          state:
            error instanceof ServiceUnavailableError
              ? { status: "unavailable", message: error.message }
              : {
                  status: "error",
                  message: error instanceof Error ? error.message : "Analysis failed.",
                },
        });
      });
  }, [candlesResult, symbol, timeframe]);

  // One-shot `?analyze=1`: the click that navigated here is the explicit user
  // action. It fires exactly once when candles are ready, and is dropped (not
  // silently deferred) on a terminal non-success candle state — the user can
  // always click Analyze or Retry manually. The call is queued off the effect
  // body so analysis state updates don't cascade synchronously inside a render
  // commit.
  useEffect(() => {
    if (!pendingAutoAnalyze.current) return;
    pendingAutoAnalyze.current = false;
    if (candlesState.status === "success") queueMicrotask(analyze);
  }, [candlesState.status, analyze]);

  const liveState: LiveState = live.key === `${symbol}|${timeframe}|${candlesResult?.window.end ?? ""}` ? live.state : { status: "idle" };
  const liveView = liveState.status === "success" ? liveState.view : undefined;
  // A matching live result replaces reference overlays — demo never masquerades
  // as engine output, and a live verdict with no setup clears the canvas.
  const overlays = useMemo(
    () => selectChartOverlays(liveView?.opportunities, snapshot, layers),
    [liveView, snapshot, layers],
  );
  // The standalone plan panel only ever shows snapshot levels — preview before
  // the engine runs, collapsed reference after. A bare "developing" placeholder
  // would read as a verdict the engine never made.
  const planView = selectTradePlanView(
    snapshot?.opportunity !== undefined,
    liveView !== undefined,
  );

  return (
    <div className="space-y-4">
      <div
        role="group"
        aria-label="Choose panel"
        className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-surface p-1 xl:hidden"
      >
        {MOBILE_PANELS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={panel === item.id}
            onClick={() => setPanel(item.id)}
            className={cn(
              "h-8 rounded-md text-xs font-medium transition-colors",
              panel === item.id
                ? "bg-surface-hover text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div
          className={cn(
            "min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface",
            panel === "chart" ? "flex" : "hidden xl:flex",
          )}
        >
          <ChartCapabilityStrip services={services} />
          <ChartToolbar
            symbol={symbol}
            onSymbolChange={handleSymbolChange}
            timeframe={timeframe}
            onTimeframeChange={handleTimeframeChange}
            chartStyle={chartStyle}
            onChartStyleChange={setChartStyle}
            layers={layers}
            onLayerToggle={(layer) => setLayers((prev) => ({ ...prev, [layer]: !prev[layer] }))}
            onResetView={() => chartHandle.current?.fit()}
            onZoomIn={() => chartHandle.current?.zoomIn()}
            onZoomOut={() => chartHandle.current?.zoomOut()}
            chartReady={chartReady}
            onAnalyze={analyze}
            analyzeEnabled={analysisEnabled}
            analyzing={liveState.status === "loading"}
            enabledTimeframes={enabledTimeframes}
          />
          {candlesResult && candlesState.status !== "loading" ? (
            <p
              className="border-b border-border px-3 py-1.5 text-[11px] text-subtle-foreground"
              aria-label="Data provenance"
            >
              {candlesResult.classification === "delayed" ? "Delayed" : "Historical"} data ·{" "}
              {candlesResult.source.label} aggregates ·{" "}
              {candlesResult.candleCount} bars · retrieved{" "}
              {new Date(candlesResult.retrievedAt).toLocaleString()}
              {candlesResult.quality.missingBarCount > 0
                ? ` · ${candlesResult.quality.missingBarCount} intervals absent (includes expected session closures)`
                : ""}
            </p>
          ) : null}

          {candlesState.status === "loading" ? (
            <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading candles">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-72 w-full" />
            </div>
          ) : null}

          {candlesState.status === "unconfigured" ? (
            <div className="flex min-h-[340px] items-center justify-center p-4">
              <EmptyState
                icon={Unplug}
                title="Market data not configured"
                description={candlesState.message}
              />
            </div>
          ) : null}

          {candlesState.status === "unsupported" ? (
            <div className="flex min-h-[340px] items-center justify-center p-4">
              <EmptyState
                icon={CandlestickChart}
                title="Not available from this provider"
                description={candlesState.message}
              />
            </div>
          ) : null}

          {candlesState.status === "empty" && candlesResult ? (
            <div className="flex min-h-[340px] items-center justify-center p-4">
              <EmptyState
                icon={CandlestickChart}
                title="No data in this window"
                description={`${candlesResult.source.label} returned no ${timeframeLabel(timeframe)} bars for ${symbol} in the requested range.`}
              />
            </div>
          ) : null}

          {candlesState.status === "insufficient" && candlesResult ? (
            <div className="flex min-h-[340px] items-center justify-center p-4">
              <EmptyState
                icon={TriangleAlert}
                title="Insufficient data in this window"
                description={`${candlesResult.source.label} returned only ${candlesResult.candleCount} ${timeframeLabel(timeframe)} bars for ${symbol} — too sparse to chart or analyze. The configured plan may not cover this interval.`}
              />
            </div>
          ) : null}

          {candlesState.status === "error" ? (
            <div className="flex min-h-[340px] items-center justify-center p-4">
              <EmptyState
                icon={RefreshCw}
                title="Candles could not be loaded"
                description={candlesState.message}
                action={
                  <button
                    type="button"
                    onClick={() => setRetryCount((c) => c + 1)}
                    className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-hover"
                  >
                    Retry
                  </button>
                }
              />
            </div>
          ) : null}

          {candlesState.status === "success" ? (
            <PriceChart
              symbol={symbol}
              timeframe={timeframe}
              candles={candles}
              overlays={overlays}
              chartStyle={chartStyle}
              pricePrecision={precision}
              className="min-h-[340px] sm:min-h-[440px] xl:min-h-[560px]"
              onChartReady={(handle) => {
                chartHandle.current = handle;
                setChartReady(handle !== undefined);
              }}
            />
          ) : null}
          {timeframeMismatch && !liveView ? (
            <p className="border-t border-border px-4 py-2 text-[11px] text-subtle-foreground">
              {demo ? "Demo" : "Snapshot"} analysis for {symbol} is available on{" "}
              {timeframeLabel(snapshot.timeframe)} only; overlays shown are from that timeframe.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-6">
          <div className={cn("order-2 xl:order-1", visibleOn("analysis"))}>
            <div className="space-y-4">
              {liveState.status === "loading" ? (
                <section
                  aria-label="Analysis in progress"
                  aria-busy="true"
                  className="space-y-3 rounded-lg border border-border bg-surface p-4"
                >
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-24 w-full" />
                  <p className="text-[11px] text-subtle-foreground">
                    Evaluating {symbol} at the last closed bar…
                  </p>
                </section>
              ) : null}

              {liveState.status === "unavailable" ? (
                <section
                  aria-label="Analysis unavailable"
                  className="rounded-lg border border-border bg-surface p-4"
                >
                  <EmptyState
                    icon={Unplug}
                    title="Analysis unavailable"
                    description={liveState.message}
                  />
                </section>
              ) : null}

              {liveState.status === "error" ? (
                <section
                  aria-label="Analysis error"
                  className="rounded-lg border border-border bg-surface p-4"
                >
                  <EmptyState
                    icon={RefreshCw}
                    title="Analysis failed"
                    description={liveState.message}
                    action={
                      <button
                        type="button"
                        onClick={analyze}
                        className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-hover"
                      >
                        Retry
                      </button>
                    }
                  />
                </section>
              ) : null}

              {liveView ? (
                <LiveAnalysisPanel
                  view={liveView}
                  symbol={symbol}
                  timeframe={timeframe}
                  pricePrecision={precision}
                />
              ) : null}

              {/* Once a real verdict exists for this selection, the reference
                  snapshot defers behind a disclosure so demo levels cannot read
                  as corroboration. Without a snapshot the panel's only content
                  is its "engine not connected" empty state — false after a
                  successful run — so it renders nothing here. */}
              {liveView ? (
                snapshot ? (
                  <details className="group rounded-lg border border-border bg-surface">
                    <summary className="cursor-pointer select-none px-4 py-3 text-xs font-medium text-subtle-foreground transition-colors hover:text-foreground">
                      Reference snapshot{demo ? " (demo)" : ""} — precomputed{" "}
                      {timeframeLabel(snapshot.timeframe)} analysis, not the engine run above
                    </summary>
                    <AnalysisPanel
                      snapshot={snapshot}
                      symbol={symbol}
                      demo={demo}
                      pricePrecision={precision}
                    />
                  </details>
                ) : null
              ) : (
                <AnalysisPanel
                  snapshot={snapshot}
                  symbol={symbol}
                  demo={demo}
                  pricePrecision={precision}
                />
              )}
            </div>
          </div>

          {/* The standalone trade plan only ever presents snapshot content:
              preview before the engine runs, collapsed reference after. */}
          {planView === "reference" && snapshot?.opportunity ? (
            <details
              className={cn(
                "order-1 rounded-lg border border-border bg-surface xl:order-2",
                visibleOn("plan"),
              )}
            >
              <summary className="cursor-pointer select-none px-4 py-3 text-xs font-medium text-subtle-foreground transition-colors hover:text-foreground">
                Reference trade plan{demo ? " (demo)" : ""} — not the engine result
              </summary>
              <div className="space-y-3 p-4 pt-0">
                <TradePlan layout="stack" plan={snapshot.opportunity} />
                <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-subtle-foreground">
                  <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                  Reference levels from the precomputed snapshot — superseded by the engine
                  analysis result.
                </p>
              </div>
            </details>
          ) : planView === "preview" && snapshot?.opportunity ? (
            <section
              aria-label="Trade plan"
              className={cn(
                "order-1 rounded-lg border border-border bg-surface xl:order-2",
                visibleOn("plan"),
              )}
            >
              <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold">Trade plan</h2>
                {demo ? <DemoBadge /> : null}
              </header>
              <div className="space-y-3 p-4">
                <TradePlan layout="stack" plan={snapshot.opportunity} />
                <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-subtle-foreground">
                  <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                  {demo
                    ? "Preview levels from a precomputed demo snapshot — illustrative, not an engine verdict. Run Analyze for a live result."
                    : "Levels from a precomputed snapshot — not the latest engine run. Run Analyze for a live result."}
                </p>
              </div>
            </section>
          ) : (
            <section
              aria-label="Trade plan"
              className={cn(
                "order-1 rounded-lg border border-border bg-surface xl:order-2",
                visibleOn("plan"),
              )}
            >
              <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold">Trade plan</h2>
              </header>
              <div className="p-4">
                {planView === "empty" ? (
                  <EmptyState
                    icon={Crosshair}
                    title="No trade plan yet"
                    description={`Run Analyze to evaluate ${symbol} on ${timeframeLabel(timeframe)} at the last closed bar.`}
                  />
                ) : (
                  <EmptyState
                    icon={Crosshair}
                    title="No reference trade plan"
                    description="No precomputed snapshot exists for this instrument. The engine result is shown under Engine analysis."
                  />
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
