import { BiasBadge } from "@/components/shared/bias-badge";
import { ScoreMeter } from "@/components/shared/score-meter";
import { REGIME_LABEL, TIMEFRAMES } from "@/lib/constants";
import type { MarketRegimeSnapshot } from "@/lib/types";
import { cn } from "@/lib/utils";

const BAR_BY_DIRECTION = {
  bullish: "bg-bullish",
  bearish: "bg-bearish",
  neutral: "bg-info",
} as const;

export function MarketRegimeCard({
  snapshot,
  className,
}: {
  snapshot: MarketRegimeSnapshot;
  className?: string;
}) {
  const timeframe =
    TIMEFRAMES.find((tf) => tf.value === snapshot.timeframe)?.label ?? snapshot.timeframe;

  return (
    <article
      className={cn("space-y-4 rounded-lg border border-border bg-surface p-4", className)}
      aria-label={`${snapshot.name} market regime`}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{snapshot.name}</h3>
          <p className="numeric text-xs text-subtle-foreground">{snapshot.symbol}</p>
        </div>
        <BiasBadge bias={snapshot.direction} />
      </header>
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <div className="space-y-0.5">
          <dt className="text-subtle-foreground">Regime</dt>
          <dd className="font-medium">{REGIME_LABEL[snapshot.regime]}</dd>
        </div>
        <div className="space-y-0.5">
          <dt className="text-subtle-foreground">Timeframe</dt>
          <dd className="numeric font-medium">{timeframe}</dd>
        </div>
      </dl>
      <ScoreMeter
        value={snapshot.strength}
        label="Strength"
        barClassName={BAR_BY_DIRECTION[snapshot.direction]}
      />
    </article>
  );
}
