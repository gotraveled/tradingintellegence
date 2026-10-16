import { describe, expect, it } from "vitest";
import { alwaysOpen, sessionWindowUtc, weekdayUtc } from "../sessions";
import { nseRegular, NSE_HOLIDAYS_2026 } from "../calendars/nse";

const IST_MS = 330 * 60_000; // UTC+5:30, fixed — no DST in IST
/** UTC instant of `HH:MM` on an IST local date. */
const istUtc = (date: string, hhmm: string): number =>
  Date.parse(`${date}T${hhmm}:00Z`) - IST_MS;

const MON = Date.UTC(2024, 0, 1, 12, 0); // Monday noon UTC
const SAT = Date.UTC(2024, 0, 6, 12, 0); // Saturday noon UTC
const SUN = Date.UTC(2024, 0, 7, 12, 0); // Sunday noon UTC

describe("SessionCalendar", () => {
  it("alwaysOpen is continuous and counts bars exactly", () => {
    const cal = alwaysOpen();
    expect(cal.continuous).toBe(true);
    expect(cal.isOpenAt(SAT)).toBe(true);
    expect(cal.expectedBars(0, 3_600_000, 900_000)).toBe(4);
    expect(cal.expectedBars(0, 0, 900_000)).toBe(0);
  });

  it("weekdayUtc opens Mon–Fri, closes weekends", () => {
    const cal = weekdayUtc();
    expect(cal.isOpenAt(MON)).toBe(true);
    expect(cal.isOpenAt(SAT)).toBe(false);
    expect(cal.isOpenAt(SUN)).toBe(false);
    expect(cal.isOpenAt(Date.UTC(2024, 0, 5, 23, 59))).toBe(true); // Friday
    expect(cal.expectedBars(0, 86_400_000, 300_000)).toBeUndefined();
  });

  it("sessionWindowUtc honours the window on weekdays only", () => {
    const nse = sessionWindowUtc("nse-test", 225, 600); // 03:45–10:00 UTC ≈ NSE hours
    expect(nse.isOpenAt(Date.UTC(2024, 0, 1, 4, 0))).toBe(true); // Mon 04:00 inside
    expect(nse.isOpenAt(Date.UTC(2024, 0, 1, 9, 59))).toBe(true); // just before close
    expect(nse.isOpenAt(Date.UTC(2024, 0, 1, 10, 0))).toBe(false); // at close
    expect(nse.isOpenAt(Date.UTC(2024, 0, 1, 2, 0))).toBe(false); // before open
    expect(nse.isOpenAt(Date.UTC(2024, 0, 6, 4, 0))).toBe(false); // Saturday
  });
});

