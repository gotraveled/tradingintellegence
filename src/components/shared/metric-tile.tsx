import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface MetricTileProps {
  label: string;
  value?: ReactNode;
  hint?: string;
  loading?: boolean;
  className?: string;
}

/** Single labelled metric. Renders an em dash when no value is available. */
export function MetricTile({ label, value, hint, loading = false, className }: MetricTileProps) {
  return (
    <div className={cn("space-y-1.5 bg-surface p-4", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="numeric text-xl font-semibold">
        {loading ? (
          <Skeleton className="h-7 w-16" />
        ) : value === undefined ? (
          <span className="text-subtle-foreground" aria-label="No data">
            —
          </span>
        ) : (
          value
        )}
      </dd>
      {hint ? <p className="text-[11px] text-subtle-foreground">{hint}</p> : null}
    </div>
  );
}
