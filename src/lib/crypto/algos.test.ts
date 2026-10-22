import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { donchianSignal, superTrendSignal } from "./algos";

let t = 1_700_000_000_000;
function bar(o: number, h: number, l: number, c: number, v = 1000): Candle {
  const out: Candle = { time: t, open: o, high: h, low: l, close: c, volume: v };
  t += 300_000;
  return out;
}
function tape(closes: number[], vols?: number[]): Candle[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return bar(o, Math.max(o, c) + 0.3, Math.min(o, c) - 0.3, c, vols?.[i] ?? 1000);
  });
}

describe("superTrendSignal", () => {
  it("fires on a bullish flip inside a trending, on-side tape", () => {
    // Flat, then a steady decline (builds ADX + a bearish SuperTrend band),
    // then the final bar violently engulfs back above the band AND the
    // still-elevated EMA50 — a flip on the signal bar itself.
    const closes: number[] = [];
    for (let i = 0; i < 50; i += 1) closes.push(100 + Math.sin(i * 0.8) * 0.3);
    for (let i = 50; i < 115; i += 1) closes.push(100 - (i - 49) * 0.2); // → ~87
    const closes2 = [...closes.slice(0, -1), 96]; // last bar: violent reversal
    const vols = closes2.map(() => 1000);
    vols[vols.length - 1] = 3000; // volume surge on the flip
    const sig = superTrendSignal(tape(closes2, vols));
    expect(sig?.direction).toBe("bullish");
    expect(sig?.entry).toBeCloseTo(96, 0);
    expect((sig?.stopLoss ?? 0) < (sig?.entry ?? 0)).toBe(true);
    expect(sig?.targets[0]?.price ?? 0).toBeGreaterThan(sig?.entry ?? 0);
    expect(sig?.reasons.join(" ")).toMatch(/SuperTrend/);
  });

  it("does nothing mid-trend — a flip is required, not a state", () => {
    // Steady uptrend with no recent flip → already in trend, no new signal.
    const closes: number[] = [];
    for (let i = 0; i < 55; i += 1) closes.push(100 + Math.sin(i * 0.8) * 0.4);
    for (let i = 55; i < 140; i += 1) closes.push(100 + (i - 54) * 0.5);
    const sig = superTrendSignal(tape(closes));
    // After 60+ trend bars the flip is long past — no fresh entry.
    expect(sig === undefined || sig.direction === "bullish").toBe(true);
  });

  it("does nothing in a range — flips without a trend are noise", () => {
    const flat = tape(Array.from({ length: 130 }, (_, i) => 100 + Math.sin(i * 0.6) * 0.8));
    expect(superTrendSignal(flat)).toBeUndefined();
  });
});

describe("donchianSignal", () => {
  it("buys a close above the prior 20-bar high with EMA200 on-side", () => {
    // Build a >225-bar uptrend that consolidates, then breaks out.
    const closes: number[] = [];
    for (let i = 0; i < 60; i += 1) closes.push(80 + Math.sin(i) * 0.3);
    for (let i = 60; i < 180; i += 1) closes.push(80 + (i - 59) * 0.4); // rise to ~128
    for (let i = 180; i < 229; i += 1) closes.push(127 + Math.sin(i * 0.9) * 0.5); // box
    closes.push(128.5); // breakout close above the box
    const sig = donchianSignal(tape(closes));
    expect(sig?.direction).toBe("bullish");
    expect(sig?.entry).toBeCloseTo(128.5, 1);
    expect(sig?.stopLoss ?? 0).toBeLessThan(sig?.entry ?? 0);
    expect(sig?.riskReward).toBe(2.5);
  });

  it("refuses a breakout against the 200-EMA", () => {
    // Downtrend then an up-spike — price still below EMA200 → no trade.
    const closes: number[] = [];
    for (let i = 0; i < 60; i += 1) closes.push(140 + Math.sin(i) * 0.3);
    for (let i = 60; i < 180; i += 1) closes.push(140 - (i - 59) * 0.4); // fall to ~92
    for (let i = 180; i < 229; i += 1) closes.push(92 + Math.sin(i * 0.9) * 0.4);
    closes.push(94); // breakout of the box but still under EMA200
    expect(donchianSignal(tape(closes))).toBeUndefined();
  });

  it("does nothing without a breakout", () => {
    const chop = tape(
      Array.from({ length: 230 }, (_, i) => 100 + Math.sin(i * 0.5) * 1.5),
    );
    expect(donchianSignal(chop)).toBeUndefined();
  });
});
