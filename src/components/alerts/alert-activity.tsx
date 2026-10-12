import { Inbox } from "lucide-react";
import { DemoBadge } from "@/components/shared/demo";
import { EmptyState } from "@/components/ui/empty-state";
import { ALERT_TYPE_LABEL, timeframeLabel } from "@/lib/constants";
import type { AlertEvent } from "@/lib/types";
import { formatDateTimeUTC } from "@/lib/utils";
import { AlertTypeIcon } from "./alert-type-icon";

export function AlertActivity({ events, demo }: { events: AlertEvent[]; demo: boolean }) {
  return (
    <section
      aria-labelledby="alert-activity-heading"
      className="rounded-lg border border-border bg-surface"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 id="alert-activity-heading" className="text-sm font-semibold">
          Recent activity
        </h2>
        {demo ? <DemoBadge /> : null}
      </header>
      {events.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No alerts triggered"
          description="Triggered alerts will appear here."
        />
      ) : (
        <ol className="divide-y divide-border">
          {events.map((event) => (
            <li key={event.id} className="flex gap-3 px-4 py-3">
              <AlertTypeIcon type={event.type} className="size-7" />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-x-2">
                  <span className="numeric text-sm font-semibold">{event.symbol}</span>
                  {event.timeframe ? (
                    <span className="numeric text-xs text-subtle-foreground">
                      {timeframeLabel(event.timeframe)}
                    </span>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {ALERT_TYPE_LABEL[event.type]}
                  </span>
                  {event.read ? null : (
                    <span className="flex items-center gap-1 text-[11px] text-info">
                      <span className="size-1.5 rounded-full bg-info" aria-hidden="true" />
                      New
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{event.message}</p>
                <time
                  dateTime={event.triggeredAt}
                  className="numeric text-[11px] text-subtle-foreground"
                >
                  {formatDateTimeUTC(event.triggeredAt)}
                </time>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
