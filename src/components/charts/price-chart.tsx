import { CandlestickChart as CandlestickChartIcon } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { timeframeLabel } from "@/lib/constants";
import { cn, formatPrice } from "@/lib/utils";
import { CandlestickChart } from "./candlestick-chart";
import type { ChartOverlay, PriceChartProps } from "./chart-types";

function overlayRange(overlay: ChartOverlay, precision: number) {
  return overlay.kind === "zone"
    ? `${formatPrice(overlay.lower, precision)} – ${formatPrice(overlay.upper, precision)}`
    : formatPrice(overlay.price, precision);
}

function overlaySwatch(overlay: ChartOverlay) {
  if (overlay.kind === "zone") {
    return overlay.zoneType === "demand"
      ? "border-bullish/50 bg-bullish-muted"
      : "border-bearish/50 bg-bearish-muted";
  }
  if (overlay.layer === "liquidity") return "border-warning/60 border-dashed";
  return "border-info/60";
}

/**
 * The chart surface — real historical candles rendered through Lightweight Charts,
 * isolated behind `PriceChartProps`. Data arrives only via `candles` (fetched by the
 * workspace from /api/candles); this component never fetches and never fabricates.
 * `onChartReady` exposes the imperative handle (fit/zoom) to the toolbar.
 */
export function PriceChart({
  symbol,
  timeframe,
  candles,
  overlays = [],
  chartStyle = "candles",
  pricePrecision = 2,
  className,
  onChartReady,
}: PriceChartProps) {
  const hasData = Boolean(candles?.length);

  return (
    <div
      className={cn("relative flex min-h-[420px] flex-1 flex-col", className)}
      role="img"
      aria-label={`${symbol} ${timeframeLabel(timeframe)} price chart`}
    >
      <div className="pointer-events-none absolute top-3 left-4 z-10 space-y-0.5">
        <p className="numeric text-sm font-semibold">{symbol}</p>
        <p className="numeric text-xs text-subtle-foreground">{timeframeLabel(timeframe)}</p>
      </div>

      {overlays.length ? (
        <ul
          className="absolute top-3 right-4 z-10 max-w-[60%] space-y-1"
          aria-label="Overlays drawn on the chart"
        >
          {overlays.map((overlay) => (
            <li
              key={overlay.id}
              className="flex items-center justify-end gap-2 text-[11px] text-muted-foreground"
            >
              <span className="truncate">{overlay.label}</span>
              <span className="numeric text-subtle-foreground">
                {overlayRange(overlay, pricePrecision)}
              </span>
              <span
                className={cn("h-2.5 w-4 shrink-0 rounded-sm border", overlaySwatch(overlay))}
                aria-hidden="true"
              />
            </li>
          ))}
        </ul>
      ) : null}

      {hasData ? (
        <CandlestickChart
          candles={candles ?? []}
          timeframe={timeframe}
          overlays={overlays}
          chartStyle={chartStyle}
          pricePrecision={pricePrecision}
          onReady={onChartReady}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={CandlestickChartIcon}
            title="No candles to display"
            description="Candles appear here when the market-data provider returns bars for the selected symbol and timeframe."
          />
        </div>
      )}
    </div>
  );
}
