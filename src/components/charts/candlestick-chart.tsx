"use client";

import { useEffect, useRef } from "react";
import type { ISeriesApi, UTCTimestamp } from "lightweight-charts";
import type { Candle, Price, Timeframe } from "@/lib/types";
import type { ChartOverlay, OverlayLayer } from "./chart-types";

/**
 * Lightweight-Charts rendering surface — the only module that depends on the chart
 * library. The package is dynamically imported inside the effect so it stays out of
 * the server bundle and the initial client chunk (code-split per route).
 *
 * The component is intentionally imperative: React owns props, the chart owns canvas.
 * A full rebuild per [candles, overlays, chartStyle] is deliberate — at ≤2000 bars it
 * is cheap and keeps data/overlay/lifecycle reasoning simple and leak-free.
 */

export interface CandlestickChartHandle {
  /** Restore the full data range — "Reset view". */
  fit: () => void;
  /** Increase bar spacing — "Zoom in". */
  zoomIn: () => void;
  /** Decrease bar spacing — "Zoom out". */
  zoomOut: () => void;
}

export interface ChartMarker {
  /** Bar time in Unix ms — must match an existing candle's time. */
  time: number;
  position: "aboveBar" | "belowBar";
  shape: "arrowUp" | "arrowDown";
  color: string;
  text?: string;
}

interface CandlestickChartProps {
  candles: Candle[];
  timeframe: Timeframe;
  overlays?: ChartOverlay[];
  markers?: ChartMarker[];
  chartStyle?: "candles" | "line";
  pricePrecision?: number;
  /** Receives the imperative handle once the chart exists; undefined after unmount. */
  onReady?: (handle: CandlestickChartHandle | undefined) => void;
}

let colorCanvas: CanvasRenderingContext2D | null | undefined;

/**
 * Normalize any CSS color to an sRGB `rgba()` string LWC's parser accepts.
 * The theme's CSS variables are oklch; getComputedStyle returns lab() tokens,
 * which LWC cannot parse (silent black series). Rasterizing a 1×1 cell and
 * reading the pixel back converts whatever the browser accepted — lab, oklch,
 * color-mix — without reimplementing color math. Returns undefined when the
 * browser itself rejects the value, so callers fall back.
 */
