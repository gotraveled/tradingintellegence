/**
 * assessDataFreshness — session-aware staleness (M2). Separates the facts the
 * contract demands: classification is the vendor's label; freshness is how old
 * the last bar is on the market's own clock. Retrieval time is never data time.
 */
import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { assessDataFreshness } from "../data-freshness";
import { nseRegular } from "@/lib/market-data/calendars/nse";

const IST_MS = 330 * 60_000;
const istUtc = (date: string, hhmm: string): number =>
  Date.parse(`${date}T${hhmm}:00Z`) - IST_MS;

const HOUR = 3_600_000;
const DAY = 86_400_000;
// A Monday 00:00 UTC anchor — weekday calendar is open, crypto is always open.
const MON_OPEN = Date.UTC(2026, 9, 12); // Monday
const SAT = Date.UTC(2026, 9, 17); // Saturday
const SUN = Date.UTC(2026, 9, 18); // Sunday

const bar = (t: number): Candle => ({ time: t, open: 1, high: 1, low: 1, close: 1 });

describe("assessDataFreshness — session-aware staleness", () => {
  it("empty window → no last-bar facts, not stale", () => {
    const f = assessDataFreshness({
      candles: [], timeframe: "1D", is24x7: false, nowMs: MON_OPEN,
    });
    expect(f.lastBarTimestamp).toBeUndefined();
    expect(f.observedAgeMs).toBeUndefined();
    expect(f.stale).toBe(false);
  });

  it("weekend closure contributes zero expected intervals — not stale", () => {
    // Last bar Friday close, read Sunday: 2d wall-clock but the weekday market
    // was legitimately shut — the data is current, not stale.
    const friday = Date.UTC(2026, 9, 16); // Friday
    const f = assessDataFreshness({
      candles: [bar(friday)], timeframe: "1D", is24x7: false, nowMs: SUN,
    });
    expect(f.observedAgeMs).toBe(SUN - friday); // wall age exists…
    expect(f.expectedIntervalsSinceLastBar).toBe(0); // …but no open intervals passed
    expect(f.stale).toBe(false);
  });

  it("missing bars while the market was open → stale", () => {
    // Last bar Monday open, read Friday: Tue/Wed/Thu bars all opened and
    // closed before now — 3 session-open intervals elapsed, beyond the grace.
    const friday = Date.UTC(2026, 9, 16);
    const f = assessDataFreshness({
      candles: [bar(MON_OPEN)], timeframe: "1D", is24x7: false, nowMs: friday,
    });
    expect(f.expectedIntervalsSinceLastBar).toBe(3);
    expect(f.stale).toBe(true);
  });

  it("grace boundary: the forming bar at `now` is never counted as missed", () => {
    // Mon + 3d: Tue+Wed bars fully elapsed (2), Thu bar opens AT now → not
    // counted, not missed. Mon + 4d: three elapsed intervals → stale.
    const thursday = MON_OPEN + 3 * DAY;
    const friday = MON_OPEN + 4 * DAY;
    expect(
      assessDataFreshness({ candles: [bar(MON_OPEN)], timeframe: "1D", is24x7: false, nowMs: thursday }),
    ).toMatchObject({ expectedIntervalsSinceLastBar: 2, stale: false });
    expect(
      assessDataFreshness({ candles: [bar(MON_OPEN)], timeframe: "1D", is24x7: false, nowMs: friday }),
    ).toMatchObject({ expectedIntervalsSinceLastBar: 3, stale: true });
  });

  it("crypto (24/7) — a multi-day gap has no closure excuse, honestly stale", () => {
    const f = assessDataFreshness({
      candles: [bar(SAT)], timeframe: "1D", is24x7: true, nowMs: SAT + 4 * DAY,
    });
    expect(f.expectedIntervalsSinceLastBar).toBe(3); // Sun/Mon/Tue bars elapsed
    expect(f.stale).toBe(true);
  });

  it("crypto weekend — the bar opening at `now` is forming, not missed", () => {
    const f = assessDataFreshness({
      candles: [bar(SAT)], timeframe: "1D", is24x7: true, nowMs: SUN,
    });
    expect(f.expectedIntervalsSinceLastBar).toBe(0); // Sunday bar just opened
    expect(f.stale).toBe(false);
  });

  it("fresh read — last bar just closed → zero elapsed intervals", () => {
    const f = assessDataFreshness({
      candles: [bar(MON_OPEN)], timeframe: "1h", is24x7: false, nowMs: MON_OPEN + HOUR,
    });
    expect(f.expectedIntervalsSinceLastBar).toBe(0);
    expect(f.stale).toBe(false);
    expect(f.observedAgeMs).toBe(HOUR);
  });

  it("1M (calendar interval) is uncountable — sessionAware false, never invented stale", () => {
    const f = assessDataFreshness({
      candles: [bar(MON_OPEN)], timeframe: "1M", is24x7: false, nowMs: MON_OPEN + 90 * DAY,
    });
    expect(f.expectedIntervalsSinceLastBar).toBeUndefined();
    expect(f.sessionAware).toBe(false);
    expect(f.stale).toBe(false); // conservative — no fake precision
    expect(f.observedAgeMs).toBe(90 * DAY); // the honest wall-clock fact remains
  });

  it("NSE: a declared holiday is a closure — zero expected bars, never stale", () => {
    // Dussehra 2026-10-20 (Tuesday). A weekday-UTC calendar would see a missing
    // trading day; the exchange calendar knows the session never opened.
    const nse = nseRegular();
    const f = assessDataFreshness({
      candles: [bar(istUtc("2026-10-19", "09:15"))], // Monday session bar
      timeframe: "1D",
      calendar: nse,
      nowMs: istUtc("2026-10-21", "09:00"), // Wednesday pre-open
    });
    // Tue was a holiday and the Wed 09:15 bar hasn't opened yet at 09:00 —
    // the calendar sees zero missed session-open bars, not an outage.
    expect(f.expectedIntervalsSinceLastBar).toBe(0);
    expect(f.stale).toBe(false);
  });

  it("NSE: missing bars during a real session → stale", () => {
    const nse = nseRegular();
    const f = assessDataFreshness({
      candles: [bar(istUtc("2026-10-15", "09:15"))], // Thursday open bar
      timeframe: "5m",
      calendar: nse,
      nowMs: istUtc("2026-10-15", "10:15"), // 11 elapsed opens; the 10:15 bar is forming
    });
    expect(f.expectedIntervalsSinceLastBar).toBe(11);
    expect(f.stale).toBe(true);
  });

  it("NSE: outside the holiday-table window the calendar declines, honestly", () => {
    const nse = nseRegular();
    const f = assessDataFreshness({
      candles: [bar(istUtc("2027-01-05", "09:15"))],
      timeframe: "1D",
      calendar: nse,
      nowMs: istUtc("2027-01-09", "12:00"),
    });
    expect(f.expectedIntervalsSinceLastBar).toBeUndefined(); // unverifiable span
    expect(f.sessionAware).toBe(false);
    expect(f.stale).toBe(false); // conservative — never assert what isn't known
  });

  it("retrievedAt is the read instant — never the last bar's time", () => {
    const f = assessDataFreshness({
      candles: [bar(MON_OPEN)], timeframe: "1D", is24x7: false, nowMs: MON_OPEN + DAY,
    });
    expect(f.retrievedAt).toBe(MON_OPEN + DAY);
    expect(f.lastBarTimestamp).toBe(MON_OPEN);
    expect(f.retrievedAt).not.toBe(f.lastBarTimestamp);
  });
});
