import { ShieldAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status";
import type { Tone } from "@/lib/types";

const EVIDENCE: { label: string; detail: string; tone: Tone; verdict: string }[] = [
  {
    label: "Market structure",
    detail: "CHOCH on 1H after HTF sweep",
    tone: "bullish",
    verdict: "Supports",
  },
  {
    label: "Demand zone",
    detail: "Fresh 4H zone, first retest",
    tone: "bullish",
    verdict: "Supports",
  },
  { label: "Liquidity", detail: "Sell-side liquidity taken", tone: "bullish", verdict: "Supports" },
  {
    label: "HTF alignment",
    detail: "Daily remains range-bound",
    tone: "developing",
    verdict: "Conflicting",
  },
  {
    label: "Historical sample",
    detail: "42 comparable setups",
    tone: "neutral",
    verdict: "Context",
  },
];

const SCORE = 68;

/** Static illustration of how a setup is presented. Contains no live or real market data. */
export function SetupPreview() {
  return (
    <Card className="overflow-hidden shadow-2xl shadow-black/30">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="numeric text-sm font-semibold">EXAMPLE</span>
          <span className="numeric text-xs text-subtle-foreground">4H · Reversal</span>
        </div>
        <span className="text-[11px] font-medium text-subtle-foreground">
          Illustrative — not live data
        </span>
      </div>

      <div className="relative h-36 border-b border-border bg-grid">
        <svg
          viewBox="0 0 400 144"
          className="absolute inset-0 size-full"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <rect
            x="210"
            y="96"
            width="190"
            height="22"
            className="fill-bullish/10 stroke-bullish/40"
            strokeDasharray="3 3"
          />
          <line
            x1="0"
            y1="112"
            x2="400"
            y2="112"
            className="stroke-bearish/50"
            strokeDasharray="2 4"
          />
          <polyline
            points="0,30 30,42 60,38 90,58 120,52 150,74 180,70 205,104 222,116 240,92 262,98 290,72 320,80 350,56 380,62 400,48"
            fill="none"
            className="stroke-foreground/70"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
        <span className="absolute right-2 bottom-1 text-[10px] text-subtle-foreground">
          Demand zone · invalidation below
        </span>
      </div>

      <ul className="divide-y divide-border">
        {EVIDENCE.map((item) => (
          <li key={item.label} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <p className="text-[13px] font-medium">{item.label}</p>
              <p className="truncate text-xs text-muted-foreground">{item.detail}</p>
            </div>
            <StatusBadge tone={item.tone} label={item.verdict} />
          </li>
        ))}
      </ul>

      <div className="space-y-3 border-t border-border bg-surface-elevated/50 px-4 py-3.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Confluence score</span>
          <span className="numeric font-semibold">{SCORE} / 100</span>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-border"
          role="meter"
          aria-label="Confluence score"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={SCORE}
        >
          <div className="h-full rounded-full bg-info" style={{ width: `${SCORE}%` }} />
        </div>
        <p className="flex items-center gap-1.5 text-[11px] text-subtle-foreground">
          <ShieldAlert className="size-3.5" aria-hidden="true" />
          Score reflects evidence quality, not probability of profit.
        </p>
      </div>
    </Card>
  );
}
