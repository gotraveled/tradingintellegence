import { TrendingUp } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import type { BacktestTrade } from "@/lib/types";

const WIDTH = 100;
const HEIGHT = 40;

/** Cumulative R curve drawn with plain SVG. Swap for a chart library later if needed. */
export function EquityCurve({ trades }: { trades?: BacktestTrade[] }) {
  if (!trades?.length) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="Equity curve"
        description="Cumulative result in R will be plotted here after a backtest run."
        className="py-10"
      />
    );
  }

  const cumulative = trades.reduce<number[]>((acc, trade) => {
    acc.push((acc.at(-1) ?? 0) + trade.resultR);
    return acc;
  }, []);
  const values = [0, ...cumulative];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (index: number) => (index / (values.length - 1)) * WIDTH;
  const y = (value: number) => HEIGHT - ((value - min) / span) * HEIGHT;
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  const final = cumulative.at(-1) ?? 0;

  return (
    <figure className="space-y-2">
      <div className="relative h-48 w-full">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="size-full"
          role="img"
          aria-label={`Equity curve: ${final >= 0 ? "+" : ""}${final.toFixed(1)}R after ${trades.length} trades, lowest point ${min.toFixed(1)}R.`}
        >
          <line
            x1="0"
            x2={WIDTH}
            y1={y(0)}
            y2={y(0)}
            className="stroke-border-strong"
            strokeWidth="0.3"
            strokeDasharray="1 1"
            vectorEffect="non-scaling-stroke"
          />
          <polyline
            points={points}
            fill="none"
            className={final >= 0 ? "stroke-bullish" : "stroke-bearish"}
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <figcaption className="flex justify-between text-[11px] text-subtle-foreground">
        <span>Trade 1</span>
        <span className="numeric">
          Final: {final >= 0 ? "+" : ""}
          {final.toFixed(1)}R
        </span>
        <span>Trade {trades.length}</span>
      </figcaption>
    </figure>
  );
}
