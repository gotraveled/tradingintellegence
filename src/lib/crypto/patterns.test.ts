import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { candlePatterns, patternConfirmations } from "./patterns";

function candle(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

const flat = (t: number) => candle(t, 100, 100.4, 99.6, 100.1);

function tape(...tail: Candle[]): Candle[] {
  const cs: Candle[] = [];
  for (let i = 0; i < 12; i += 1) cs.push(flat(i * 60_000));
  return [...cs, ...tail];
}

describe("candlePatterns", () => {
  it("reads a hammer as bullish", () => {
    const t = tape(candle(0, 100.2, 100.6, 95.5, 100.3));
    expect(candlePatterns(t).some((h) => h.name === "Hammer" && h.direction === "bullish")).toBe(true);
  });

  it("reads a shooting star as bearish", () => {
    const t = tape(candle(0, 100.2, 105.5, 99.8, 100.1));
    expect(candlePatterns(t).some((h) => h.name === "Shooting star")).toBe(true);
  });

  it("reads bullish and bearish engulfing", () => {
    const bull = tape(
      candle(0, 100.3, 100.5, 99.4, 99.5),
      candle(1, 99.4, 101.2, 99.3, 100.9),
    );
    expect(candlePatterns(bull).some((h) => h.name === "Bullish engulfing")).toBe(true);
    const bear = tape(
      candle(0, 99.5, 100.6, 99.4, 100.4),
      candle(1, 100.5, 100.6, 98.8, 99.1),
    );
    expect(candlePatterns(bear).some((h) => h.name === "Bearish engulfing")).toBe(true);
  });

  it("reads a morning star as bullish", () => {
    const t = tape(
      candle(0, 100.6, 100.8, 99, 99.4),
      candle(1, 99.4, 99.6, 99.1, 99.5),
      candle(2, 99.5, 101, 99.4, 100.4),
    );
    expect(candlePatterns(t).some((h) => h.name === "Morning star" && h.direction === "bullish")).toBe(
      true,
    );
  });

  it("reads a W bottom only after the neckline breaks", () => {
    // Two lows at ~95 separated by ≥3 bars, last close above the neck ~99.
    const cs: Candle[] = [];
    for (let i = 0; i < 14; i += 1) cs.push(flat(i * 60_000));
    cs[2] = candle(2 * 60_000, 97, 97.4, 95, 96.8); // first low 95
    cs[4] = candle(4 * 60_000, 98.5, 99.5, 98.2, 98.9); // neck high ~99.5
    cs[8] = candle(8 * 60_000, 97.2, 97.4, 95.05, 96.9); // second low 95.05
    cs[13] = candle(13 * 60_000, 100, 101.5, 99.8, 101); // LAST bar closes over the ~100.4 neck
    const hits = candlePatterns(cs).filter((h) => h.name === "W bottom");
    expect(hits.length).toBe(1);
    expect(hits[0].weight).toBe(2);
  });

  it("counts agreeing patterns by weight for the proposed side", () => {
    const t = tape(
      candle(0, 100.3, 100.5, 99.4, 99.5), // red
      candle(1, 99.4, 100.6, 97.0, 100.5), // engulfs (close>prev.open) AND hammers (wick 2.4 ≥ 2×1.1)
    );
    const c = patternConfirmations(t, "bullish");
    expect(c.score).toBeGreaterThanOrEqual(2);
    expect(c.names).toContain("Bullish engulfing");
    // Bearish side gets nothing.
    expect(patternConfirmations(t, "bearish").score).toBe(0);
  });
});
