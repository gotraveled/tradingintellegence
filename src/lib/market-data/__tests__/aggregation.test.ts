import { describe, expect, it } from "vitest";
import { aggregateCandles, aggregateSeries } from "../aggregation";
import { normalizeCandles } from "../normalize";
import { FIXTURE_EPOCH as E, FIXTURES } from "../fixtures";

const M5 = 300_000;
const M15 = 900_000;
const rows = (name: string) =>
  normalizeCandles(FIXTURES.find((f) => f.name === name)!.rows).candles;

describe("aggregateCandles", () => {
  it("rolls 12×5m into 4×15m with exact rollup semantics", () => {
    const { candles, droppedWindows } = aggregateCandles(rows("agg-5m-12"), "5m", "15m");
    expect(droppedWindows).toBe(0);
    expect(candles).toHaveLength(4);
    // Window 0 covers bars 0..2 (open=100/101/102, high=102/103/104, low=99/100/101, close=…/102).
    expect(candles[0]).toMatchObject({
      time: E,
      open: 100, // first open
      high: 104, // max high
      low: 99, // min low
      close: 103, // last close
      volume: 3003, // 1000+1001+1002
    });
    expect(candles[3].time).toBe(E + 3 * M15);
  });

  it("drops a trailing incomplete window by default", () => {
    const source = rows("agg-5m-12").slice(0, 13); // 13th bar opens a 5th partial window
    expect(source).toHaveLength(12); // fixture has exactly 12
    const withExtra = [...source, { ...source[11], time: E + 12 * M5, volume: 9999 }];
    const { candles, droppedWindows } = aggregateCandles(withExtra, "5m", "15m");
    expect(candles).toHaveLength(4);
    expect(droppedWindows).toBe(1);
  });

  it("emits the partial window only when explicitly allowed", () => {
    const source = rows("agg-5m-12");
    const withExtra = [...source, { ...source[11], time: E + 12 * M5, volume: 9999 }];
    const { candles } = aggregateCandles(withExtra, "5m", "15m", { allowPartial: true });
    expect(candles).toHaveLength(5);
    expect(candles[4].open).toBe(111);
    expect(candles[4].volume).toBe(9999);
  });

  it("omits volume when any source bar lacks it — never a partial sum", () => {
    const source = rows("agg-5m-12").map((c, i) => (i === 0 ? { ...c, volume: undefined } : c));
    const { candles } = aggregateCandles(source, "5m", "15m");
    expect(candles[0].volume).toBeUndefined();
    expect(candles[1].volume).toBeDefined();
  });

  it("rejects non-divisible conversions", () => {
    const r = aggregateCandles(rows("agg-5m-12"), "3m", "5m");
    expect(r.candles).toHaveLength(0);
    const r2 = aggregateCandles(rows("agg-5m-12"), "5m", "1M");
    expect(r2.candles).toHaveLength(0);
  });

  it("aggregateSeries preserves series identity and retags timeframe", () => {
    const series = { symbol: "FIX-AGG5M", timeframe: "5m" as const, candles: rows("agg-5m-12") };
    const out = aggregateSeries(series, "1h");
    expect(out.timeframe).toBe("1h");
    expect(out.symbol).toBe("FIX-AGG5M");
    expect(out.candles).toHaveLength(1);
    expect(out.candles[0].high).toBe(113);
    expect(out.candles[0].volume).toBe(12066); // Σ 1000..1011
  });
});
