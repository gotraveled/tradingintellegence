import { ChartColumn } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import type { BacktestTrade } from "@/lib/types";
import { cn } from "@/lib/utils";

const BUCKETS: { label: string; test: (r: number) => boolean; tone: "loss" | "flat" | "win" }[] = [
  { label: "≤ −1R", test: (r) => r <= -1, tone: "loss" },
  { label: "−1R to 0", test: (r) => r > -1 && r < 0, tone: "loss" },
  { label: "0R", test: (r) => r === 0, tone: "flat" },
  { label: "0 to 1R", test: (r) => r > 0 && r < 1, tone: "win" },
  { label: "1R to 2R", test: (r) => r >= 1 && r < 2, tone: "win" },
  { label: "2R to 3R", test: (r) => r >= 2 && r < 3, tone: "win" },
  { label: "≥ 3R", test: (r) => r >= 3, tone: "win" },
];

const BAR_TONE = { loss: "bg-bearish", flat: "bg-inactive", win: "bg-bullish" };

/** Histogram of trade outcomes in R, rendered as an accessible list of bars. */
export function TradeDistribution({ trades }: { trades?: BacktestTrade[] }) {
  if (!trades?.length) {
    return (
      <EmptyState
        icon={ChartColumn}
        title="Trade distribution"
        description="The spread of trade outcomes in R will appear here after a backtest run."
        className="py-10"
      />
    );
  }

  const counts = BUCKETS.map(
    (bucket) => trades.filter((trade) => bucket.test(trade.resultR)).length,
  );
  const max = Math.max(...counts, 1);

  return (
    <ul className="flex h-48 items-end gap-2" aria-label="Trade outcome distribution">
      {BUCKETS.map((bucket, index) => (
        <li
          key={bucket.label}
          className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
        >
          <span className="numeric text-[11px] text-muted-foreground">{counts[index]}</span>
          <div
            className={cn("w-full rounded-t-sm", BAR_TONE[bucket.tone])}
            style={{ height: `${(counts[index] / max) * 100}%`, minHeight: counts[index] ? 2 : 0 }}
            aria-hidden="true"
          />
          <span className="w-full truncate text-center numeric text-[10px] text-subtle-foreground">
            {bucket.label}
          </span>
          <span className="sr-only">
            {counts[index]} trades between {bucket.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
