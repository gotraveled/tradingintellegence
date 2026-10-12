import { describe, expect, it } from "vitest";
import { TIMEFRAME_MS, alignFloor, intervalDivisible, timeframeMs } from "../timeframes";

const E = Date.UTC(2024, 0, 1); // Monday 2024-01-01T00:00:00Z

describe("timeframes", () => {
  it("exposes deterministic fixed durations", () => {
    expect(TIMEFRAME_MS["1m"]).toBe(60_000);
    expect(TIMEFRAME_MS["15m"]).toBe(900_000);
    expect(TIMEFRAME_MS["1h"]).toBe(3_600_000);
    expect(TIMEFRAME_MS["4h"]).toBe(14_400_000);
    expect(TIMEFRAME_MS["1D"]).toBe(86_400_000);
    expect(TIMEFRAME_MS["1W"]).toBe(604_800_000);
  });

  it("returns undefined duration for calendar-based 1M", () => {
    expect(timeframeMs("1M")).toBeUndefined();
    expect("1M" in TIMEFRAME_MS).toBe(false);
  });

  it("intervalDivisible follows clean-coverage math", () => {
    expect(intervalDivisible("5m", "15m")).toBe(true);
    expect(intervalDivisible("15m", "1h")).toBe(true);
    expect(intervalDivisible("1h", "4h")).toBe(true);
    expect(intervalDivisible("15m", "5m")).toBe(false); // wrong direction
    expect(intervalDivisible("3m", "5m")).toBe(false); // 5m % 3m ≠ 0
    expect(intervalDivisible("5m", "1M")).toBe(false); // calendar target
    expect(intervalDivisible("1M", "1D")).toBe(false);
  });

  it("alignFloor snaps to interval boundaries", () => {
    expect(alignFloor(E + 7 * 60_000, "5m")).toBe(E + 5 * 60_000);
    expect(alignFloor(E + 5 * 3_600_000, "4h")).toBe(E + 4 * 3_600_000);
    expect(alignFloor(E, "1D")).toBe(E);
  });

  it("alignFloor uses UTC week (Monday) for 1W", () => {
    const wednesday = Date.UTC(2024, 0, 3, 12, 0); // Jan 3 is a Wednesday
    expect(alignFloor(wednesday, "1W")).toBe(E); // Monday Jan 1
    expect(alignFloor(Date.UTC(2024, 0, 7), "1W")).toBe(E); // Sunday → same Monday
    expect(alignFloor(Date.UTC(2024, 0, 8), "1W")).toBe(Date.UTC(2024, 0, 8));
  });

  it("alignFloor uses UTC month start for 1M", () => {
    expect(alignFloor(Date.UTC(2024, 0, 15), "1M")).toBe(E);
    expect(alignFloor(Date.UTC(2024, 1, 3), "1M")).toBe(Date.UTC(2024, 1, 1));
  });
});
