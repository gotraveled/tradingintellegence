import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { buildQualityReport } from "../quality";
import { alwaysOpen, weekdayUtc } from "../sessions";
import { FIXTURE_EPOCH as E, FIXTURES } from "../fixtures";
import { normalizeCandles } from "../normalize";

const M5 = 300_000;
const bar = (i: number): Candle => ({
  time: E + i * M5,
  open: 100,
  high: 101,
  low: 99,
  close: 100.5,
  volume: 1000 + i,
});
const rows = (name: string) =>
  normalizeCandles(FIXTURES.find((f) => f.name === name)!.rows).candles;

describe("buildQualityReport", () => {
  it("clean series → valid, full coverage", () => {
    const r = buildQualityReport({
      symbol: "FIX-CLEAN",
      timeframe: "5m",
      candles: rows("clean-continuous"),
      calendar: alwaysOpen(),
    });
    expect(r.status).toBe("valid");
    expect(r.barCount).toBe(8);
    expect(r.expectedBarCount).toBe(8);
    expect(r.coveragePct).toBe(100);
    expect(r.missingBarCount).toBe(0);
    expect(r.errors).toHaveLength(0);
  });

  it("missing candle → warning status, missing counted, coverage reduced", () => {
    const r = buildQualityReport({
      symbol: "FIX-MISSING",
      timeframe: "5m",
      candles: rows("missing-candle"),
      calendar: alwaysOpen(),
    });
    expect(r.status).toBe("valid_with_warnings");
    expect(r.missingBarCount).toBe(1);
    expect(r.expectedBarCount).toBe(8);
    expect(r.coveragePct).toBe(88); // round(7/8 × 100)
    expect(r.gaps[0].kind).toBe("unexpected");
  });

  it("duplicate candle → invalid", () => {
    const r = buildQualityReport({
      symbol: "FIX-DUP",
      timeframe: "5m",
      candles: rows("duplicate-candle"),
      calendar: alwaysOpen(),
    });
    expect(r.status).toBe("invalid");
    expect(r.duplicateCount).toBe(1);
  });

  it("invalid OHLC → invalid, bar excluded", () => {
    const r = buildQualityReport({
      symbol: "FIX-BADOHLC",
      timeframe: "5m",
      candles: rows("invalid-ohlc"),
      calendar: alwaysOpen(),
    });
    expect(r.status).toBe("invalid");
    expect(r.invalidBarCount).toBe(1);
  });

  it("weekend gap under weekday calendar stays valid (info only)", () => {
    const r = buildQualityReport({
      symbol: "FIX-WEEKEND",
      timeframe: "5m",
      candles: rows("weekend-gap"),
      calendar: weekdayUtc(),
    });
    expect(r.status).toBe("valid");
    expect(r.gaps[0].kind).toBe("expected");
    expect(r.gaps[0].missingBars).toBe(576);
  });

  it("empty dataset is valid with zero counts", () => {
    const r = buildQualityReport({
      symbol: "FIX-EMPTY",
      timeframe: "5m",
      candles: [],
      calendar: alwaysOpen(),
    });
    expect(r.status).toBe("valid");
    expect(r.barCount).toBe(0);
    expect(r.startTimestamp).toBeUndefined();
    expect(r.expectedBarCount).toBeUndefined();
    expect(r.coveragePct).toBeUndefined();
  });

  it("expectedBarCount is undefined for calendars that cannot count", () => {
    const r = buildQualityReport({
      symbol: "X",
      timeframe: "5m",
      candles: [bar(0), bar(1)],
      calendar: weekdayUtc(),
    });
    expect(r.expectedBarCount).toBeUndefined();
    expect(r.coveragePct).toBeUndefined();
  });
});
