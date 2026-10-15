import { CandlestickChart } from "lucide-react";
import Link from "next/link";
import { BiasBadge } from "@/components/shared/bias-badge";
import { DemoBadge } from "@/components/shared/demo";
import { ScoreMeter } from "@/components/shared/score-meter";
import { Badge } from "@/components/ui/badge";
import {
  ASSET_CLASS_LABEL,
  CONFIDENCE_LABEL,
  describeSetup,
  SETUP_TYPE_LABEL,
  timeframeLabel,
} from "@/lib/constants";
import type { Direction, Opportunity, OpportunityStatus } from "@/lib/types";
import { chartHref, cn, formatDateTimeUTC, lastUpdated } from "@/lib/utils";
import { ReasonList } from "./reason-list";
import { SetupStatusBadge } from "./status-badge";
import { TradePlan } from "./trade-plan";

export interface OpportunityCardProps {
  opportunity: Opportunity;
  /** Marks the card as demo content. */
  demo?: boolean;
  /** Show the conditions checklist. Defaults to true for developing setups. */
  showReasons?: boolean;
  /** Show entry / stop / targets / R:R. Defaults to true. */
  showPlan?: boolean;
  className?: string;
}

const DIRECTION_ACCENT: Record<Direction, string> = {
  bullish: "before:bg-bullish",
  bearish: "before:bg-bearish",
};

const SCORE_BAR: Record<OpportunityStatus, string> = {
  developing: "bg-warning",
  confirmed: "bg-info",
  active: "bg-info",
  partial_target: "bg-info",
  target_reached: "bg-inactive",
  invalidated: "bg-inactive",
  expired: "bg-inactive",
  cancelled: "bg-inactive",
};

const SCORE_LABEL: Record<OpportunityStatus, string> = {
  developing: "Developing score",
  confirmed: "Quality score",
  active: "Quality score",
  partial_target: "Quality score",
  target_reached: "Quality score at detection",
  invalidated: "Quality score at detection",
  expired: "Quality score at detection",
  cancelled: "Quality score at detection",
};

const TERMINAL: OpportunityStatus[] = ["target_reached", "invalidated", "expired", "cancelled"];

function statusNote(opportunity: Opportunity): string | null {
  if (opportunity.status === "invalidated") {
    return "Invalidated — price breached the invalidation level before the setup resolved.";
  }
  if (opportunity.status === "target_reached") {
    return "Target reached — final target hit.";
  }
  if (opportunity.status === "partial_target") {
    const reached = opportunity.targets?.filter((target) => target.reached).length ?? 0;
    const total = opportunity.targets?.length ?? 0;
    return `Partial target — ${reached} of ${total} targets reached so far.`;
  }
  if (opportunity.status === "expired") {
    return "Expired — the setup went stale before resolving.";
  }
  if (opportunity.status === "cancelled") {
    return "Cancelled — the setup's premise was disproved before it confirmed.";
  }
  return null;
}

export function OpportunityCard({
  opportunity,
  demo = false,
  showReasons,
  showPlan = true,
  className,
}: OpportunityCardProps) {
  const reasons = opportunity.reasons ?? [];
  const displayReasons = (showReasons ?? opportunity.status === "developing") && reasons.length > 0;
  const inactive = TERMINAL.includes(opportunity.status);
  const note = statusNote(opportunity);
  // Guarded destination — undefined when the symbol/timeframe isn't chartable;
  // never link to a substituted instrument.
  const href = chartHref(opportunity.symbol, opportunity.timeframe);

  return (
    <article
      className={cn(
        "relative flex flex-col overflow-hidden rounded-lg border border-border bg-surface transition-colors hover:border-border-strong",
        "before:absolute before:inset-y-0 before:left-0 before:w-0.5",
        DIRECTION_ACCENT[opportunity.direction],
        inactive && "before:opacity-40",
        className,
      )}
      aria-label={`${opportunity.symbol} ${describeSetup(opportunity.direction, opportunity.setupType, opportunity.status)}`}
    >
      <header className="space-y-3 px-4 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h3 className="truncate numeric text-[15px] font-semibold">{opportunity.symbol}</h3>
            <p className="text-xs text-muted-foreground">
              {ASSET_CLASS_LABEL[opportunity.assetClass]} · {timeframeLabel(opportunity.timeframe)}
            </p>
          </div>
          {demo ? <DemoBadge /> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge>{SETUP_TYPE_LABEL[opportunity.setupType]}</Badge>
          <BiasBadge bias={opportunity.direction} />
          <SetupStatusBadge status={opportunity.status} />
        </div>
        <p className={cn("text-sm font-medium", inactive && "text-muted-foreground")}>
          {describeSetup(opportunity.direction, opportunity.setupType, opportunity.status)}
        </p>
      </header>

      <ScoreMeter
        value={opportunity.score}
        label={SCORE_LABEL[opportunity.status]}
        barClassName={SCORE_BAR[opportunity.status]}
        className="px-4 pt-3"
      />

      {note ? <p className="px-4 pt-3 text-xs text-muted-foreground">{note}</p> : null}

      {displayReasons ? (
        <ReasonList reasons={reasons} className="mt-4 border-t border-border px-4 py-3.5" />
      ) : null}

      {showPlan ? (
        <TradePlan plan={opportunity} className="mt-4 border-t border-border px-4 py-3.5" />
      ) : null}

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-[11px] text-subtle-foreground">
        <span>
          Confidence:{" "}
          <span className="text-muted-foreground">
            {opportunity.confidence ? CONFIDENCE_LABEL[opportunity.confidence] : "Not assessed"}
          </span>
        </span>
        <span className="flex items-center gap-3">
          {href ? (
            <Link
              href={href}
              className="inline-flex items-center gap-1 text-xs font-medium text-subtle-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
              aria-label={`View ${opportunity.symbol} on chart`}
            >
              <CandlestickChart className="size-3.5" aria-hidden="true" />
              View on chart
            </Link>
          ) : (
            <span
              className="text-xs text-muted-foreground"
              title="This instrument or timeframe is not supported by the chart"
            >
              Not chartable
            </span>
          )}
          <span>
            Updated{" "}
            <time dateTime={lastUpdated(opportunity)} className="numeric">
              {formatDateTimeUTC(lastUpdated(opportunity))}
            </time>
          </span>
        </span>
      </footer>
    </article>
  );
}
