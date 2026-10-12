import { describe, expect, it } from "vitest";
import type { Candle, SwingConfig } from "@/lib/types";
import { createSwingEngine, detectSwings, swingId, swingStateAt, wilderAtr } from "../swing";
import { FIXTURE_EPOCH as E } from "@/lib/market-data";

const M5 = 300_000;
const cfg = (over: Partial<SwingConfig> = {}): SwingConfig => ({
  leftBars: 2,
  rightBars: 2,
  atrLength: 3,
  minSignificanceAtr: 0.1,
  equalToleranceAtr: 0.05,
  mergeEqual: true,
  ...over,
});
const CFG = cfg();

/** Build candles from parallel arrays; defaults keep lows flat so only highs pivot. */
function mk(highs: number[], lows: number[] = highs.map(() => 9), closes?: number[]): Candle[] {
  return highs.map((h, i) => {
    const l = lows[i];
    const c = closes?.[i] ?? (h + l) / 2;
    return { time: E + i * M5, open: c, high: h, low: l, close: c };
  });
}

const run = (candles: Candle[], config = CFG) =>
  detectSwings(candles, "T", "5m", config, "v1").swings;
const engine = createSwingEngine();
const viaContract = (candles: Candle[], config = CFG) =>
  engine.detect({ series: { symbol: "T", timeframe: "5m", candles }, config });

