"use client";

import { BellOff, Pause, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status";
import {
  ALERT_CHANNEL_LABEL,
  ALERT_STATUS_LABEL,
  ALERT_TYPE_LABEL,
  getMarketSegment,
  timeframeLabel,
} from "@/lib/constants";
import type { Alert, AlertScope } from "@/lib/types";
import { formatDateTimeUTC } from "@/lib/utils";
import { AlertTypeIcon } from "./alert-type-icon";

function describeScope(scope: AlertScope) {
  const parts: string[] = [];
  if (scope.symbols?.length) parts.push(scope.symbols.join(", "));
  if (scope.markets?.length)
    parts.push(scope.markets.map((id) => getMarketSegment(id)?.label ?? id).join(", "));
  if (scope.timeframes?.length) parts.push(scope.timeframes.map(timeframeLabel).join(" / "));
  if (scope.direction) parts.push(scope.direction === "bullish" ? "Bullish" : "Bearish");
  if (scope.minScore !== undefined) parts.push(`Score ${scope.minScore}+`);
  return parts.length ? parts.join(" · ") : "All instruments";
}

interface AlertRuleListProps {
  alerts: Alert[];
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

export function AlertRuleList({ alerts, onToggle, onDelete }: AlertRuleListProps) {
  return (
    <section
      aria-labelledby="alert-rules-heading"
      className="rounded-lg border border-border bg-surface"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 id="alert-rules-heading" className="text-sm font-semibold">
          Alert rules
        </h2>
        <span className="numeric text-xs text-muted-foreground">
          {alerts.filter((alert) => alert.status === "active").length} active
        </span>
      </header>

      {alerts.length === 0 ? (
        <EmptyState
          icon={BellOff}
          title="No alert rules"
          description="Choose an alert type above to create your first rule."
        />
      ) : (
        <ul className="divide-y divide-border">
          {alerts.map((alert) => {
            const paused = alert.status === "paused";
            return (
              <li
                key={alert.id}
                className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <AlertTypeIcon type={alert.params.type} />
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">{alert.name}</p>
                      <StatusBadge
                        tone={paused ? "inactive" : "neutral"}
                        label={ALERT_STATUS_LABEL[alert.status]}
                        icon={paused ? Pause : Play}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {ALERT_TYPE_LABEL[alert.params.type]} · {describeScope(alert.scope)}
                    </p>
                    <p className="text-[11px] text-subtle-foreground">
                      {alert.channels.map((channel) => ALERT_CHANNEL_LABEL[channel]).join(", ")}
                      {alert.lastTriggeredAt
                        ? ` · Last triggered ${formatDateTimeUTC(alert.lastTriggeredAt)}`
                        : " · Not triggered yet"}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onToggle(alert.id)}
                    aria-label={`${paused ? "Resume" : "Pause"} ${alert.name}`}
                  >
                    {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                    {paused ? "Resume" : "Pause"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onDelete(alert.id)}
                    aria-label={`Delete ${alert.name}`}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
