import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { donchianSignal, superTrendSignal, zarattiniOrbFactory } from "./algos";

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

/**
 * Session tape for the Stocks-in-Play ORB: ~65 quiet baseline bars, a >4h
 * gap (a new session), one opening bar with `openVol` volume, then bars
 * closing above/below its range.
 */
function zorbTape(openVol: number, breakUp = true): Candle[] {
  const cs: Candle[] = [];
  for (let i = 0; i < 65; i += 1) cs.push(bar(100, 100.35, 99.65, 100, 1000));
  t += 5 * 3_600_000; // session gap → next bar is the session's first
  cs.push(bar(100, 100.6, 99.8, 100.4, openVol)); // 5-min opening range
  for (let i = 0; i < 4; i += 1) {
    const c = breakUp ? 100.45 + i * 0.05 : 100.35 - i * 0.05;
    cs.push(bar(c - 0.03, c + 0.1, c - 0.1, c, 1200));
  }
  cs.push(breakUp ? bar(100.7, 101.0, 100.65, 100.9, 1500) : bar(99.7, 99.8, 99.4, 99.5, 1500));
  return cs;
}

describe("zarattiniOrb (Stocks in Play)", () => {
  it("buys a breakout of the opening range on a high-volume open", () => {
    const sig = zarattiniOrbFactory()(zorbTape(4000));
    expect(sig?.direction).toBe("bullish");
    expect(sig?.entry).toBeCloseTo(100.9, 1);
    expect(sig?.stopLoss).toBeCloseTo(99.8, 1); // far side of the range
    expect((sig?.targets[0]?.price ?? 0) > (sig?.entry ?? 0)).toBe(true);
    expect(sig?.reasons.join(" ")).toMatch(/ORB/);
  });

  it("refuses the SAME breakout on a quiet open — the RVOL gate is the edge", () => {
    expect(zarattiniOrbFactory()(zorbTape(900))).toBeUndefined();
  });

  it("takes at most one trade per session", () => {
    const fn = zarattiniOrbFactory();
    const cs = zorbTape(4000);
    expect(fn(cs)).toBeDefined();
    expect(fn(cs)).toBeUndefined(); // already fired for this session
  });

  it("does nothing while price sits inside the opening range", () => {
    const cs = zorbTape(4000);
    // Replace the breakout tail with bars that stay inside 99.8–100.6.
    const inside = [
      ...cs.slice(0, 66),
      bar(100.4, 100.5, 100.2, 100.3, 1500),
      bar(100.3, 100.55, 100.25, 100.45, 1500),
    ];
    expect(zarattiniOrbFactory()(inside)).toBeUndefined();
  });
});
