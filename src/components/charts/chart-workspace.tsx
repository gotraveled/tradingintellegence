import { CandlestickChart } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status";
import { DEFAULT_TIMEFRAME, TIMEFRAMES } from "@/lib/constants";
import { cn } from "@/lib/utils";

const ANALYSIS_LAYERS = [
  { id: "structure", label: "Market structure", detail: "Swings, BOS, CHOCH" },
  { id: "zones", label: "Supply & demand zones", detail: "Fresh and tested zones" },
  { id: "liquidity", label: "Liquidity", detail: "Equal highs/lows, sweeps" },
  { id: "imbalance", label: "Fair value gaps", detail: "Unmitigated imbalances" },
  { id: "mtf", label: "Higher-timeframe context", detail: "HTF bias and key levels" },
];

export function ChartWorkspace() {
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
      <Card className="flex min-h-[520px] flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-3">
            <span className="numeric text-sm font-semibold text-subtle-foreground">No symbol</span>
            <StatusBadge tone="inactive" label="No data" />
          </div>
          <div role="group" aria-label="Timeframe" className="flex items-center gap-0.5">
            {TIMEFRAMES.map((timeframe) => (
              <button
                key={timeframe.value}
                type="button"
                disabled
                aria-pressed={timeframe.value === DEFAULT_TIMEFRAME}
                className={cn(
                  "h-7 rounded px-2 numeric text-xs disabled:cursor-not-allowed",
                  timeframe.value === DEFAULT_TIMEFRAME
                    ? "bg-surface-hover text-foreground"
                    : "text-subtle-foreground",
                )}
              >
                {timeframe.label}
              </button>
            ))}
          </div>
        </div>
        <div className="relative flex flex-1 items-center justify-center bg-grid">
          <EmptyState
            icon={CandlestickChart}
            title="Chart engine not connected"
            description="Price data and analysis overlays will render here once a market-data provider and the analysis engine are connected."
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Analysis layers" description="Overlays rendered on the chart." />
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {ANALYSIS_LAYERS.map((layer) => (
              <li key={layer.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-medium">{layer.label}</p>
                  <p className="truncate text-xs text-muted-foreground">{layer.detail}</p>
                </div>
                <StatusBadge tone="inactive" />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
