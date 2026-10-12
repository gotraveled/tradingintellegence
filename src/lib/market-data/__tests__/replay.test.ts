import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { HistoricalReplay } from "../replay";
import { FIXTURE_EPOCH as E } from "../fixtures";

const M5 = 300_000;
const bar = (i: number): Candle => ({
  time: E + i * M5,
  open: 100 + i,
  high: 102 + i,
  low: 99 + i,
  close: 101 + i,
});
const series = {
  symbol: "T",
  timeframe: "5m" as const,
  candles: [bar(0), bar(1), bar(2), bar(3), bar(4)],
};

describe("HistoricalReplay", () => {
  it("context exposes only bars up to currentIndex", () => {
    const ctx = new HistoricalReplay(series).context(2);
    expect(ctx.currentIndex).toBe(2);
    expect(ctx.timestamp).toBe(E + 2 * M5);
    expect(ctx.currentBar).toEqual(bar(2));
    expect(ctx.visibleBars).toHaveLength(3);
    expect(ctx.visibleBars[2].time).toBe(E + 2 * M5);
    expect(ctx.remainingBars).toBe(2);
  });

  it("future bars are unreachable — no future data in the context object", () => {
    const ctx = new HistoricalReplay(series).context(0);
    const maxTime = Math.max(...ctx.visibleBars.map((c) => c.time));
    expect(maxTime).toBe(E); // bars 1..4 cannot appear anywhere
    expect(ctx.window(10)).toHaveLength(1);
  });

  it("window() returns only the permitted trailing history", () => {
    const ctx = new HistoricalReplay(series).context(3);
    expect(ctx.window(2).map((c) => c.time)).toEqual([E + 2 * M5, E + 3 * M5]);
    expect(ctx.window(99)).toHaveLength(4);
  });

  it("iterate honours start/end/step", () => {
    const replay = new HistoricalReplay(series, { startIndex: 1, endIndex: 3, step: 2 });
    const idx = [...replay.iterate()].map((c) => c.currentIndex);
    expect(idx).toEqual([1, 3]);
  });

  it("defaults to the full series, one bar per step", () => {
    const idx = [...new HistoricalReplay(series).iterate()].map((c) => c.currentIndex);
    expect(idx).toEqual([0, 1, 2, 3, 4]);
  });

  it("context objects are frozen — engines cannot mutate the view", () => {
    const ctx = new HistoricalReplay(series).context(1);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.visibleBars)).toBe(true);
    expect(() => {
      (ctx.visibleBars as Candle[]).push(bar(9));
    }).toThrow(TypeError);
  });

  it("rejects out-of-range indices loudly", () => {
    const replay = new HistoricalReplay(series);
    expect(() => replay.context(-1)).toThrow(RangeError);
    expect(() => replay.context(5)).toThrow(RangeError);
  });

  it("clamps iterate bounds into the valid range", () => {
    const replay = new HistoricalReplay(series, { startIndex: -5, endIndex: 99 });
    const idx = [...replay.iterate()].map((c) => c.currentIndex);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(4);
  });
});
