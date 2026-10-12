import { Bot, User } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Static, illustrative example of how the AI explains a setup. Not generated, not live.
 */
export function AiExplanationExample({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex items-start gap-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-elevated">
          <User className="size-3.5 text-muted-foreground" aria-hidden="true" />
        </div>
        <p className="pt-1 text-sm">Why is BTCUSDT flagged as a potential bullish reversal?</p>
      </div>
      <div className="flex items-start gap-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-info/30 bg-info-muted">
          <Bot className="size-3.5 text-info" aria-hidden="true" />
        </div>
        <div className="min-w-0 space-y-3 rounded-lg border border-border bg-surface-elevated/60 p-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">
              This is a developing setup, not a confirmed one.
            </span>{" "}
            Three of six conditions are met: price is reacting from a higher-timeframe demand zone,
            sell-side liquidity rests just below recent lows, and selling momentum has weakened.
          </p>
          <p>
            <span className="font-medium text-foreground">Still missing:</span> a sweep of that
            liquidity, a change of character on the lower timeframe, and entry confirmation.
          </p>
          <p>
            <span className="font-medium text-foreground">Invalidation:</span> a close below the
            demand zone. The score reflects evidence quality, not a forecast — comparable historical
            setups should be reviewed before drawing conclusions.
          </p>
        </div>
      </div>
    </div>
  );
}
