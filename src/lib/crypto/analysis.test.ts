import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { analyzeCandles, __debugPivots } from "./analysis";

/**
 * Synthetic candles for engine tests — deterministic generators only; no
 * randomness so results are reproducible.
 */
function candle(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

/** Uptrend with unambiguous legs: rise → pullback → rally to new highs → shallow tail pullback so the last completed swing is a clear HH/HL. */
function uptrend(n = 120, start = 100): Candle[] {
  const out: Candle[] = [];
  let base = start;
  for (let i = 0; i < n; i += 1) {
    const phase = i / n;
    const drift =
      phase < 0.55 ? 0.7 + 0.3 * Math.sin(i / 4)
      : phase < 0.65 ? -1.2 // pullback leg → swing low
      : phase < 0.9 ? 1.1   // rally through the prior high
      : -0.4;               // shallow tail pullback → final pivot high
    const o = base;
    const c = base + drift;
    // Non-uniform wicks — uniform padding creates exact-tie highs/lows at leg
    // boundaries, which the strict pivot test (>= on all neighbors) rejects.
    const wick = 0.2 + (i % 4) * 0.07;
    out.push(candle(i * 60_000, o, Math.max(o, c) + wick, Math.min(o, c) - wick, c));
    base = c;
  }
  return out;
}

/** Flat range between ~[99, 101] — EMAs intertwine. */
function range(n = 120): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i += 1) {
    const mid = 100 + Math.sin(i / 3) * 0.8;
    out.push(candle(i * 60_000, mid - 0.1, mid + 0.4, mid - 0.4, mid + 0.1));
  }
  return out;
}

/**
 * Trend that dies into a tight flat — EMA50 still trails well below so the
 * EMA-spread test alone would call this "bullish". Only the efficiency
 * ratio recognises the last 20 bars as sideways chop.
 */
function deadAfterTrend(): Candle[] {
  const candles = uptrend(80, 100);
  const last = candles[candles.length - 1];
  const base = last.close;
  for (let i = 0; i < 25; i += 1) {
    const mid = base + Math.sin(i / 2) * 0.3; // ±0.3 rotation, zero travel
    candles.push(
      candle(last.time + (i + 1) * 60_000, mid - 0.05, mid + 0.15, mid - 0.15, mid + 0.05),
    );
  }
  return candles;
}

/** Pullback-into-demand pattern: uptrend, then dip to the prior swing low zone. */
function pullbackToDemand(): Candle[] {
  const candles = uptrend(90, 100);
  // Form a clear higher-low zone around the last 10 bars.
  const last = candles[candles.length - 1];
  const base = last.close;
  for (let i = 0; i < 12; i += 1) {
    const dip = i < 6 ? base - 2 - i * 0.4 : base - 2 - (12 - i) * 0.4;
    candles.push(
      candle(
        last.time + (i + 1) * 60_000,
        dip,
        dip + 0.5,
        dip - 0.5,
        dip + 0.2,
      ),
    );
  }
  return candles;
}

describe("analyzeCandles — deterministic signal engine", () => {
  it("refuses to analyse too few bars", () => {
    expect(analyzeCandles(uptrend(30))).toBeUndefined();
  });

  it("reads a persistent uptrend as bullish with intact zones", () => {
    const result = analyzeCandles(uptrend());
    expect(result).toBeDefined();
    const piv = __debugPivots(uptrend());
    expect(piv.length).toBeGreaterThanOrEqual(3); // pullback low + two swing highs
    expect(result!.trend.direction).toBe("bullish");
    expect(result!.structure.bullish).toBeGreaterThan(0);
    expect(result!.volatility.atr14).toBeGreaterThan(0);
  });

  it("flags a flat range as ranging — never invents a direction", () => {
    const result = analyzeCandles(range());
    expect(result).toBeDefined();
    expect(result!.trend.direction).toBe("ranging");
    expect(result!.signal.direction).toBe("wait");
    expect(result!.signal.entry).toBeUndefined();
  });

  it("vetoes sideways tape even when EMAs are still separated", () => {
    const result = analyzeCandles(deadAfterTrend());
    expect(result).toBeDefined();
    // Efficiency ratio is the sideways detector — EMA spread alone lies here.
    expect(result!.volatility.er20).toBeLessThan(0.3);
    expect(result!.trend.direction).toBe("ranging");
    expect(result!.signal.direction).toBe("wait");
  });

  it("emits entry/SL/TP only when confluence meets the bar — and RR ≥ 1", () => {
    const result = analyzeCandles(pullbackToDemand());
    expect(result).toBeDefined();
    const s = result!.signal;
    if (s.direction !== "wait") {
      // Whatever it decided, the plan must be internally consistent.
      expect(s.entry).toBeDefined();
      expect(s.stopLoss).toBeDefined();
      expect(s.targets.length).toBeGreaterThan(0);
      const risk = Math.abs(s.entry! - s.stopLoss!);
      expect(risk).toBeGreaterThan(0);
      expect(s.riskReward).toBeGreaterThanOrEqual(1);
      // Direction-consistent ordering.
      if (s.direction === "bullish") {
        expect(s.stopLoss!).toBeLessThan(s.entry!);
        expect(s.targets[0].price).toBeGreaterThan(s.entry!);
      } else {
        expect(s.stopLoss!).toBeGreaterThan(s.entry!);
        expect(s.targets[0].price).toBeLessThan(s.entry!);
      }
      expect(s.confidence).toBeGreaterThanOrEqual(80); // agreed>=4 of 5
    } else {
      // A wait can never show a full score — every veto is a scored factor.
      expect(s.confidence).toBeLessThanOrEqual(80);
    }
  });

  it("confluence score is a bounded factor count, not a win-rate", () => {
    const result = analyzeCandles(pullbackToDemand());
    expect(result!.signal.confidence).toBeGreaterThanOrEqual(0);
    expect(result!.signal.confidence).toBeLessThanOrEqual(100);
    expect(result!.signal.factors.length).toBe(5);
  });

  it("zones only contain unbroken levels — broken pivots are dropped", () => {
    // Strong move up that breaks every prior swing high → no stale supply.
    const candles = uptrend(120, 100);
    const result = analyzeCandles(candles);
    const lastClose = candles[candles.length - 1].close;
    for (const z of result!.zones) {
      if (z.kind === "supply") expect(z.lower).toBeGreaterThan(lastClose * 0.995);
      else expect(z.upper).toBeLessThan(lastClose * 1.005);
    }
  });
});
