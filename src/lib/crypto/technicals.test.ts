import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { analyzeTechnicals } from "./technicals";

/**
 * Wrapper tests — the underlying engines have their own spec suites; here we
 * only assert the crypto plumbing: it runs on raw klines, never throws, and
 * surfaces detections in the distilled shape the dashboard renders.
 */
function candles(closes: number[], start = 1_000_000, step = 60_000): Candle[] {
  return closes.map((c, i) => ({
    time: start + i * step,
    open: closes[i - 1] ?? c,
    high: Math.max(c, closes[i - 1] ?? c) + 0.3,
    low: Math.min(c, closes[i - 1] ?? c) - 0.3,
    close: c,
  }));
}

function uptrend(n: number, from: number): number[] {
  return Array.from({ length: n }, (_, i) => from + i * 0.4);
}

describe("analyzeTechnicals — plumbing over the institutional engines", () => {
  it("refuses thin series", () => {
    expect(analyzeTechnicals(candles(uptrend(30, 100)), "X", "5m")).toBeUndefined();
  });

  it("returns a distilled context on an uptrend", () => {
    const ctx = analyzeTechnicals(candles(uptrend(120, 100)), "X", "5m");
    expect(ctx).toBeDefined();
    expect(["uptrend", "downtrend", "range", "transition"]).toContain(ctx!.trend);
    expect(Array.isArray(ctx!.sweeps)).toBe(true);
    expect(Array.isArray(ctx!.poolsAbove)).toBe(true);
    expect(Array.isArray(ctx!.poolsBelow)).toBe(true);
    expect(Array.isArray(ctx!.fvgs)).toBe(true);
    expect(ctx!.notes.length).toBeGreaterThan(0);
    if (ctx!.lastBreak !== undefined) {
      expect(["BOS", "CHOCH"]).toContain(ctx!.lastBreak.type);
    }
  });

  it("surfaces a nearby fair value gap after a displacement triplet", () => {
    // Base uptrend (atr ≈ 0.7), then a 3-bar bullish FVG ending at the close.
    const base = uptrend(100, 100); // last ≈ 139.6
    const a = base[base.length - 1]; // 139.6
    const series = [...base, a + 2.6, a + 3.4]; // mid body 2.6, then gap bar
    const cs = candles(series);
    // Carve the gap: last bar's low must sit above bar t-2's high.
    const last = cs[cs.length - 1];
    const t2 = cs[cs.length - 3];
    last.low = t2.high + 0.6; // bullish gap ~0.6 ≥ 0.15×atr
    last.close = last.low + 1.0; // close just above the gap → still "near"
    const ctx = analyzeTechnicals(cs, "X", "5m");
    expect(ctx).toBeDefined();
    expect(ctx!.fvgs.some((f) => f.direction === "bullish")).toBe(true);
  });

  it("does not report open pools as 'swept'", () => {
    const ctx = analyzeTechnicals(candles(uptrend(120, 100)), "X", "5m");
    for (const p of [...ctx!.poolsAbove, ...ctx!.poolsBelow]) {
      expect(["resting", "approaching"]).toContain(p.status);
    }
  });
});
