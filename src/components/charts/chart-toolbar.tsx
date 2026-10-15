"use client";

import {
  CandlestickChart,
  ChartLine,
  Expand,
  RotateCcw,
  Sparkles,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { Select } from "@/components/ui/field";
import { instrumentsBySegment, MARKET_SEGMENTS, TIMEFRAMES } from "@/lib/constants";
import type { Timeframe } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { OverlayLayer } from "./chart-types";

export type ChartStyle = "candles" | "line";

const LAYERS: { id: OverlayLayer; label: string }[] = [
  { id: "structure", label: "Structure" },
  { id: "zones", label: "Zones" },
  { id: "liquidity", label: "Liquidity" },
  { id: "imbalance", label: "FVG" },
];

const STYLES: { id: ChartStyle; label: string; icon: LucideIcon }[] = [
  { id: "candles", label: "Candles", icon: CandlestickChart },
  { id: "line", label: "Line", icon: ChartLine },
];

interface ChartToolbarProps {
  symbol: string;
  onSymbolChange: (symbol: string) => void;
  timeframe: Timeframe;
  onTimeframeChange: (timeframe: Timeframe) => void;
  chartStyle: ChartStyle;
  onChartStyleChange: (style: ChartStyle) => void;
  layers: Record<OverlayLayer, boolean>;
  onLayerToggle: (layer: OverlayLayer) => void;
  /** View controls — enabled only when a live chart handle exists. */
  onResetView?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  chartReady?: boolean;
  /** Engine analysis of the displayed symbol/timeframe — explicit user action. */
  onAnalyze?: () => void;
  analyzeEnabled?: boolean;
  analyzing?: boolean;
}

function segmentClass(active: boolean) {
  return cn(
    "inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs transition-colors",
    active
      ? "bg-surface-hover text-foreground"
      : "text-subtle-foreground hover:bg-surface-elevated hover:text-foreground",
  );
}

export function ChartToolbar({
  symbol,
  onSymbolChange,
  timeframe,
  onTimeframeChange,
  chartStyle,
  onChartStyleChange,
  layers,
  onLayerToggle,
  onResetView,
  onZoomIn,
  onZoomOut,
  chartReady = false,
  onAnalyze,
  analyzeEnabled = false,
  analyzing = false,
}: ChartToolbarProps) {
  const viewControls: { label: string; icon: LucideIcon; onClick?: () => void }[] = [
    { label: "Zoom in", icon: ZoomIn, onClick: onZoomIn },
    { label: "Zoom out", icon: ZoomOut, onClick: onZoomOut },
    { label: "Reset view", icon: RotateCcw, onClick: onResetView },
    { label: "Fullscreen", icon: Expand },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3 py-2.5">
      <div className="w-44">
        <label htmlFor="chart-symbol" className="sr-only">
          Symbol
        </label>
        <Select
          id="chart-symbol"
          value={symbol}
          onChange={(event) => onSymbolChange(event.target.value)}
          className="h-8 numeric font-semibold"
        >
          {MARKET_SEGMENTS.map((segment) => {
            const assets = instrumentsBySegment(segment.id);
            return assets.length === 0 ? null : (
              <optgroup key={segment.id} label={segment.label}>
                {assets.map((asset) => (
                  <option key={asset.id} value={asset.symbol}>
                    {asset.symbol}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </Select>
      </div>

      <div role="group" aria-label="Timeframe" className="flex items-center gap-0.5">
        {TIMEFRAMES.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={item.value === timeframe}
            onClick={() => onTimeframeChange(item.value)}
            className={cn("numeric", segmentClass(item.value === timeframe))}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="h-5 w-px bg-border" aria-hidden="true" />

      <div role="group" aria-label="Chart style" className="flex items-center gap-0.5">
        {STYLES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={chartStyle === id}
            onClick={() => onChartStyleChange(id)}
            className={segmentClass(chartStyle === id)}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      <div role="group" aria-label="Analysis overlays" className="flex items-center gap-0.5">
        {LAYERS.map((layer) => (
          <button
            key={layer.id}
            type="button"
            aria-pressed={layers[layer.id]}
            onClick={() => onLayerToggle(layer.id)}
            className={segmentClass(layers[layer.id])}
          >
            {layer.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        disabled={!analyzeEnabled || analyzing || onAnalyze === undefined}
        onClick={onAnalyze}
        title={
          analyzeEnabled
            ? `Analyze ${symbol} on ${timeframe} at the last closed bar`
            : "Available once chart data is loaded"
        }
        className="inline-flex h-7 items-center gap-1.5 rounded border border-info/40 bg-info-muted px-2.5 text-xs font-medium text-info transition-colors hover:bg-info-muted/70 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Sparkles className="size-3.5" aria-hidden="true" />
        {analyzing ? "Analyzing…" : "Analyze"}
      </button>

      <div role="group" aria-label="View controls" className="ml-auto flex items-center gap-0.5">
        {viewControls.map(({ label, icon: Icon, onClick }) => {
          const enabled = chartReady && onClick !== undefined;
          return (
            <button
              key={label}
              type="button"
              disabled={!enabled}
              onClick={onClick}
              aria-label={label}
              title={enabled ? label : `${label} — available when the chart has data`}
              className="flex size-7 items-center justify-center rounded text-subtle-foreground hover:bg-surface-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon className="size-3.5" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
