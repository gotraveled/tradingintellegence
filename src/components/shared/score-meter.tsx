import { cn } from "@/lib/utils";

interface ScoreMeterProps {
  value: number;
  label?: string;
  max?: number;
  className?: string;
  barClassName?: string;
}

export function ScoreMeter({
  value,
  label = "Quality score",
  max = 100,
  className,
  barClassName,
}: ScoreMeterProps) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="numeric font-semibold text-foreground">
          {value}
          <span className="text-subtle-foreground">/{max}</span>
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        className="h-1.5 overflow-hidden rounded-full bg-border"
      >
        <div
          className={cn("h-full rounded-full bg-info", barClassName)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
