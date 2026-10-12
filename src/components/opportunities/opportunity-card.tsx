import { BiasBadge } from "@/components/shared/bias-badge";
import { DemoBadge } from "@/components/shared/demo";
import { ScoreMeter } from "@/components/shared/score-meter";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status";
import {
  ASSET_CLASS_LABEL,
  SETUP_TYPE_LABEL,
  STAGE_LABEL,
  STAGE_TONE,
  TIMEFRAMES,
} from "@/lib/constants";
import type { OpportunitySummary } from "@/lib/types";
import { cn, formatPrice } from "@/lib/utils";

interface OpportunityCardProps {
  opportunity: OpportunitySummary;
  demo?: boolean;
  className?: string;
}

function timeframeLabel(value: OpportunitySummary["timeframe"]) {
  return TIMEFRAMES.find((tf) => tf.value === value)?.label ?? value;
}

function Field({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-[11px] text-subtle-foreground">{label}</dt>
      <dd className={cn("numeric text-[13px] text-foreground", className)}>{value}</dd>
    </div>
  );
}

export function OpportunityCard({ opportunity, demo = false, className }: OpportunityCardProps) {
  const { plan, pricePrecision } = opportunity;
  const price = (value: number) => formatPrice(value, pricePrecision);

  return (
    <article
      className={cn(
        "flex flex-col rounded-lg border border-border bg-surface transition-colors hover:border-border-strong",
        className,
      )}
      aria-label={`${opportunity.symbol} ${SETUP_TYPE_LABEL[opportunity.setupType]} opportunity`}
    >
      <header className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="min-w-0 space-y-1">
          <h3 className="truncate numeric text-[15px] font-semibold">{opportunity.symbol}</h3>
          <p className="text-xs text-muted-foreground">
            {ASSET_CLASS_LABEL[opportunity.assetClass]} · {timeframeLabel(opportunity.timeframe)}
          </p>
        </div>
        {demo ? <DemoBadge /> : null}
      </header>

      <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
        <Badge>{SETUP_TYPE_LABEL[opportunity.setupType]}</Badge>
        <BiasBadge bias={opportunity.bias} />
        <StatusBadge tone={STAGE_TONE[opportunity.stage]} label={STAGE_LABEL[opportunity.stage]} />
      </div>

      <ScoreMeter value={opportunity.score} className="px-4 pt-4" />

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border px-4 py-3.5 sm:grid-cols-4">
        <Field label="Entry" value={price(plan.entry)} />
        <Field label="Invalidation" value={price(plan.invalidation)} className="text-bearish" />
        <Field label="Target" value={price(plan.target)} className="text-bullish" />
        <Field label="Risk / Reward" value={`${plan.riskReward.toFixed(1)}R`} />
      </dl>
    </article>
  );
}
