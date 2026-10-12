import { describe, expect, it } from "vitest";
import { alwaysOpen, sessionWindowUtc, weekdayUtc } from "../sessions";

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
