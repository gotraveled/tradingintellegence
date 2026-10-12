import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { ConnectionBadge } from "@/components/ui/status";
import { MARKET_SEGMENTS, marketSegmentHref } from "@/lib/constants";

/** High-level market categories. Shows structure only; no market data is rendered. */
export function MarketOverview() {
  return (
    <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 xl:grid-cols-3">
      {MARKET_SEGMENTS.map((segment) => (
        <Link
          key={segment.id}
          href={marketSegmentHref(segment.id)}
          className="group flex flex-col gap-3 bg-surface p-4 transition-colors hover:bg-surface-elevated"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-0.5">
              <h3 className="text-sm font-semibold">{segment.label}</h3>
              <p className="text-xs text-muted-foreground">{segment.description}</p>
            </div>
            <ArrowUpRight
              className="size-4 shrink-0 text-subtle-foreground transition-colors group-hover:text-foreground"
              aria-hidden="true"
            />
          </div>
          <ul className="flex flex-wrap gap-1.5" aria-label={`${segment.label} examples`}>
            {segment.examples.map((example) => (
              <li
                key={example}
                className="rounded border border-border px-1.5 py-0.5 numeric text-[11px] text-subtle-foreground"
              >
                {example}
              </li>
            ))}
          </ul>
          <div className="mt-auto flex items-center justify-between gap-2 pt-1">
            <span className="text-[11px] text-subtle-foreground">{segment.hours}</span>
            <ConnectionBadge status="disconnected" />
          </div>
        </Link>
      ))}
    </div>
  );
}