function normalizeCssColor(value: string): string | undefined {
  if (value === "") return undefined;
  if (value.startsWith("#") || value.startsWith("rgb")) return value;
  if (colorCanvas === undefined) {
    colorCanvas = document.createElement("canvas").getContext("2d");
  }
  if (colorCanvas === null) return undefined;
  colorCanvas.clearRect(0, 0, 1, 1);
  colorCanvas.fillStyle = "rgb(7, 11, 13)"; // sentinel — survives unparseable input
  colorCanvas.fillStyle = value;
  if (colorCanvas.fillStyle === "rgb(7, 11, 13)") return undefined;
  colorCanvas.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = colorCanvas.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(4)})`;
}

/** Read the app's CSS variables so the canvas matches the active theme. */
function theme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => {
    const raw = css.getPropertyValue(name).trim();
    return raw === "" ? fallback : (normalizeCssColor(raw) ?? fallback);
  };
  return {
    background: v("--surface", "#17191f"),
    text: v("--subtle-foreground", "#8a8f98"),
    grid: v("--grid-line", "rgba(255,255,255,0.05)"),
    crosshair: v("--border-strong", "#4a4f5c"),
    up: v("--bullish", "#3fbf7f"),
    down: v("--bearish", "#e25c5c"),
    upMuted: v("--bullish-muted", "rgba(63,191,127,0.12)"),
    downMuted: v("--bearish-muted", "rgba(226,92,92,0.12)"),
    info: v("--info", "#5b8def"),
    warning: v("--warning", "#d9a845"),
    volume: v("--inactive-muted", "rgba(120,125,140,0.18)"),
  };
}

type Colors = ReturnType<typeof theme>;

const LAYER_COLOR = (layer: OverlayLayer, c: Colors): string =>
  layer === "liquidity" ? c.warning : layer === "zones" ? c.up : c.info;

/**
 * Zone band — filled rectangle between `upper`/`lower` across the pane width.
 * Implemented as an ISeriesPrimitive attached to the candle series: y-coords come
 * from `series.priceToCoordinate`, x spans the media pane. One primitive per zone.
 */
function makeZonePrimitive(
  overlay: Extract<ChartOverlay, { kind: "zone" }>,
  colors: Colors,
) {
  let seriesRef: { priceToCoordinate: (price: Price) => number | null } | undefined;
  const border = overlay.zoneType === "demand" ? colors.up : colors.down;
  const fill = overlay.zoneType === "demand" ? colors.upMuted : colors.downMuted;
  return {
    attached(param: {
      series: { priceToCoordinate: (price: Price) => number | null };
    }) {
      seriesRef = param.series;
    },
    detached() {
      seriesRef = undefined;
    },
    updateAllViews() {},
    paneViews() {
      return [
        {
          renderer: () => ({
            draw: (target: {
              useMediaCoordinateSpace: (fn: (scope: {
                context: CanvasRenderingContext2D;
                mediaSize: { width: number; height: number };
              }) => void) => void;
            }) => {
              target.useMediaCoordinateSpace(({ context, mediaSize }) => {
                if (!seriesRef) return;
                const yTop = seriesRef.priceToCoordinate(overlay.upper);
                const yBottom = seriesRef.priceToCoordinate(overlay.lower);
                if (yTop === null || yBottom === null) return;
                const top = Math.min(yTop, yBottom);
                const height = Math.max(Math.abs(yBottom - yTop), 1);
                context.fillStyle = fill;
                context.fillRect(0, top, mediaSize.width, height);
                context.strokeStyle = border;
                context.setLineDash([4, 4]);
                context.beginPath();
                context.moveTo(0, top + 0.5);
                context.lineTo(mediaSize.width, top + 0.5);
                context.moveTo(0, top + height - 0.5);
                context.lineTo(mediaSize.width, top + height - 0.5);
                context.stroke();
                context.setLineDash([]);
              });
            },
          }),
          zOrder: "bottom" as const,
        },
      ];
    },
  };
}

export function CandlestickChart({
  candles,
  timeframe,
  overlays = [],
  markers = [],
  chartStyle = "candles",
  pricePrecision = 2,
  onReady,
}: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || candles.length === 0) return undefined;
    let disposed = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      const LWC = await import("lightweight-charts");
      if (disposed || !containerRef.current) return;
      const colors = theme();
      const chart = LWC.createChart(containerRef.current, {
        autoSize: true,
        layout: {
          background: { type: LWC.ColorType.Solid, color: colors.background },
          textColor: colors.text,
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: colors.grid },
          horzLines: { color: colors.grid },
        },
        crosshair: {
          vertLine: { color: colors.crosshair, labelBackgroundColor: colors.crosshair },
          horzLine: { color: colors.crosshair, labelBackgroundColor: colors.crosshair },
        },
        rightPriceScale: { borderColor: colors.grid },
        timeScale: { borderColor: colors.grid, timeVisible: true, secondsVisible: false },
      });

      const toSec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
      const priceFmt = { type: "price" as const, precision: pricePrecision, minMove: 1 / 10 ** pricePrecision };

      const series =
        chartStyle === "line"
          ? chart.addSeries(LWC.LineSeries, {
              color: colors.info,
              lineWidth: 2,
              priceFormat: priceFmt,
            })
          : chart.addSeries(LWC.CandlestickSeries, {
              upColor: colors.up,
              downColor: colors.down,
              wickUpColor: colors.up,
              wickDownColor: colors.down,
              borderVisible: false,
              priceFormat: priceFmt,
            });

      if (chartStyle === "line") {
        (series as ISeriesApi<"Line">).setData(
          candles.map((c) => ({ time: toSec(c.time), value: c.close })),
        );
      } else {
        (series as ISeriesApi<"Candlestick">).setData(
          candles.map((c) => ({
            time: toSec(c.time),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          })),
        );
      }

      // Volume — bottom overlay lane; only when the feed supplies it.
      if (candles.some((c) => c.volume !== undefined)) {
        const vol = chart.addSeries(LWC.HistogramSeries, {
          priceFormat: { type: "volume" },
          priceScaleId: "vol",
        });
        chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
        vol.setData(
          candles
            .filter((c) => c.volume !== undefined)
            .map((c) => ({
              time: toSec(c.time),
              value: c.volume as number,
              color: c.close >= c.open ? colors.upMuted : colors.downMuted,
            })),
        );
      }

      // Bar markers — signal arrows keyed to candle times. Semantic colors
      // resolve against the theme; anything else passes through verbatim.
      if (markers.length > 0) {
        LWC.createSeriesMarkers(
          series,
          markers.map((m: ChartMarker) => ({
            time: toSec(m.time),
            position: m.position,
            shape: m.shape,
            color:
              m.color === "bullish" ? colors.up : m.color === "bearish" ? colors.down : m.color,
            text: m.text,
          })),
        );
      }

      // Overlays — levels as price lines, zones as filled band primitives.
      for (const overlay of overlays) {
        if (overlay.kind === "level") {
          series.createPriceLine({
            price: overlay.price,
            color: LAYER_COLOR(overlay.layer, colors),
            lineWidth: 1,
            lineStyle: overlay.layer === "liquidity" ? LWC.LineStyle.Dashed : LWC.LineStyle.Solid,
            axisLabelVisible: true,
            title: overlay.label,
          });
        } else {
          (series as { attachPrimitive?: (p: unknown) => void }).attachPrimitive?.(
            makeZonePrimitive(overlay, colors),
          );
        }
      }

      chart.timeScale().fitContent();

      const ts = chart.timeScale();
      onReady?.({
        fit: () => ts.fitContent(),
        zoomIn: () => ts.applyOptions({ barSpacing: ts.options().barSpacing * 1.25 }),
        zoomOut: () => ts.applyOptions({ barSpacing: ts.options().barSpacing / 1.25 }),
      });

      cleanup = () => {
        onReady?.(undefined);
        chart.remove();
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
    // The chart owns canvas state imperatively; a prop change rebuilds it wholesale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, chartStyle, overlays, markers, pricePrecision]);

  return (
    <div
      ref={containerRef}
      className="relative min-h-[300px] w-full flex-1"
      role="img"
      aria-label={`${timeframe} candlestick chart, ${candles.length} bars`}
    />
  );
}