describe("swing detection — core rules", () => {
  it("detects a confirmed swing high", () => {
    const swings = run(mk([10, 11, 15, 11, 10]));
    const high = swings.find((s) => s.kind === "high");
    expect(high).toMatchObject({
      kind: "high",
      price: 15,
      pivotIndex: 2,
      status: "confirmed",
      confirmedIndex: 4,
    });
  });

  it("detects a confirmed swing low", () => {
    const lows = [10, 9.5, 8, 9.5, 10];
    const swings = run(
      mk(
        lows.map(() => 12),
        lows,
      ),
    );
    const low = swings.find((s) => s.kind === "low");
    expect(low).toMatchObject({ kind: "low", price: 8, pivotIndex: 2, status: "confirmed" });
  });

  it("detects multiple alternating swings", () => {
    const swings = run(mk([10, 11, 15, 12, 11, 12, 16, 12], [9, 9, 10, 9, 8, 9, 10, 9]));
    expect(swings.filter((s) => s.kind === "high").length).toBeGreaterThanOrEqual(2);
    expect(swings.some((s) => s.kind === "low" && s.price === 8)).toBe(true);
  });

  it("merges equal highs within tolerance — equalCount, anchored at extreme", () => {
    // Two equal peaks separated beyond leftBars so both qualify as candidates.
    const tolConfig = cfg({ leftBars: 1, equalToleranceAtr: 0.06 });
    const swings = run(mk([10, 15, 10, 15.2, 10, 10]), tolConfig);
    const high = swings.find((s) => s.kind === "high");
    expect(high?.metadata?.equalCount).toBe(2);
    expect(high?.price).toBeCloseTo(15.2, 6); // anchored at the extreme (later bar)
    expect(high?.pivotIndex).toBe(3);
  });

  it("merges equal lows within tolerance", () => {
    const lows = [10, 8, 10, 7.9, 10, 10];
    const tolConfig = cfg({ leftBars: 1, equalToleranceAtr: 0.06 });
    const swings = run(
      mk(
        lows.map(() => 12),
        lows,
      ),
      tolConfig,
    );
    const low = swings.find((s) => s.kind === "low");
    expect(low?.metadata?.equalCount).toBe(2);
    expect(low?.price).toBeCloseTo(7.9, 6); // extreme low wins
  });

  it("rejects highs outside tolerance — only the extreme survives", () => {
    const swings = run(mk([10, 15, 10, 16, 10, 10]), cfg({ leftBars: 1 }));
    const highs = swings.filter((s) => s.kind === "high");
    expect(highs).toHaveLength(1);
    expect(highs[0].price).toBe(16);
    expect(highs[0].metadata?.equalCount).toBe(1);
  });

  it("marks unconfirmed pivots developing — never as confirmed", () => {
    // Pivot at index 4 of 6 bars: rightEnd = 6 > n-1 → developing.
    const swings = run(mk([10, 11, 12, 11, 15, 11]));
    const high = swings.find((s) => s.kind === "high" && s.price === 15);
    expect(high?.status).toBe("developing");
    expect(high?.confirmedIndex).toBeUndefined();
  });

  it("confirmation is delayed by exactly rightBars", () => {
    const candles = mk([10, 11, 15, 11, 10]);
    const swings = run(candles);
    const high = swings.find((s) => s.kind === "high")!;
    expect(high.confirmedIndex).toBe(high.pivotIndex! + CFG.rightBars);
  });

  it("invalidates on a close beyond the level — wicks don't count", () => {
    // Swing high 15 at index2; bar5 wicks to 15.4 (no invalidation), bar6 closes 16.
    const candles = mk(
      [10, 11, 15, 11, 10, 15.4, 12],
      [9, 9, 9, 9, 9, 9, 9],
      [10.5, 11, 12, 11, 10.5, 14, 16],
    );
    const swings = run(candles);
    const high = swings.find((s) => s.kind === "high" && s.price === 15);
    expect(high?.status).toBe("invalidated");
    expect(high?.invalidatedAt).toBeDefined();
    expect(high?.metadata?.invalidatedIndex).toBe(6);
  });

  it("produces no duplicate swing identities on repeated runs", () => {
    const candles = mk([10, 11, 15, 12, 11, 12, 16, 12], [9, 9, 10, 9, 8, 9, 10, 9]);
    const a = run(candles);
    const b = run(candles);
    const ids = a.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(b.map((s) => s.id));
  });

  it("flat market produces zero swings — significance gate rejects noise", () => {
    expect(run(mk([10, 10, 10, 10, 10, 10, 10]))).toHaveLength(0);
  });

  it("volatility-scaled threshold rejects sub-ATR pivots", () => {
    // Huge ATR relative to the 0.5-point bump → significance fails.
    const candles = mk([10, 30, 10, 10.5, 10, 10, 10], [9, 8, 9, 9.9, 9, 9, 9]);
    const swings = run(candles);
    expect(swings.filter((s) => s.price === 10.5)).toHaveLength(0);
  });

  it("insufficient candles → insufficient_data error, not fabricated output", () => {
    const res = viaContract(mk([10, 15]));
    expect(res.ok).toBe(false);
    expect(res.errors[0].code).toBe("insufficient_data");
  });

  it("invalid config → invalid_config error", () => {
    const res = viaContract(mk([10, 11, 15, 11, 10]), cfg({ leftBars: 0 }));
    expect(res.ok).toBe(false);
    expect(res.errors[0].code).toBe("invalid_config");
  });

  it("exact-tie equal highs anchor at the earliest bar", () => {
    const swings = run(mk([10, 15, 10, 15, 10, 10]), cfg({ leftBars: 1, equalToleranceAtr: 0.06 }));
    const high = swings.find((s) => s.kind === "high");
    expect(high?.metadata?.equalCount).toBe(2);
    expect(high?.price).toBe(15);
    expect(high?.pivotIndex).toBe(1); // ties → earliest
  });

  it("minSignificanceAtr ↑ ⇒ swing count ↓ (sensitivity)", () => {
    const candles = mk([10, 11, 15, 11, 10, 11, 15.4, 11, 10]);
    const loose = run(candles, cfg({ minSignificanceAtr: 0.05 }));
    const tight = run(candles, cfg({ minSignificanceAtr: 2 }));
    expect(tight.length).toBeLessThanOrEqual(loose.length);
    expect(tight).toHaveLength(0); // nothing clears 2×ATR in this series
  });

  it("every emitted swing satisfies its configured window relationship", () => {
    const candles = mk([10, 11, 15, 12, 11, 12, 16, 12], [9, 9, 10, 9, 8, 9, 10, 9]);
    const atr = wilderAtr(candles, CFG.atrLength);
    for (const s of run(candles)) {
      const p = s.pivotIndex!;
      const tol = CFG.equalToleranceAtr * atr[p]!;
      const extreme = (i: number) => (s.kind === "high" ? candles[i].high : candles[i].low);
      for (
        let i = Math.max(0, p - CFG.leftBars);
        i <= Math.min(candles.length - 1, p + CFG.rightBars);
        i += 1
      ) {
        if (i === p) continue;
        const d = s.kind === "high" ? extreme(i) - s.price : s.price - extreme(i);
        expect(d).toBeLessThanOrEqual(tol + 1e-9);
      }
    }
  });

  it("works across price scales without retuning (BTC-scale)", () => {
    const highs = [64000, 64500, 66000, 64500, 64000];
    const lows = highs.map((h) => h - 400);
    const swings = run(mk(highs, lows));
    expect(swings.find((s) => s.kind === "high")?.price).toBe(66000);
  });
});

