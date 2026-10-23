import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { majorLevels, srTrendSignal } from "./srtrend";

let t = 1_700_000_000_000;
function bar(o: number, h: number, l: number, c: number): Candle {
  const out: Candle = { time: t, open: o, high: h, low: l, close: c, volume: 1000 };
  t += 300_000;
  return out;
}
/** Close-path → candles; optional low/high overrides place exact pivots/tags. */
function tape(
  closes: number[],
  lows: Record<number, number> = {},
  highs: Record<number, number> = {},
): Candle[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return bar(
      o,
      highs[i] ?? Math.max(o, c) + 0.25,
      lows[i] ?? Math.min(o, c) - 0.25,
      c,
    );
  });
}

/** Uptrend: rise, two equal dips (support ~104.8), two peaks (~107 resistance), final tag+hold. */
function bullishTape(): Candle[] {
  const closes: number[] = [];
  for (let i = 0; i < 25; i += 1) closes.push(100 + ((i % 3) - 1) * 0.1);
  for (let i = 25; i < 45; i += 1) closes.push(100 + (i - 24) * 0.3); // → ~106
  closes.push(106.6, 106.2, 105.7, 105.4, 105.0, 104.8); // dip to support #1 (i 45-50)
  closes.push(105.3, 105.8, 106.3, 106.6, 107.0); // peak (i 51-55)
  closes.push(106.4, 106.0, 105.6, 105.2); // fade (i 56-59)
  closes.push(105.6, 105.2, 104.9, 105.4, 105.9); // dip to support #2 (i 60-64)
  closes.push(106.3, 106.7, 107.0, 106.5, 106.1); // peak #2 (i 65-69)
  for (let i = 70; i < 116; i += 1) closes.push(105.8 + Math.sin(i * 0.9) * 0.5); // chop
  closes.push(105.2, 105.0, 105.4, 105.6); // tag the level, hold (i 116-119)
  const lows: Record<number, number> = { 50: 104.6, 62: 104.6, 85: 104.6, 116: 104.9, 117: 104.85 };
  const highs: Record<number, number> = { 55: 107.1, 67: 107.1, 90: 107.1 };
  return tape(closes, lows, highs);
}

/** Mirror-image downtrend: fall, two equal rallies (resistance ~95.2), final tag+reject. */
function bearishTape(): Candle[] {
  const closes: number[] = [];
  for (let i = 0; i < 25; i += 1) closes.push(100 + ((i % 3) - 1) * 0.1);
  for (let i = 25; i < 45; i += 1) closes.push(100 - (i - 24) * 0.3); // → ~94
  closes.push(93.4, 93.8, 94.3, 94.6, 95.0, 95.2); // rally to resistance #1
  closes.push(94.7, 94.2, 93.7, 93.4, 93.0); // trough
  closes.push(93.6, 93.9, 94.4, 94.8, 95.1); // rally to resistance #2
  closes.push(94.6, 94.1, 93.7);
  for (let i = 68; i < 116; i += 1) closes.push(94.2 + Math.sin(i * 0.9) * 0.5); // chop
  closes.push(94.8, 95.0, 94.6, 94.4); // tag resistance, reject
  const highs: Record<number, number> = { 50: 95.4, 62: 95.4, 85: 95.4, 116: 95.1, 117: 95.15 };
  const lows: Record<number, number> = { 55: 92.9, 67: 92.9, 95: 92.9 };
  return tape(closes, lows, highs);
}

describe("majorLevels", () => {
  it("finds the swing support and resistance levels", () => {
    const levels = majorLevels(bullishTape());
    const support = levels.find((l) => l.kind === "support");
    const resistance = levels.find((l) => l.kind === "resistance");
    expect(support?.price).toBeGreaterThan(104.4);
    expect(support?.price).toBeLessThan(105.1);
    expect(support?.touches ?? 0).toBeGreaterThanOrEqual(1);
    expect(resistance?.price).toBeGreaterThan(106.5);
  });

  it("marks a single-touch spike as a level", () => {
    const flat = tape(Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i) * 0.3));
    flat[60] = bar(100, 103, 99.5, 100.2); // single spike — a level all the same
    const levels = majorLevels(flat);
    expect(levels.some((l) => Math.abs(l.price - 103) <= 0.5 && l.touches === 1)).toBe(true);
  });
});

