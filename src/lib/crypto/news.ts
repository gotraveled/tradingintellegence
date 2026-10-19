/**
 * News guard — never open a scalp into a high-impact release. The calendar
 * feed is the Forex Factory mirror already fetched by the workspace; this
 * pure helper decides whether `now` sits inside a blackout window.
 *
 * Crypto trades as a USD-beta asset: CPI, FOMC, NFP and the like whipsaw
 * both directions in seconds, so USD "High" impact events get a symmetric
 * ±15 min block. A missing/failed feed returns no block — the guard
 * fails OPEN (missing data must never freeze the book).
 */

export interface NewsGuardEvent {
  /** ISO timestamp of the release. */
  time: string;
  /** "High" | "Medium" | "Low" | "Holiday" etc. */
  impact: string;
  /** ISO currency code; treated as USD when absent. */
  currency?: string;
}

/** No entries 15 min before or after a high-impact USD release. */
export const NEWS_BLACKOUT_MS = 15 * 60_000;

export function newsBlockEvent(
  events: readonly NewsGuardEvent[],
  now: number,
): NewsGuardEvent | undefined {
  return events.find(
    (e) =>
      e.impact === "High" &&
      (e.currency === undefined || e.currency === "USD") &&
      Math.abs(Date.parse(e.time) - now) <= NEWS_BLACKOUT_MS,
  );
}
