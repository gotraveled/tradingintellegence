import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { validateBars, validateSeries } from "../validation";
import { alwaysOpen, weekdayUtc } from "../sessions";

const E = Date.UTC(2024, 0, 1); // Monday
const M5 = 300_000;
const bar = (i: number, o = 100, h = 101, l = 99, c = 100.5): Candle => ({
  time: E + i * M5,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: 1000 + i,
});
const codes = (r: ReturnType<typeof validateSeries>) => r.issues.map((i) => i.code);

describe("validateBars", () => {
  it("accepts a clean bar", () => {
    expect(validateBars([bar(0)], "5m")).toHaveLength(0);
  });
  it("rejects non-finite OHLC", () => {
    const issues = validateBars([{ ...bar(0), high: NaN }], "5m");
    expect(issues[0].code).toBe("non_finite_ohlc");
    expect(issues[0].severity).toBe("error");
  });
  it("rejects high < close (envelope violation)", () => {
    const issues = validateBars([{ ...bar(0), high: 99.5 }], "5m");
    expect(issues[0].code).toBe("invalid_ohlc_relationship");
  });
  it("rejects low > open (envelope violation)", () => {
    const issues = validateBars([{ ...bar(0), low: 101 }], "5m");
    expect(issues[0].code).toBe("invalid_ohlc_relationship");
  });
  it("rejects negative volume", () => {
    const issues = validateBars([{ ...bar(0), volume: -1 }], "5m");
    expect(issues[0].code).toBe("negative_volume");
  });
  it("flags unaligned timestamps as warning", () => {
    const issues = validateBars([{ ...bar(0), time: E + 7 * 60_000 }], "5m");
    expect(issues[0].code).toBe("misaligned_interval");
    expect(issues[0].severity).toBe("warning");
  });
  it("rejects invalid timestamps", () => {
    expect(validateBars([{ ...bar(0), time: -5 }], "5m")[0].code).toBe("invalid_timestamp");
    expect(validateBars([{ ...bar(0), time: NaN }], "5m")[0].code).toBe("invalid_timestamp");
  });
});

describe("validateSeries", () => {
  it("clean series → no issues", () => {
    const r = validateSeries([bar(0), bar(1), bar(2)], "5m", alwaysOpen());
    expect(r.issues).toHaveLength(0);
    expect(r.validBars).toHaveLength(3);
  });

  it("detects duplicates", () => {
    const r = validateSeries([bar(0), bar(1), bar(1), bar(2)], "5m");
    expect(r.duplicateCount).toBe(1);
    expect(codes(r)).toContain("duplicate_timestamp");
  });

  it("detects out-of-order against last valid bar", () => {
    const r = validateSeries([bar(0), bar(1), bar(3), bar(2), bar(4)], "5m");
    expect(r.outOfOrderCount).toBe(1);
    expect(codes(r)).toContain("out_of_order");
  });

  it("detects overlapping candles (delta < interval)", () => {
    const overlap: Candle = { time: E + M5 + 60_000, open: 100, high: 101, low: 99, close: 100.5 };
    const r = validateSeries([bar(0), bar(1), overlap], "5m");
    expect(codes(r)).toContain("overlapping_candle");
    expect(codes(r)).toContain("misaligned_interval");
  });

  it("missing bars become gaps — unexpected for a 24/7 calendar", () => {
    const r = validateSeries([bar(0), bar(1), bar(3), bar(4)], "5m", alwaysOpen());
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].kind).toBe("unexpected");
    expect(r.gaps[0].missingBars).toBe(1);
    expect(r.gaps[0].afterTime).toBe(E + M5);
    expect(r.gaps[0].beforeTime).toBe(E + 3 * M5);
  });

  it("weekend gap is expected under a weekday calendar", () => {
    const candles: Candle[] = [
      { time: Date.UTC(2024, 0, 5, 23, 55), open: 1, high: 2, low: 0.5, close: 1.5 }, // Fri
      { time: Date.UTC(2024, 0, 8, 0, 0), open: 1, high: 2, low: 0.5, close: 1.5 }, // Mon
    ];
    const r = validateSeries(candles, "5m", weekdayUtc());
    expect(r.gaps[0].kind).toBe("expected");
    expect(codes(r)).toContain("gap_expected");
    expect(codes(r)).not.toContain("gap_unexpected");
  });

  it("the same weekend gap is unexpected under a 24/7 calendar", () => {
    const candles: Candle[] = [
      { time: Date.UTC(2024, 0, 5, 23, 55), open: 1, high: 2, low: 0.5, close: 1.5 },
      { time: Date.UTC(2024, 0, 8, 0, 0), open: 1, high: 2, low: 0.5, close: 1.5 },
    ];
    const r = validateSeries(candles, "5m", alwaysOpen());
    expect(r.gaps[0].kind).toBe("unexpected");
  });

  it("gaps are unknown without a calendar — honest, not assumed corrupt", () => {
    const r = validateSeries([bar(0), bar(3)], "5m");
    expect(r.gaps[0].kind).toBe("unknown");
    expect(codes(r)).toContain("gap_unknown");
  });

  it("gap severity: expected/unknown are info, unexpected is warning", () => {
    const weekday = validateSeries(
      [
        { time: Date.UTC(2024, 0, 5, 23, 55), open: 1, high: 2, low: 0.5, close: 1.5 },
        { time: Date.UTC(2024, 0, 8, 0, 0), open: 1, high: 2, low: 0.5, close: 1.5 },
      ],
      "5m",
      weekdayUtc(),
    );
    expect(weekday.issues[0].severity).toBe("info");
    const always = validateSeries([bar(0), bar(3)], "5m", alwaysOpen());
    expect(always.issues.find((i) => i.code === "gap_unexpected")?.severity).toBe("warning");
  });

  it("invalid bars are excluded from validBars, never repaired", () => {
    const r = validateSeries([bar(0), { ...bar(1), high: 90 }, bar(2)], "5m");
    expect(r.invalidBarCount).toBe(1);
    expect(r.validBars).toHaveLength(2);
  });
});
