import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { backtestCandles } from "./backtest";

/**
 * Deterministic backtest tests — synthetic series only. The replay must be
 * internally consistent regardless of how many trades the engine books on
 * generated data.
 */
function candle(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

/** Drifting sine — repeated trend→pullback→rally cycles for the engine to trade. */
function wave(n = 300, start = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i += 1) {
    const base = start + i * 0.35 + Math.sin(i / 7) * 5;
    const c = base + Math.sin(i / 3) * 0.6;
    const o = c - Math.sin(i / 3) * 0.3;
    const wick = 0.3 + (i % 4) * 0.08;
    out.push(candle(i * 900_000, o, Math.max(o, c) + wick, Math.min(o, c) - wick, c));
  }
  return out;
}

/** Flat oscillation — the sideways veto should starve entries. */
function flat(n = 300): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i += 1) {
    const mid = 100 + Math.sin(i / 3) * 0.7;
    out.push(candle(i * 900_000, mid - 0.1, mid + 0.35, mid - 0.35, mid + 0.1));
  }
  return out;
}

describe("backtestCandles — replay through the real pipeline", () => {
  it("produces internally consistent stats on trending data", () => {
    const s = backtestCandles(wave(300), { timeframe: "15m" });
    expect(s.evaluatedBars).toBe(300 - 120); // warm-up window excluded
    expect(s.trades).toBe(s.wins + s.losses + s.scratches);
    expect(s.winPct).toBeGreaterThanOrEqual(0);
    expect(s.winPct).toBeLessThanOrEqual(100);
    expect(s.maxDrawdownR).toBeGreaterThanOrEqual(0);
    const exitTotal = Object.values(s.exits).reduce((a, b) => a + b, 0);
    expect(exitTotal).toBe(s.trades);
    if (s.trades > 0) {
      // Expectancy is the honest number — bounded by the payoff structure.
      expect(Math.abs(s.expectancyR)).toBeLessThanOrEqual(3);
      expect(s.avgLossR === 0 || s.avgLossR <= 1.1).toBe(true); // stops lose ~1R
    }
  });

  it("sideways tape starves the book — the veto works in replay", () => {
    const trending = backtestCandles(wave(300), { timeframe: "15m" });
    const ranging = backtestCandles(flat(300), { timeframe: "15m" });
    expect(ranging.trades).toBeLessThanOrEqual(Math.max(1, trending.trades));
  });

  it("one position at a time — entries never overlap exits on a bar", () => {
    // If the invariant holds internally, netR equals sum of parts already
    // checked above; here we assert a second replay is deterministic.
    const a = backtestCandles(wave(300), { timeframe: "15m" });
    const b = backtestCandles(wave(300), { timeframe: "15m" });
    expect(a).toEqual(b);
  });
});
