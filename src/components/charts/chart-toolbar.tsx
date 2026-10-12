"use client";

import {
  CandlestickChart,
  ChartLine,
  Expand,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { Select } from "@/components/ui/field";
import { FEATURED_INSTRUMENTS, TIMEFRAMES } from "@/lib/constants";
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

const VIEW_CONTROLS: { label: string; icon: LucideIcon }[] = [
  { label: "Zoom in", icon: ZoomIn },
  { label: "Zoom out", icon: ZoomOut },
  { label: "Reset view", icon: RotateCcw },
  { label: "Fullscreen", icon: Expand },
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
}: ChartToolbarProps) {
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
          {FEATURED_INSTRUMENTS.map((asset) => (
            <option key={asset.id} value={asset.symbol}>
              {asset.symbol}
            </option>
          ))}
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

      <div role="group" aria-label="View controls" className="ml-auto flex items-center gap-0.5">
        {VIEW_CONTROLS.map(({ label, icon: Icon }) => (
          <button
            key={label}
            type="button"
            disabled
            aria-label={label}
            title={`${label} — available when the chart engine is connected`}
            className="flex size-7 items-center justify-center rounded text-subtle-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}
