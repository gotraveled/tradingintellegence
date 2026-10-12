import { Circle, CircleCheck } from "lucide-react";
import { BiasBadge } from "@/components/shared/bias-badge";
import { DemoBadge } from "@/components/shared/demo";
import { ScoreMeter } from "@/components/shared/score-meter";
import { StatusBadge } from "@/components/ui/status";
import { ASSET_CLASS_LABEL, describeSetup, TIMEFRAMES } from "@/lib/constants";
import type { DevelopingSetup } from "@/lib/types";
import { cn } from "@/lib/utils";

interface DevelopingSetupCardProps {
  setup: DevelopingSetup;
  demo?: boolean;
  className?: string;
}

export function DevelopingSetupCard({ setup, demo = false, className }: DevelopingSetupCardProps) {
  const met = setup.conditions.filter((condition) => condition.met).length;
  const total = setup.conditions.length;
  const title = describeSetup(setup.bias, setup.setupType);
  const timeframe = TIMEFRAMES.find((tf) => tf.value === setup.timeframe)?.label ?? setup.timeframe;

  return (
    <article
      className={cn("flex flex-col rounded-lg border border-border bg-surface", className)}
      aria-label={`${setup.symbol} ${title}`}
    >
      <header className="space-y-3 px-4 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h3 className="truncate numeric text-[15px] font-semibold">{setup.symbol}</h3>
            <p className="text-xs text-muted-foreground">
              {ASSET_CLASS_LABEL[setup.assetClass]} · {timeframe}
            </p>
          </div>
          {demo ? <DemoBadge /> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge tone="developing" label="Not confirmed" />
          <BiasBadge bias={setup.bias} />
        </div>
        <p className="text-sm font-medium">{title}</p>
      </header>

      <ScoreMeter
        value={setup.score}
        label="Developing score"
        className="px-4 pt-3"
        barClassName="bg-warning"
      />

      <div className="mt-4 border-t border-border px-4 py-3.5">
        <p className="mb-2.5 text-[11px] text-subtle-foreground">
          Conditions · <span className="numeric">{met}</span> of{" "}
          <span className="numeric">{total}</span> met
        </p>
        <ul className="space-y-1.5">
          {setup.conditions.map((condition) => (
            <li key={condition.label} className="flex items-center gap-2 text-[13px]">
              {condition.met ? (
                <CircleCheck className="size-4 shrink-0 text-bullish" aria-hidden="true" />
              ) : (
                <Circle className="size-4 shrink-0 text-subtle-foreground" aria-hidden="true" />
              )}
              <span className={condition.met ? "text-foreground" : "text-muted-foreground"}>
                {condition.label}
                {condition.met ? null : <span className="text-subtle-foreground"> — pending</span>}
              </span>
              <span className="sr-only">{condition.met ? "(met)" : "(pending)"}</span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}
