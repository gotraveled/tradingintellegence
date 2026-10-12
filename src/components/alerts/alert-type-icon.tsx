import {
  ChartNoAxesCombined,
  CircleDashed,
  CircleX,
  Flag,
  Repeat,
  SquareStack,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import type { AlertType } from "@/lib/types";
import { cn } from "@/lib/utils";

export const ALERT_TYPE_ICON: Record<AlertType, LucideIcon> = {
  developing_setup: CircleDashed,
  confirmed_reversal: Repeat,
  confirmed_breakout: ChartNoAxesCombined,
  confirmed_continuation: TrendingUp,
  zone_approach: SquareStack,
  target_reached: Flag,
  invalidation_reached: CircleX,
};

const TONE: Record<AlertType, string> = {
  developing_setup: "text-warning border-warning/30 bg-warning-muted",
  confirmed_reversal: "text-info border-info/30 bg-info-muted",
  confirmed_breakout: "text-info border-info/30 bg-info-muted",
  confirmed_continuation: "text-info border-info/30 bg-info-muted",
  zone_approach: "text-muted-foreground border-border bg-surface-elevated",
  target_reached: "text-bullish border-bullish/30 bg-bullish-muted",
  invalidation_reached: "text-bearish border-bearish/30 bg-bearish-muted",
};

export function AlertTypeIcon({ type, className }: { type: AlertType; className?: string }) {
  const Icon = ALERT_TYPE_ICON[type];
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md border",
        TONE[type],
        className,
      )}
      aria-hidden="true"
    >
      <Icon className="size-4" />
    </span>
  );
}
