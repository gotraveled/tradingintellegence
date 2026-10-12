"use client";

import { useEffect, useState } from "react";

/** Shows the viewer's local date and time. Rendered after mount to avoid hydration mismatches. */
export function LocalDateTime({ className }: { className?: string }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (!now) {
    return (
      <span className={className} aria-hidden="true">
        &nbsp;
      </span>
    );
  }

  const date = now.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const time = now.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  return (
    <time dateTime={now.toISOString()} className={className}>
      {date} · <span className="numeric">{time}</span>
    </time>
  );
}
