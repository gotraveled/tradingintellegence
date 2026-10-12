import type { Timeframe, UnixMs } from "@/lib/types";
import { timeframeMs } from "./timeframes";

/**
 * Session-calendar abstraction (spec 11). Determines whether a market is open at a bar-open
 * timestamp and whether expected-bar counts can be derived. Calendars are pluggable — real
 * exchange calendars (NSE, NYSE, holidays) are added in later phases by implementing this
 * contract, not by modifying callers.
 */
export interface SessionCalendar {
  readonly id: string;
  /** True when the market trades around the clock, every day. */
  readonly continuous: boolean;
  /** Is the market open for a bar whose open time is `t`? */
  isOpenAt(t: UnixMs): boolean;
  /**
   * Count of interval bars the calendar expects between `start` (inclusive) and `end`
   * (exclusive), when the calendar can answer exactly — e.g. always-open markets.
   * Session calendars return undefined ("where determinable" per spec 5).
   */
  expectedBars(start: UnixMs, end: UnixMs, intervalMs: number): number | undefined;
}

/** 24/7 market (crypto spot, synthetic feeds) — every interval is a trading bar. */
export function alwaysOpen(id = "always-open"): SessionCalendar {
  return {
    id,
    continuous: true,
    isOpenAt: () => true,
    expectedBars: (start, end, intervalMs) => Math.max(0, Math.floor((end - start) / intervalMs)),
  };
}

/**
 * UTC weekday market — open 00:00 Monday through 23:59:59 Friday, closed weekends.
 * Holiday calendars are a future extension; this covers the spec's "weekend gap" case.
 */
export function weekdayUtc(id = "weekday-utc"): SessionCalendar {
  return {
    id,
    continuous: false,
    isOpenAt: (t) => {
      const day = new Date(t).getUTCDay();
      return day >= 1 && day <= 5;
    },
    // Intraday-session bar counting requires per-session windows — not determinable at this level.
    expectedBars: () => undefined,
  };
}

const WEEKEND_ID = 6; // Saturday UTC

/**
 * Exchange-window calendar — open on weekdays inside `openMinutes..closeMinutes` of UTC day.
 * For sessioned markets like NSE (09:15–15:30 IST → 03:45–10:00 UTC). Calendars in the asset's
 * own IANA timezone are a later extension; v1 keeps everything UTC per spec 3.
 */
export function sessionWindowUtc(
  id: string,
  openMinutes: number,
  closeMinutes: number,
): SessionCalendar {
  return {
    id,
    continuous: false,
    isOpenAt: (t) => {
      const d = new Date(t);
      const day = d.getUTCDay();
      if (day === 0 || day === WEEKEND_ID) return false; // Saturday/Sunday UTC
      const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
      return minutes >= openMinutes && minutes < closeMinutes;
    },
    expectedBars: () => undefined,
  };
}

/** Resolve a calendar from a series' own metadata when present, else by asset class. */
export function calendarFor(input: {
  is24x7?: boolean;
  calendar?: SessionCalendar;
}): SessionCalendar {
  if (input.calendar) return input.calendar;
  return input.is24x7 === false ? weekdayUtc() : alwaysOpen();
}

/** Interval ms for a fixed timeframe — undefined for "1M" (callers treat as uncountable). */
export function intervalOf(tf: Timeframe): number | undefined {
  return timeframeMs(tf);
}
