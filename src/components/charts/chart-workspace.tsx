"use client";

import { ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { TradePlan } from "@/components/opportunities/trade-plan";
import { DemoBadge } from "@/components/shared/demo";
import { FEATURED_INSTRUMENTS, getInstrument, timeframeLabel } from "@/lib/constants";
import type { DataSource } from "@/lib/services/intelligence";
import type { AnalysisSnapshot, Timeframe } from "@/lib/types";
import { AnalysisPanel } from "./analysis-panel";
import { toChartOverlays, type OverlayLayer } from "./chart-types";
import { ChartToolbar, type ChartStyle } from "./chart-toolbar";
import { PriceChart } from "./price-chart";
import { cn } from "@/lib/utils";

type MobilePanel = "chart" | "plan" | "analysis";

const MOBILE_PANELS: { id: MobilePanel; label: string }[] = [
  { id: "chart", label: "Chart" },
  { id: "plan", label: "Trade plan" },
  { id: "analysis", label: "Analysis" },
];

interface ChartWorkspaceProps {
  snapshots: Record<string, AnalysisSnapshot>;
  source: DataSource;
  initialSymbol?: string;
}

const DEFAULT_LAYERS: Record<OverlayLayer, boolean> = {
  structure: true,
  zones: true,
  liquidity: true,
  imbalance: false,
};

export function ChartWorkspace({
  snapshots,
  source,
  initialSymbol = FEATURED_INSTRUMENTS[0].symbol,
}: ChartWorkspaceProps) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [timeframe, setTimeframe] = useState<Timeframe>(
    snapshots[initialSymbol]?.timeframe ?? "4h",
  );
  const [chartStyle, setChartStyle] = useState<ChartStyle>("candles");
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  const [panel, setPanel] = useState<MobilePanel>("chart");
  /** Below xl only the selected panel is shown; at xl and up all panels are visible. */
  const visibleOn = (id: MobilePanel) => (panel === id ? "" : "hidden xl:block");

  const snapshot = snapshots[symbol];
  const precision = getInstrument(symbol)?.pricePrecision ?? 2;
  const demo = source === "demo";
  const timeframeMismatch = snapshot && snapshot.timeframe !== timeframe;

  const overlays = useMemo(
    () => toChartOverlays(snapshot).filter((overlay) => layers[overlay.layer]),
    [snapshot, layers],
  );

  const handleSymbolChange = (next: string) => {
    setSymbol(next);
    const nextSnapshot = snapshots[next];
    if (nextSnapshot) setTimeframe(nextSnapshot.timeframe);
  };

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
          <ChartToolbar
            symbol={symbol}
            onSymbolChange={handleSymbolChange}
            timeframe={timeframe}
            onTimeframeChange={setTimeframe}
            chartStyle={chartStyle}
            onChartStyleChange={setChartStyle}
            layers={layers}
            onLayerToggle={(layer) => setLayers((prev) => ({ ...prev, [layer]: !prev[layer] }))}
          />
          <PriceChart
            symbol={symbol}
            timeframe={timeframe}
            overlays={overlays}
            chartStyle={chartStyle}
            pricePrecision={precision}
            className="min-h-[340px] sm:min-h-[440px] xl:min-h-[560px]"
          />
          {timeframeMismatch ? (
            <p className="border-t border-border px-4 py-2 text-[11px] text-subtle-foreground">
              Demo analysis for {symbol} is available on {timeframeLabel(snapshot.timeframe)} only;
              overlays shown are from that timeframe.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-6">
          <div className={cn("order-2 xl:order-1", visibleOn("analysis"))}>
            <AnalysisPanel
              snapshot={snapshot}
              symbol={symbol}
              demo={demo}
              pricePrecision={precision}
            />
          </div>

          <section
            aria-label="Trade plan"
            className={cn(
              "order-1 rounded-lg border border-border bg-surface xl:order-2",
              visibleOn("plan"),
            )}
          >
            <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">Trade plan</h2>
              {demo && snapshot?.opportunity ? <DemoBadge /> : null}
            </header>
            <div className="space-y-3 p-4">
              <TradePlan
                layout="stack"
                plan={
                  snapshot?.opportunity ?? {
                    status: "developing",
                    pricePrecision: precision,
                  }
                }
              />
              <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-subtle-foreground">
                <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                Levels describe where the setup would be invalidated or reach its objectives. They
                are analysis, not instructions to trade.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
