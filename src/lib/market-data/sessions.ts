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
   * (exclusive), when the calendar can answer exactly — e.g. always-open markets,
   * and exchange calendars where `intervalMs` evenly tiles the session.
   * Returns undefined when the count is not honestly determinable
   * ("where determinable" per spec 5).
   */
  expectedBars(start: UnixMs, end: UnixMs, intervalMs: number): number | undefined;
  /**
   * True when this calendar's closure data (holidays, special sessions) actually
   * covers the local date containing `t`. Coarse calendars (weekday, always-open)
   * model no dated closures and omit this — always "covered". Exchange calendars
   * report false outside their holiday-table window so callers can choose
   * conservative behavior rather than assert verified knowledge they lack.
   */
  covers?(t: UnixMs): boolean;
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

// ---------------------------------------------------------------------------
// Exchange session calendars (Phase M3) — real timezone, session window,
// versioned holiday table, and honest expected-bar counting.

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
/** Day-scan bound — ~13.7 years; wider spans return undefined (uncountable). */
const DAY_SCAN_CAP = 5_000;

export interface ExchangeCalendarSpec {
  readonly id: string;
  /** Fixed UTC offset of the exchange timezone in minutes (IST = +330). Exchange
   *  zones with DST are out of scope for the fixed-offset contract — a spec that
   *  needs them must say so rather than silently drifting. */
  readonly utcOffsetMinutes: number;
  /** Regular session, minutes past local midnight: [open, close). */
  readonly sessionOpen: number;
  readonly sessionClose: number;
  /** Local dates (YYYY-MM-DD) that are full-session closures. */
  readonly holidays: readonly string[];
  /** Local-date range the holiday table actually covers — outside it, covers()
   *  reports false and expectedBars declines rather than guessing. */
  readonly holidayCoverage: { from: string; to: string };
  /** Where the table came from + its version — for audit and refresh. */
  readonly source: string;
}

/** Wall-clock fields of `t` in a fixed-offset exchange zone (no DST contract). */
function toExchangeLocal(t: UnixMs, offsetMinutes: number): Date {
  return new Date(t + offsetMinutes * MIN_MS);
}

/** Local calendar date key — "YYYY-MM-DD" in the exchange timezone. */
function exchangeDateKey(t: UnixMs, offsetMinutes: number): string {
  return toExchangeLocal(t, offsetMinutes).toISOString().slice(0, 10);
}

/**
 * Regular-session exchange calendar. The session grid (weekdays, window,
 * holidays) is real; sessions that don't tile the requested interval honestly
 * (e.g. 375-minute sessions vs 1h bars) return undefined rather than a
 * convention-dependent number.
 */
export function exchangeCalendar(spec: ExchangeCalendarSpec): SessionCalendar {
  const holidaySet = new Set(spec.holidays);
  const sessionMinutes = spec.sessionClose - spec.sessionOpen;
  const sessionMs = sessionMinutes * MIN_MS;

  const isTradingDay = (local: Date): boolean => {
    const day = local.getUTCDay();
    if (day === 0 || day === WEEKEND_ID) return false; // weekend — expected closure
    return !holidaySet.has(local.toISOString().slice(0, 10));
  };

  /** Instant of the session open for a local-day Date (shifted wall clock). */
  const sessionOpenInstant = (local: Date): UnixMs =>
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
    spec.utcOffsetMinutes * MIN_MS +
    spec.sessionOpen * MIN_MS;

  return {
    id: spec.id,
    continuous: false,
    isOpenAt: (t) => {
      const local = toExchangeLocal(t, spec.utcOffsetMinutes);
      if (!isTradingDay(local)) return false;
      const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
      return minutes >= spec.sessionOpen && minutes < spec.sessionClose;
    },
    covers: (t) => {
      const key = exchangeDateKey(t, spec.utcOffsetMinutes);
      return key >= spec.holidayCoverage.from && key <= spec.holidayCoverage.to;
    },
    expectedBars: (start, end, intervalMs) => {
      if (end <= start) return 0;

      // Daily-and-longer bars: one bar per trading day, opened at session open.
      if (intervalMs >= DAY_MS) {
        return countTradingDays(start, end);
      }

      // Intraday: only when the session tiles evenly — otherwise the bar grid
      // depends on vendor conventions we cannot assume.
      if (sessionMs % intervalMs !== 0) return undefined;
      const barsPerSession = sessionMs / intervalMs;

      // Coverage gate — a partially-known span is honestly uncountable.
      if (!coverageContains(start, end)) return undefined;

      let count = 0;
      forEachTradingDay(start, end, (dayOpen) => {
        // Bar-opens at dayOpen + k*interval inside [start, end).
        const kFrom = Math.max(0, Math.ceil((start - dayOpen) / intervalMs));
        const kTo = Math.min(barsPerSession, Math.ceil((end - dayOpen) / intervalMs));
        count += Math.max(0, kTo - kFrom);
      });
      return count;
    },
  };

  /** Is every local date in [start,end) inside the holiday-table window? */
  function coverageContains(start: UnixMs, end: UnixMs): boolean {
    const from = exchangeDateKey(start, spec.utcOffsetMinutes);
    const to = exchangeDateKey(end - 1, spec.utcOffsetMinutes);
    return (
      from >= spec.holidayCoverage.from &&
      to <= spec.holidayCoverage.to &&
      to >= spec.holidayCoverage.from &&
      from <= spec.holidayCoverage.to
    );
  }

  function forEachTradingDay(start: UnixMs, end: UnixMs, fn: (dayOpen: UnixMs) => void): void {
    const startLocal = toExchangeLocal(start, spec.utcOffsetMinutes);
    const endLocal = toExchangeLocal(end, spec.utcOffsetMinutes);
    const startDay = Date.UTC(
      startLocal.getUTCFullYear(), startLocal.getUTCMonth(), startLocal.getUTCDate(),
    );
    const endDay = Date.UTC(
      endLocal.getUTCFullYear(), endLocal.getUTCMonth(), endLocal.getUTCDate(),
    );
    for (let d = startDay; d <= endDay; d += DAY_MS) {
      const local = new Date(d);
      if (isTradingDay(local)) fn(sessionOpenInstant(local));
    }
  }

  function countTradingDays(start: UnixMs, end: UnixMs): number | undefined {
    if (!coverageContains(start, end)) return undefined;
    const startLocal = toExchangeLocal(start, spec.utcOffsetMinutes);
    const endLocal = toExchangeLocal(end - 1, spec.utcOffsetMinutes);
    const startDay = Date.UTC(
      startLocal.getUTCFullYear(), startLocal.getUTCMonth(), startLocal.getUTCDate(),
    );
    const endDay = Date.UTC(
      endLocal.getUTCFullYear(), endLocal.getUTCMonth(), endLocal.getUTCDate(),
    );
    const days = (endDay - startDay) / DAY_MS + 1;
    if (days > DAY_SCAN_CAP) return undefined;
    let count = 0;
    for (let d = startDay; d <= endDay; d += DAY_MS) {
      const local = new Date(d);
      if (!isTradingDay(local)) continue;
      // A daily bar belongs to the window when its session opened inside it.
      const open = sessionOpenInstant(local);
      if (open >= start && open < end) count++;
    }
    return count;
  }
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
