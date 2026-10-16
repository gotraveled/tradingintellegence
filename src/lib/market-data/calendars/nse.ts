/**
 * NSE equity session calendar (Phase M3) — versioned, sourced, bounded.
 *
 * Session: 09:15–15:30 IST, Monday–Friday. IST is UTC+5:30 with no DST, so the
 * fixed-offset contract in `exchangeCalendar` applies exactly.
 *
 * Holidays: the official "Trading Holidays for the calendar year 2026 —
 * Equity and Equity Derivatives Segments" circular (NSE, December 2025).
 * The table is the DECLARED scope of this calendar — `covers()` reports false
 * outside it and `expectedBars`/`freshness` decline rather than guess at a
 * year nobody has published yet.
 *
 * Special sessions: Sunday 2026-11-08 has Muhurat trading with timings to be
 * notified by circular — it is recorded below as a special session but treated
 * as CLOSED (irregular hours, window unverified → conservative).
 *
 * Maintenance: add a new table per year (or replace + bump `version`) when the
 * exchange circular publishes; never silently extend coverage.
 */
import { exchangeCalendar, type SessionCalendar } from "../sessions";

/** NSE equity trading holidays, calendar year 2026 — local (IST) dates. */
export const NSE_HOLIDAYS_2026 = {
  version: "nse-equity-2026",
  source:
    "NSE circular: Trading Holidays for the calendar year 2026 — Equity and " +
    "Equity Derivatives Segments (Dec 2025); exchange may amend by circular",
  dates: [
    "2026-01-26", // Republic Day — Monday
    "2026-03-03", // Holi — Tuesday
    "2026-03-26", // Shri Ram Navami — Thursday
    "2026-03-31", // Shri Mahavir Jayanti — Tuesday
    "2026-04-03", // Good Friday — Friday
    "2026-04-14", // Dr. Baba Saheb Ambedkar Jayanti — Tuesday
    "2026-05-01", // Maharashtra Day — Friday
    "2026-05-28", // Bakri Id — Thursday
    "2026-06-26", // Muharram — Friday
    "2026-09-14", // Ganesh Chaturthi — Monday
    "2026-10-02", // Mahatma Gandhi Jayanti — Friday
    "2026-10-20", // Dussehra — Tuesday
    "2026-11-10", // Diwali Balipratipada — Tuesday
    "2026-11-24", // Prakash Gurpurb Sri Guru Nanak Dev — Tuesday
    "2026-12-25", // Christmas — Friday
  ],
  /** Special sessions recorded but not modeled — irregular windows are closed
   *  until a circular publishes their exact timings. */
  specialSessions: [
    {
      date: "2026-11-08",
      note: "Muhurat Trading (Diwali Laxmi Pujan, Sunday) — timings notified separately; treated as closed",
    },
  ],
} as const;

const IST_OFFSET_MINUTES = 330; // UTC+5:30, no DST — fixed-offset contract holds
const NSE_OPEN_MINUTES = 9 * 60 + 15; // 09:15 IST
const NSE_CLOSE_MINUTES = 15 * 60 + 30; // 15:30 IST

/**
 * The regular NSE equity session calendar. Covered dates are exactly the 2026
 * holiday-table window; anything outside it reports unverifiable so freshness
 * and coverage math stay conservative instead of fabricating a calendar.
 */
export function nseRegular(): SessionCalendar {
  return exchangeCalendar({
    id: "nse-regular",
    utcOffsetMinutes: IST_OFFSET_MINUTES,
    sessionOpen: NSE_OPEN_MINUTES,
    sessionClose: NSE_CLOSE_MINUTES,
    holidays: NSE_HOLIDAYS_2026.dates,
    holidayCoverage: { from: "2026-01-01", to: "2026-12-31" },
    source: `${NSE_HOLIDAYS_2026.source} [${NSE_HOLIDAYS_2026.version}]`,
  });
}
