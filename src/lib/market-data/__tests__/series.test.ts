import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { CandleSeriesView } from "../series";
import { FIXTURE_EPOCH as E } from "../fixtures";

const M5 = 300_000;
const bar = (i: number): Candle => ({
  time: E + i * M5,
  open: 100 + i,
  high: 102 + i,
  low: 99 + i,
  close: 101 + i,
  volume: 1000 + i,
});
const view = () =>
  new CandleSeriesView({ symbol: "T", timeframe: "5m", candles: [bar(0), bar(1), bar(2), bar(3)] });

describe("CandleSeriesView", () => {
  it("exposes length/first/last/at", () => {
    const v = view();
    expect(v.length).toBe(4);
    expect(v.first?.time).toBe(E);
    expect(v.last?.time).toBe(E + 3 * M5);
    expect(v.at(2)?.close).toBe(103);
    expect(v.at(99)).toBeUndefined();
  });

  it("exposes column accessors", () => {
    const v = view();
    expect(v.timestamps()).toEqual([E, E + M5, E + 2 * M5, E + 3 * M5]);
    expect(v.opens()).toEqual([100, 101, 102, 103]);
    expect(v.closes()).toEqual([101, 102, 103, 104]);
    expect(v.highs()[0]).toBe(102);
    expect(v.lows()[0]).toBe(99);
    expect(v.volumes()).toEqual([1000, 1001, 1002, 1003]);
  });

  it("slice returns a new frozen view, not a shared array", () => {
    const v = view();
    const s = v.slice(1, 3);
    expect(s.length).toBe(2);
    expect(s.first?.time).toBe(E + M5);
    expect(Object.isFrozen(s.candles)).toBe(true);
  });

  it("freezes the backing array and every candle", () => {
    const v = view();
    expect(Object.isFrozen(v.candles)).toBe(true);
    expect(v.candles.every((c) => Object.isFrozen(c))).toBe(true);
  });

  it("mutation attempts throw — engines cannot alter history", () => {
    const v = view();
    expect(() => {
      (v.candles[0] as Candle).open = 999;
    }).toThrow(TypeError);
    expect(() => {
      (v.candles as Candle[]).push(bar(9));
    }).toThrow(TypeError);
  });
});