describe("nseRegular — IST session calendar with versioned holidays", () => {
  const nse = nseRegular();

  it("session window is 09:15–15:30 IST, not UTC-clock based", () => {
    expect(nse.continuous).toBe(false);
    expect(nse.isOpenAt(istUtc("2026-10-15", "09:15"))).toBe(true);  // at open
    expect(nse.isOpenAt(istUtc("2026-10-15", "12:00"))).toBe(true);  // mid-session
    expect(nse.isOpenAt(istUtc("2026-10-15", "15:29"))).toBe(true);  // last minute
    expect(nse.isOpenAt(istUtc("2026-10-15", "15:30"))).toBe(false); // at close
    expect(nse.isOpenAt(istUtc("2026-10-15", "09:14"))).toBe(false); // pre-open
  });

  it("weekends are expected closures — Saturday and Sunday IST", () => {
    // 2026-10-17 is a Saturday, 2026-10-18 a Sunday (IST).
    expect(nse.isOpenAt(istUtc("2026-10-17", "10:00"))).toBe(false);
    expect(nse.isOpenAt(istUtc("2026-10-18", "10:00"))).toBe(false);
  });

  it("declared holidays are closed at session hours — not outages", () => {
    // Dussehra 2026-10-20 (Tuesday) — mid-session would be open on a weekday.
    expect(nse.isOpenAt(istUtc("2026-10-20", "10:00"))).toBe(false);
    // Christmas 2026-12-25 (Friday).
    expect(nse.isOpenAt(istUtc("2026-12-25", "10:00"))).toBe(false);
    // The day after a holiday is a normal session.
    expect(nse.isOpenAt(istUtc("2026-10-21", "10:00"))).toBe(true);
  });

  it("special sessions stay closed — Muhurat Sunday is recorded, not open", () => {
    expect(NSE_HOLIDAYS_2026.specialSessions[0].date).toBe("2026-11-08");
    expect(nse.isOpenAt(istUtc("2026-11-08", "10:00"))).toBe(false);
  });

  it("coverage window is declared — 2026 covered, adjacent years not", () => {
    expect(nse.covers!(istUtc("2026-06-15", "10:00"))).toBe(true);
    expect(nse.covers!(istUtc("2026-01-01", "10:00"))).toBe(true);
    expect(nse.covers!(istUtc("2026-12-31", "10:00"))).toBe(true);
    expect(nse.covers!(istUtc("2027-01-05", "10:00"))).toBe(false);
    expect(nse.covers!(istUtc("2025-12-30", "10:00"))).toBe(false);
  });

  it("expectedBars counts a full session — 75×5m bars per trading day", () => {
    const dayOpen = istUtc("2026-10-15", "09:15");
    const dayClose = istUtc("2026-10-15", "15:30");
    expect(nse.expectedBars(dayOpen, dayClose, 5 * 60_000)).toBe(75);
    expect(nse.expectedBars(dayOpen, dayClose, 15 * 60_000)).toBe(25);
    expect(nse.expectedBars(dayOpen, dayClose, 60_000)).toBe(375);
  });

  it("expectedBars honors holidays and weekends across a span", () => {
    // Mon 19 Oct → Wed 21 Oct: 19 and 21 trade, 20 (Dussehra) does not.
    const start = istUtc("2026-10-19", "09:15");
    const end = istUtc("2026-10-21", "15:30");
    expect(nse.expectedBars(start, end, 5 * 60_000)).toBe(150);
    // A pure weekend span expects nothing.
    expect(
      nse.expectedBars(istUtc("2026-10-17", "09:15"), istUtc("2026-10-18", "15:30"), 5 * 60_000),
    ).toBe(0);
  });

  it("expectedBars is undefined for non-tiling intervals — never convention-guessed", () => {
    // 375-minute sessions do not tile evenly into 1h.
    const dayOpen = istUtc("2026-10-15", "09:15");
    const dayClose = istUtc("2026-10-15", "15:30");
    expect(nse.expectedBars(dayOpen, dayClose, 3_600_000)).toBeUndefined();
  });

  it("expectedBars is undefined when the span exits holiday coverage", () => {
    // A 2027 date is outside the declared table — honest unknown, not a guess.
    expect(
      nse.expectedBars(istUtc("2027-01-05", "09:15"), istUtc("2027-01-05", "15:30"), 5 * 60_000),
    ).toBeUndefined();
    expect(
      nse.expectedBars(istUtc("2026-12-31", "09:15"), istUtc("2027-01-02", "15:30"), 5 * 60_000),
    ).toBeUndefined(); // spans the coverage boundary
  });

  it("daily bars count trading days only", () => {
    // Thu 15 → Fri 16 Oct: both trade → 2. Add the weekend + holiday Mon? no —
    // Fri 16 to Tue 20 contains Fri (trades), Sat/Sun closed, Mon 19 open,
    // Tue 20 holiday → 2 trading days whose sessions open inside the window.
    expect(
      nse.expectedBars(istUtc("2026-10-15", "09:15"), istUtc("2026-10-16", "15:30"), 86_400_000),
    ).toBe(2);
  });
});
