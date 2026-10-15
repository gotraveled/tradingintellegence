"use client";

import { ArrowDown, ArrowUp, CandlestickChart, ChevronRight } from "lucide-react";
import Link from "next/link";
import { Fragment, useState } from "react";
import { ReasonList } from "@/components/opportunities/reason-list";
import { SetupStatusBadge } from "@/components/opportunities/status-badge";
import { TradePlan } from "@/components/opportunities/trade-plan";
import { BiasBadge } from "@/components/shared/bias-badge";
import {
  ASSET_CLASS_LABEL,
  describeSetup,
  getMarketSegment,
  SETUP_TYPE_LABEL,
  timeframeLabel,
} from "@/lib/constants";
import type { Opportunity, OpportunityStatus } from "@/lib/types";
import {
  chartHref,
  cn,
  formatDateTimeUTC,
  lastUpdated,
  type OpportunitySortKey,
} from "@/lib/utils";

export interface SortState {
  key: OpportunitySortKey;
  order: "asc" | "desc";
}

interface ScannerTableProps {
  opportunities: Opportunity[];
  sort: SortState;
  onSortChange: (sort: SortState) => void;
}

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

function SortHeader({
  label,
  sortKey,
  sort,
  onSortChange,
  align = "left",
}: {
  label: string;
  sortKey: OpportunitySortKey;
  sort: SortState;
  onSortChange: (sort: SortState) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === sortKey;
  const Icon = sort.order === "desc" ? ArrowDown : ArrowUp;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.order === "desc" ? "descending" : "ascending") : "none"}
      className={cn("px-3 py-2.5", align === "right" ? "text-right" : "text-left")}
    >
      <button
        type="button"
        onClick={() =>
          onSortChange({
            key: sortKey,
            order: active && sort.order === "desc" ? "asc" : "desc",
          })
        }
        className={cn(
          "inline-flex items-center gap-1 text-[11px] font-medium tracking-wide uppercase transition-colors hover:text-foreground",
          active ? "text-foreground" : "text-subtle-foreground",
        )}
      >
        {label}
        {active ? <Icon className="size-3" aria-hidden="true" /> : null}
      </button>
    </th>
  );
}

function PlainHeader({ label, className }: { label: string; className?: string }) {
  return (
    <th
      scope="col"
      className={cn(
        "px-3 py-2.5 text-left text-[11px] font-medium tracking-wide text-subtle-foreground uppercase",
        className,
      )}
    >
      {label}
    </th>
  );
}

/** Desktop table with expandable detail rows (the "card" half of the hybrid). */
export function ScannerTable({ opportunities, sort, onSortChange }: ScannerTableProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[920px] border-collapse text-sm">
        <caption className="sr-only">Scanner results</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="w-10">
              <span className="sr-only">Expand</span>
            </th>
            <PlainHeader label="Asset" />
            <PlainHeader label="Setup" />
            <PlainHeader label="Direction" />
            <PlainHeader label="Timeframe" />
            <SortHeader label="Score" sortKey="score" sort={sort} onSortChange={onSortChange} />
            <PlainHeader label="Status" />
            <SortHeader
              label="Risk/Reward"
              sortKey="riskReward"
              sort={sort}
              onSortChange={onSortChange}
              align="right"
            />
            <SortHeader
              label="Updated"
              sortKey="updated"
              sort={sort}
              onSortChange={onSortChange}
              align="right"
            />
            <PlainHeader label="Chart" className="text-right" />
          </tr>
        </thead>
        <tbody>
          {opportunities.map((opportunity) => {
            const isOpen = expanded === opportunity.id;
            const detailId = `scanner-detail-${opportunity.id}`;
            const inactive = ["target_reached", "invalidated", "expired", "cancelled"].includes(
              opportunity.status,
            );
            const segment = opportunity.market ? getMarketSegment(opportunity.market) : undefined;
            const toggle = () => setExpanded(isOpen ? null : opportunity.id);
            // Guarded destination — undefined when the engine emitted a symbol or
            // timeframe the chart catalog does not support. Never substitutes.
            const href = chartHref(opportunity.symbol, opportunity.timeframe);

            return (
              <Fragment key={opportunity.id}>
                <tr
                  onClick={toggle}
                  className={cn(
                    "cursor-pointer border-b border-border transition-colors hover:bg-surface-elevated",
                    isOpen && "bg-surface-elevated",
                    inactive && "text-muted-foreground",
                  )}
                >
                  <td className="pl-3">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle();
                      }}
                      aria-expanded={isOpen}
                      aria-controls={detailId}
                      aria-label={`${isOpen ? "Hide" : "Show"} details for ${opportunity.symbol}`}
                      className="flex size-7 items-center justify-center rounded-md text-subtle-foreground hover:bg-surface-hover hover:text-foreground"
                    >
                      <ChevronRight
                        className={cn("size-4 transition-transform", isOpen && "rotate-90")}
                        aria-hidden="true"
                      />
                    </button>
                  </td>
                  <td className="px-3 py-3">
                    <div className="numeric font-semibold text-foreground">
                      {opportunity.symbol}
                    </div>
                    <div className="text-xs text-subtle-foreground">
                      {ASSET_CLASS_LABEL[opportunity.assetClass]}
                      {segment ? ` · ${segment.label}` : null}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="font-medium">{SETUP_TYPE_LABEL[opportunity.setupType]}</div>
                    <div className="text-xs text-subtle-foreground">
                      {describeSetup(
                        opportunity.direction,
                        opportunity.setupType,
                        opportunity.status,
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <BiasBadge bias={opportunity.direction} />
                  </td>
                  <td className="px-3 py-3 numeric">{timeframeLabel(opportunity.timeframe)}</td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <span className="w-7 numeric font-semibold text-foreground">
                        {opportunity.score}
                      </span>
                      <div
                        className="h-1.5 w-16 overflow-hidden rounded-full bg-border"
                        role="meter"
                        aria-label="Score"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={opportunity.score}
                      >
                        <div
                          className={cn("h-full rounded-full", SCORE_BAR[opportunity.status])}
                          style={{ width: `${opportunity.score}%` }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <SetupStatusBadge status={opportunity.status} />
                  </td>
                  <td className="px-3 py-3 text-right numeric">
                    {opportunity.riskReward === undefined ? (
                      <span className="font-sans text-subtle-foreground">Pending</span>
                    ) : (
                      `${opportunity.riskReward.toFixed(1)}R`
                    )}
                  </td>
                  <td className="px-3 py-3 text-right numeric text-xs text-muted-foreground">
                    <time dateTime={lastUpdated(opportunity)}>
                      {formatDateTimeUTC(lastUpdated(opportunity))}
                    </time>
                  </td>
                  <td className="px-3 py-3 text-right">
                    {href ? (
                      <Link
                        href={href}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`View ${opportunity.symbol} on chart`}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
                      >
                        <CandlestickChart className="size-3.5" aria-hidden="true" />
                        Chart
                      </Link>
                    ) : (
                      <span
                        className="text-xs text-muted-foreground"
                        title="This instrument or timeframe is not supported by the chart"
                      >
                        Not chartable
                      </span>
                    )}
                  </td>
                </tr>
                {isOpen ? (
                  <tr id={detailId} className="border-b border-border bg-surface-elevated/50">
                    <td />
                    <td colSpan={9} className="px-3 py-4">
                      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
                        {opportunity.reasons?.length ? (
                          <ReasonList reasons={opportunity.reasons} />
                        ) : (
                          <p className="text-xs text-subtle-foreground">No conditions reported.</p>
                        )}
                        <TradePlan plan={opportunity} />
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
