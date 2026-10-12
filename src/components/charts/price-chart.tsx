import { CandlestickChart } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { timeframeLabel } from "@/lib/constants";
import { cn, formatPrice } from "@/lib/utils";
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
 * Placeholder chart surface.
 *
 * This is the single integration point for a real candlestick library (e.g. TradingView
 * Lightweight Charts). Replace the body of this component and keep `PriceChartProps` — the page,
 * toolbar, and analysis panel do not need to change.
 */
export function PriceChart({
  symbol,
  timeframe,
  candles,
  overlays = [],
  pricePrecision = 2,
  className,
}: PriceChartProps) {
  const hasData = Boolean(candles?.length);

  return (
    <div
      className={cn("relative flex min-h-[420px] flex-1 flex-col bg-grid", className)}
      role="img"
      aria-label={`${symbol} ${timeframeLabel(timeframe)} price chart`}
    >
      <div className="pointer-events-none absolute top-3 left-4 space-y-0.5">
        <p className="numeric text-sm font-semibold">{symbol}</p>
        <p className="numeric text-xs text-subtle-foreground">{timeframeLabel(timeframe)}</p>
      </div>

      {overlays.length ? (
        <ul
          className="absolute top-3 right-4 max-w-[60%] space-y-1"
          aria-label="Overlays that will be drawn on the chart"
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

      <div className="flex flex-1 items-center justify-center">
        {hasData ? null : (
          <EmptyState
            icon={CandlestickChart}
            title="Chart engine not connected"
            description="Candles will render here once a market-data provider and chart library are connected. Overlays listed above show what the analysis would draw."
          />
        )}
      </div>
    </div>
  );
}
