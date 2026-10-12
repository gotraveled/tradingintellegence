import { FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { DataSource } from "@/lib/services/intelligence";
import { cn } from "@/lib/utils";

export function DemoBadge({ className }: { className?: string }) {
  return (
    <Badge className={cn("border-dashed border-warning/40 text-warning", className)}>
      <FlaskConical aria-hidden="true" />
      Demo
    </Badge>
  );
}

/** Renders a Demo badge only when the payload is not live. */
export function SourceBadge({ source, className }: { source: DataSource; className?: string }) {
  return source === "demo" ? <DemoBadge className={className} /> : null;
}

export function DemoNotice({ className }: { className?: string }) {
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-3 rounded-lg border border-dashed border-warning/40 bg-warning-muted px-4 py-3",
        className,
      )}
    >
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      <p className="text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-warning">Demo data.</span> Sections marked{" "}
        <span className="font-medium text-foreground">Demo</span> show illustrative values, not real
        market data. No market-data provider or analysis engine is connected yet.
      </p>
    </div>
  );
}
