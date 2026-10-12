import { Circle, CircleCheck } from "lucide-react";
import type { SetupReason } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ReasonListProps {
  reasons: SetupReason[];
  className?: string;
  showSummary?: boolean;
}

/** Conditions checklist. Met = check icon, pending = empty circle plus "pending" text. */
export function ReasonList({ reasons, className, showSummary = true }: ReasonListProps) {
  const met = reasons.filter((reason) => reason.met).length;
  return (
    <div className={className}>
      {showSummary ? (
        <p className="mb-2.5 text-[11px] text-subtle-foreground">
          Conditions · <span className="numeric">{met}</span> of{" "}
          <span className="numeric">{reasons.length}</span> met
        </p>
      ) : null}
      <ul className="space-y-1.5">
        {reasons.map((reason) => (
          <li key={reason.id} className="flex items-center gap-2 text-[13px]">
            {reason.met ? (
              <CircleCheck className="size-4 shrink-0 text-bullish" aria-hidden="true" />
            ) : (
              <Circle className="size-4 shrink-0 text-subtle-foreground" aria-hidden="true" />
            )}
            <span className={cn(reason.met ? "text-foreground" : "text-muted-foreground")}>
              {reason.label}
              {reason.met ? null : <span className="text-subtle-foreground"> — pending</span>}
            </span>
            <span className="sr-only">{reason.met ? "(met)" : "(pending)"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