describe("srTrendSignal", () => {
  it("buys a held support inside an uptrend — level-to-level plan", () => {
    const sig = srTrendSignal(bullishTape());
    expect(sig?.direction).toBe("bullish");
    expect(sig?.entry).toBeCloseTo(105.6, 1);
    expect(sig?.stopLoss ?? 0).toBeLessThan(105); // beyond the level
    expect((sig?.targets[0]?.price ?? 0) > (sig?.entry ?? 0)).toBe(true); // next resistance
    expect(sig?.riskReward ?? 0).toBeGreaterThanOrEqual(1.2);
    expect(sig?.reasons.join(" ")).toMatch(/Support/);
  });

  it("sells a held resistance inside a downtrend — mirror", () => {
    const sig = srTrendSignal(bearishTape());
    expect(sig?.direction).toBe("bearish");
    expect(sig?.stopLoss ?? 0).toBeGreaterThan(sig?.entry ?? 0); // stop above level
    expect((sig?.targets[0]?.price ?? Infinity) < (sig?.entry ?? 0)).toBe(true);
  });

  it("trades a tagged level even in a trendless tape — no trend filter", () => {
    // Oscillating box: two dips at ~98 (major support), peaks ~102, and the
    // last bars tag the level and close back above it.
    const closes: number[] = [];
    for (let i = 0; i < 116; i += 1) closes.push(100 + Math.sin(i * 0.4) * 0.8);
    closes.push(98.9, 99.0, 99.4, 99.6); // tag + hold
    const lows: Record<number, number> = { 40: 98.0, 60: 98.0, 80: 98.0, 116: 98.1, 117: 98.05 };
    const highs: Record<number, number> = { 20: 102.0, 60: 102.0, 90: 102.0 };
    const sig = srTrendSignal(tape(closes, lows, highs));
    expect(sig?.direction).toBe("bullish");
    expect(sig?.stopLoss ?? 0).toBeLessThan(98.2); // beyond the level
  });

  it("does nothing when no major level is being tagged", () => {
    // pure monotonic rise — no swing levels at all
    const rise = tape(Array.from({ length: 120 }, (_, i) => 100 + i * 0.2));
    expect(srTrendSignal(rise)).toBeUndefined();
  });

  it("sells a support BREAK — breakdown through a respected level", () => {
    // Same tape as the bounce case, but the last bars dump THROUGH support.
    const closes: number[] = [];
    for (let i = 0; i < 116; i += 1) closes.push(100 + Math.sin(i * 0.4) * 0.8);
    closes.push(99.5, 99.2, 98.9, 97.4); // decisive close under the 98 level
    const lows: Record<number, number> = { 40: 98.0, 60: 98.0, 80: 98.0, 116: 99.0 };
    const highs: Record<number, number> = { 20: 102.0, 60: 102.0, 90: 102.0, 116: 99.6 };
    const sig = srTrendSignal(tape(closes, lows, highs));
    expect(sig?.direction).toBe("bearish");
    expect(sig?.stopLoss ?? 0).toBeGreaterThan(sig?.entry ?? 0); // stop = reclaim side
    expect(sig?.reasons.join(" ")).toMatch(/broke|breakdown/i);
  });

  it("buys a resistance BREAK — breakout through a respected level", () => {
    const closes: number[] = [];
    for (let i = 0; i < 116; i += 1) closes.push(100 + Math.sin(i * 0.4) * 0.8);
    closes.push(100.8, 101.0, 101.2, 102.7); // decisive close over the 102 level
    const lows: Record<number, number> = { 40: 98.0, 60: 98.0, 80: 98.0 };
    const highs: Record<number, number> = { 20: 102.0, 60: 102.0, 90: 102.0, 116: 100.9 };
    const sig = srTrendSignal(tape(closes, lows, highs));
    expect(sig?.direction).toBe("bullish");
    expect(sig?.stopLoss ?? 0).toBeLessThan(sig?.entry ?? 0); // stop below broken level
    expect(sig?.reasons.join(" ")).toMatch(/broke|breakout/i);
  });

  it("scores a liquidity sweep — wick through support that closes back", () => {
    const closes: number[] = [];
    for (let i = 0; i < 116; i += 1) closes.push(100 + Math.sin(i * 0.4) * 0.8);
    closes.push(98.6, 98.4, 98.3, 98.7); // settle just above the 98 level
    // Wick plunges through the 98 level then closes back above it.
    const lows: Record<number, number> = { 40: 98.0, 60: 98.0, 80: 98.0, 117: 97.5 };
    const highs: Record<number, number> = { 20: 102.0, 60: 102.0, 90: 102.0 };
    const sig = srTrendSignal(tape(closes, lows, highs));
    expect(sig?.direction).toBe("bullish");
    expect(sig?.reasons.join(" ")).toMatch(/liquidity sweep/);
  });

  it("scores an untested zone — first touch since the level formed", () => {
    // Levels form early, then the tape drifts away and returns only now.
    const closes: number[] = [];
    for (let i = 0; i < 20; i += 1) closes.push(100 + ((i % 3) - 1) * 0.1);
    closes.push(99.0, 98.2, 98.4); // dip (support pivot ~98)
    for (let i = 23; i < 40; i += 1) closes.push(98.4 + (i - 22) * 0.02);
    closes.push(98.1, 98.2, 98.3); // second dip (support pivot #2 ~98)
    for (let i = 43; i < 116; i += 1) closes.push(99.2 + (i - 42) * 0.06); // drift up & away
    closes.push(99.0, 98.6, 98.4, 98.9); // FIRST return to ~98
    const lows: Record<number, number> = { 21: 98.0, 40: 98.0, 60: 98.0, 116: 98.5, 117: 98.2 };
    const highs: Record<number, number> = { 30: 103.0, 60: 103.0, 90: 103.0 };
    const sig = srTrendSignal(tape(closes, lows, highs));
    expect(sig?.direction).toBe("bullish");
    expect(sig?.reasons.join(" ")).toMatch(/untested/);
  });
});