describe("look-ahead safety (spec 18)", () => {
  const candles = mk([10, 11, 15, 11, 10]);

  it("a swing is never confirmed before pivot + rightBars", () => {
    for (const s of run(candles)) {
      if (s.status === "confirmed" || s.status === "invalidated") {
        expect(s.confirmedIndex!).toBeGreaterThanOrEqual(s.pivotIndex! + CFG.rightBars);
      }
    }
  });

  it("state(t < p+rightBars) never reports the swing confirmed", () => {
    for (let t = 0; t < candles.length - 1; t += 1) {
      const state = swingStateAt(candles, "T", "5m", CFG, "v1", t);
      const confirmed = state.filter((s) => s.status === "confirmed");
      expect(confirmed.every((s) => s.confirmedIndex! <= t)).toBe(true);
    }
  });

  it("truncating the series yields the identical confirmed prefix", () => {
    const full = run(candles);
    const key = (s: (typeof full)[number]) => `${s.pivotIndex}:${s.price}:${s.confirmedIndex}`;
    for (let t = 0; t < candles.length; t += 1) {
      const prefix = run(candles.slice(0, t + 1));
      const prefixConfirmed = prefix.filter(
        (s) => s.status === "confirmed" || s.status === "invalidated",
      );
      const expected = full.filter((s) => s.confirmedIndex !== undefined && s.confirmedIndex <= t);
      expect(prefixConfirmed.map(key).sort()).toEqual(expected.map(key).sort());
    }
  });

  it("deterministic ids encode symbol/timeframe/kind/pivot — no randomness", () => {
    const swings = run(candles);
    const high = swings.find((s) => s.kind === "high")!;
    expect(high.id).toBe(swingId("T", "5m", "high", candles[2].time));
    expect(high.id).toMatch(/^sw:T:5m:high:\d+$/);
  });
});

describe("EngineResult contract", () => {
  it("returns ok + meta with stage/version/bars/events/diagnostics", () => {
    const res = viaContract(mk([10, 11, 15, 11, 10]));
    expect(res.ok).toBe(true);
    expect(res.data!.length).toBeGreaterThan(0);
    expect(res.meta.stage).toBe("swing");
    expect(res.meta.paramsVersion).toBe("unversioned");
    expect(res.meta.barsConsumed).toEqual({ from: 0, to: 4 });
    expect(
      res.meta.events.every((e) => e.kind === "swing_confirmed" || e.kind === "swing_invalidated"),
    ).toBe(true);
    expect(res.meta.diagnostics?.candidates).toBeDefined();
  });
});

describe("ATR helper", () => {
  it("is causal — atr[i] never uses bars after i", () => {
    const candles = mk([10, 11, 15, 11, 10]);
    const atr = wilderAtr(candles, 3);
    expect(atr[0]).toBeUndefined();
    expect(atr.every((a, i) => i === 0 || a === undefined || a > 0)).toBe(true);
    // Truncating later bars must not change earlier ATR values.
    const atrTruncated = wilderAtr(candles.slice(0, 3), 3);
    expect(atrTruncated[2]).toBe(atr[2]);
  });
});
