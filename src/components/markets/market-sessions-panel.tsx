"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status";
import { MARKET_SESSIONS } from "@/lib/constants";
import type { MarketSession } from "@/lib/types";

function toMinutes(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function getSessionState(session: MarketSession, now: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: session.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const localTime = `${get("hour")}:${get("minute")}`;
  const weekday = get("weekday");
  const minutes = toMinutes(localTime);
  const isWeekend = weekday === "Sat" || weekday === "Sun";
  const open =
    !isWeekend && minutes >= toMinutes(session.open) && minutes < toMinutes(session.close);
  return { localTime, open };
}

/**
 * Approximate regular-hours session clock. Ignores exchange holidays and lunch breaks.
 * Rendered after mount to avoid server/client clock mismatches.
 */
export function MarketSessionsPanel() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <Card>
      <CardHeader
        title="Market sessions"
        description="Approximate regular hours. Holidays are not accounted for."
      />
      <CardContent className="p-0">
        <ul className="divide-y divide-border">
          {MARKET_SESSIONS.map((session) => {
            const state = now ? getSessionState(session, now) : null;
            return (
              <li key={session.id} className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{session.name}</p>
                  <p className="numeric text-xs text-muted-foreground">
                    {session.open}–{session.close} local
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="numeric text-xs text-muted-foreground">
                    {state?.localTime ?? "--:--"}
                  </span>
                  {state ? (
                    state.open ? (
                      <StatusBadge tone="bullish" label="Open" />
                    ) : (
                      <StatusBadge tone="inactive" label="Closed" />
                    )
                  ) : (
                    <StatusBadge tone="inactive" label="—" />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
