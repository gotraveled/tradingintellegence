/**
 * Freshness assessment (Phase M2) — how old the last returned bar is, measured
 * on the market's own session clock. Deliberately separate from:
 *
 *   classification — the vendor's delivery-tier label (historical/delayed/live)
 *   retrievedAt    — when THIS read happened (says nothing about data age)
 *   vendor status  — DELAYED/OK describes the feed's contract, not bar recency
 *
 * Staleness rule: `stale` only when more than STALE_INTERVAL_GRACE session-open
 * intervals have elapsed between the last bar's close and now — i.e. the market
 * was open and bars were absent. A weekend on a weekday calendar contributes
 * ZERO expected intervals, so legitimate closures never masquerade as outages
 * (and the inverse: a multi-day weekday gap is honestly flagged).
 *
 * Limits (documented, not hidden): callers choose the calendar — `calendar`
 * (e.g. `nseRegular()`) when the market has a real session calendar, else the
 * coarse defaults (`alwaysOpen` for 24/7, `weekdayUtc` elsewhere). An exchange
 * calendar that cannot verify the span (`covers` fails — e.g. outside its
 * holiday-table window) yields `expectedIntervals` undefined rather than a
 * guess: unknown is honest, invented staleness is not. `1M` (calendar month)
 * has no fixed duration — same undefined, same conservative `stale: false`.
 */
import type { Candle, DataFreshness, Timeframe, UnixMs } from "@/lib/types";
import { calendarFor, type SessionCalendar } from "@/lib/market-data/sessions";
import { timeframeMs } from "@/lib/market-data/timeframes";

/** Session-open intervals a feed may lag before the data is called stale. */
export const STALE_INTERVAL_GRACE = 2;
/** Iteration bound for session calendars — beyond it, data is stale anyway. */
const SCAN_CAP = 500_000;

/**
 * Count session-open intervals in `(lastBarOpen + interval, now)` — bars the
 * market would have produced had it been trading and the feed current.
 * Undefined when the interval is uncountable (calendar months).
 */
function expectedIntervals(
  calendar: SessionCalendar,
  lastBarOpen: UnixMs,
  nowMs: UnixMs,
  intervalMs: number | undefined,
): number | undefined {
  if (intervalMs === undefined) return undefined;
  const start = lastBarOpen + intervalMs;
  if (nowMs <= start) return 0;
  // Coverage gate: an exchange calendar only counts spans its closure data
  // actually covers — holidays outside the table are unverifiable, and
  // unknown is honest while guessed staleness is not.
  if (calendar.covers && !(calendar.covers(start) && calendar.covers(nowMs - 1))) {
    return undefined;
  }
  if (calendar.continuous) {
    return Math.floor((nowMs - start) / intervalMs);
  }
  let count = 0;
  for (let t = start; t < nowMs && count <= SCAN_CAP; t += intervalMs) {
    if (calendar.isOpenAt(t)) count++;
  }
  return count;
}

/** Assess freshness for a returned window — never throws, never fabricates. */
export function assessDataFreshness(input: {
  candles: readonly Candle[];
  timeframe: Timeframe;
  /** True when the asset trades around the clock (crypto) — same axis the
   *  quality layer's `is24x7` uses; ignored when `calendar` is supplied. */
  is24x7?: boolean;
  /** Explicit session calendar (e.g. `nseRegular()`) — takes precedence over
   *  `is24x7` so exchange-aware callers get holidays, not weekday guesses. */
  calendar?: SessionCalendar;
  nowMs: UnixMs;
}): DataFreshness {
  const { candles, timeframe, is24x7, calendar, nowMs } = input;
  const resolved = calendar ?? calendarFor({ is24x7 });
  const lastBar = candles.length > 0 ? candles[candles.length - 1] : undefined;

  if (!lastBar) {
    return { retrievedAt: nowMs, stale: false, sessionAware: true };
  }

  const intervalMs = timeframeMs(timeframe);
  const expected = expectedIntervals(resolved, lastBar.time, nowMs, intervalMs);
  const sessionAware = expected !== undefined;

  return {
    lastBarTimestamp: lastBar.time,
    retrievedAt: nowMs,
    observedAgeMs: Math.max(0, nowMs - lastBar.time),
    ...(expected !== undefined ? { expectedIntervalsSinceLastBar: expected } : {}),
    // Stale only when the session clock says intervals passed with no bars —
    // closed markets (weekends, off-hours) keep stale:false by construction.
    stale: sessionAware === true && expected > STALE_INTERVAL_GRACE,
    sessionAware,
  };
}
