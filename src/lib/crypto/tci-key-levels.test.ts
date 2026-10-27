import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { tciKeySignal, findOrderBlocks } from "./tci-key-levels";
import { atr } from "./analysis";

let t = 1_700_000_000_000;
function bar(o: number, h: number, l: number, c: number): Candle {
  const out: Candle = { time: t, open: o, high: h, low: l, close: c, volume: 1000 };
  t += 300_000;
  return out;
}
function tape(
  closes: number[],
  lows: Record<number, number> = {},
  highs: Record<number, number> = {},
): Candle[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return bar(o, highs[i] ?? Math.max(o, c) + 0.05, lows[i] ?? Math.min(o, c) - 0.05, c);
  });
}

/** Build a bullish structure: rise, pullback to an OB, then BOS up. */
function bullishTciTape(): Candle[] {
  const closes: number[] = [];
  // Phase 1: chop (60 bars) — creates swing highs (~100.5) and lows (~99.5)
  for (let i = 0; i < 60; i += 1) closes.push(100 + Math.sin(i * 0.25) * 0.5);
  // Phase 2: down-candle (bullish OB) at i=60
  closes.push(99.5);
  // Phase 3: displacement — one big up bar
  closes.push(110);
  // Phase 4: pullback (10 bars down to 105) — swing high at 110 detectable
  for (let i = 0; i < 10; i += 1) closes.push(110 - (i + 1) * 0.5); // → 109.5, 109, ..., 105
  // Phase 5: recovery (10 bars up to 115) — HH! swing low at 105 detectable
  for (let i = 0; i < 10; i += 1) closes.push(105 + (i + 1) * 1.0); // → 106, 107, ..., 115
  // Phase 6: pullback to OB (last 3 bars — NOT detectable as swing, in recent window)
  closes.push(110, 105, 100.5, 100.2, 100.0, 100.1, 100.3);
  const lows: Record<number, number> = { 60: 99.2, 71: 104.5 };
  const highs: Record<number, number> = { 60: 99.7, 61: 110.5, 81: 115.5 };
  return tape(closes, lows, highs);
}

/** Build a bearish structure: fall, rally to an OB, then BOS down. */
function bearishTciTape(): Candle[] {
  const closes: number[] = [];
  // Phase 1: chop (60 bars)
  for (let i = 0; i < 60; i += 1) closes.push(100 + Math.sin(i * 0.25) * 0.5);
  // Up-candle (bearish OB) at i=60
  closes.push(100.5);
  // Displacement — one big down bar
  closes.push(90);
  // Pullback (10 bars up to 95) — swing low at 90 detectable
  for (let i = 0; i < 10; i += 1) closes.push(90 + (i + 1) * 0.5); // → 90.5, 91, ..., 95
  // Recovery down (10 bars to 85) — LL! swing high at 95 detectable
  for (let i = 0; i < 10; i += 1) closes.push(95 - (i + 1) * 1.0); // → 94, 93, ..., 85
  // Pullback to OB (last bars — NOT detectable as swing, in recent window)
  closes.push(90, 95, 99.8, 100.0, 100.2, 100.1, 99.9);
  const highs: Record<number, number> = { 60: 100.8, 71: 95.5 };
  const lows: Record<number, number> = { 60: 100.3, 61: 89.5, 81: 84.5 };
  return tape(closes, lows, highs);
}

describe("findOrderBlocks", () => {
  it("finds a bullish OB after a strong up-move", () => {
    const closes: number[] = [];
    for (let i = 0; i < 20; i += 1) closes.push(100);
    closes.push(99.5); // down candle at i=20
    for (let i = 21; i < 30; i += 1) closes.push(100 + (i - 20) * 2.0); // strong up: 102,104,106...
    const candles = tape(closes, { 20: 99.0 }, {});
    const w = atr(candles, 14) || 1;
    const obs = findOrderBlocks(candles, w);
    const bullObs = obs.filter((ob) => ob.kind === "bullish");
    expect(bullObs.length).toBeGreaterThan(0);
    expect(bullObs[0].idx).toBe(20);
  });
});

describe("tciKeySignal", () => {
  it("buys a bullish OB in a BOS-up structure", () => {
    const sig = tciKeySignal(bullishTciTape());
    expect(sig?.direction).toBe("bullish");
    expect(sig?.stopLoss ?? 0).toBeLessThan(sig?.entry ?? 0); // stop below OB
    expect((sig?.targets[0]?.price ?? 0) > (sig?.entry ?? 0)).toBe(true);
    expect(sig?.reasons.join(" ")).toMatch(/Order Block/i);
  });

  it("sells a bearish OB in a BOS-down structure", () => {
    const sig = tciKeySignal(bearishTciTape());
    expect(sig?.direction).toBe("bearish");
    expect(sig?.stopLoss ?? 0).toBeGreaterThan(sig?.entry ?? 0); // stop above OB
    expect((sig?.targets[0]?.price ?? Infinity) < (sig?.entry ?? 0)).toBe(true);
    expect(sig?.reasons.join(" ")).toMatch(/Order Block/i);
  });

  it("returns undefined with insufficient bars", () => {
    const short = tape(Array.from({ length: 30 }, (_, i) => 100 + i * 0.1));
    expect(tciKeySignal(short)).toBeUndefined();
  });

  it("returns undefined on a flat tape with no structure", () => {
    const flat = tape(Array.from({ length: 120 }, () => 100));
    expect(tciKeySignal(flat)).toBeUndefined();
  });
});
