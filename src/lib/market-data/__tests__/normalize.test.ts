import { describe, expect, it } from "vitest";
import { normalizeCandles, normalizeTimestamp } from "../normalize";

const E = Date.UTC(2024, 0, 1);

describe("normalizeTimestamp", () => {
  it("converts seconds epoch to ms", () => {
    expect(normalizeTimestamp(1_704_067_200)).toBe(E);
  });
  it("passes ms epoch through", () => {
    expect(normalizeTimestamp(E)).toBe(E);
  });
  it("parses ISO-8601 strings", () => {
    expect(normalizeTimestamp("2024-01-01T00:00:00Z")).toBe(E);
  });
  it("rejects garbage", () => {
    expect(normalizeTimestamp("not-a-date")).toBeUndefined();
    expect(normalizeTimestamp(undefined)).toBeUndefined();
    expect(normalizeTimestamp(NaN)).toBeUndefined();
  });
});

describe("normalizeCandles", () => {
  it("normalizes a full row including optional fields", () => {
    const { candles, rejected } = normalizeCandles([
      {
        time: E,
        open: "100",
        high: 101,
        low: 99,
        close: 100.5,
        volume: "1500",
        vwap: 100.2,
        tradeCount: 42,
        exchange: "TEST",
        session: "london",
      },
    ]);
    expect(rejected).toHaveLength(0);
    expect(candles[0]).toMatchObject({
      time: E,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1500,
      vwap: 100.2,
      tradeCount: 42,
      exchange: "TEST",
      sessionId: "london",
    });
  });

  it("omits optional fields rather than inventing them", () => {
    const { candles } = normalizeCandles([{ time: E, open: 1, high: 2, low: 0.5, close: 1.5 }]);
    expect(candles[0].volume).toBeUndefined();
    expect(candles[0].vwap).toBeUndefined();
    expect(candles[0].sessionId).toBeUndefined();
  });

  it("rejects rows missing required fields — never repairs", () => {
    const { candles, rejected, issues } = normalizeCandles([
      { time: E, open: 1, high: 2, close: 1.5 }, // missing low
      { open: 1, high: 2, low: 0.5, close: 1.5 }, // missing time
    ]);
    expect(candles).toHaveLength(0);
    expect(rejected).toHaveLength(2);
    expect(issues.every((i) => i.severity === "error")).toBe(true);
  });

  it("keeps good rows while rejecting bad ones", () => {
    const { candles, rejected } = normalizeCandles([
      { time: E, open: 1, high: 2, low: 0.5, close: 1.5 },
      { time: "bad", open: 1, high: 2, low: 0.5, close: 1.5 },
    ]);
    expect(candles).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].index).toBe(1);
  });
});
