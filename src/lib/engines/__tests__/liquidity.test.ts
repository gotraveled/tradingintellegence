import { describe, expect, it } from "vitest";
import type { Candle, LiquidityConfig, MarketStructure, SwingPoint } from "@/lib/types";
import { analyzeLiquidity, createLiquidityEngine, liquidityStateAt } from "../liquidity";
import { swingId } from "../swing";
import { FIXTURE_EPOCH as E } from "@/lib/market-data";

const M5 = 300_000;
const DAY = 86_400_000;

const CFG: LiquidityConfig = {
  equalToleranceAtr: 0.05,
  clusterMinCount: 3,
  clusterWidthAtr: 0.25,
  poolExpiryBars: 250,
  sweep: { minPenetrationAtr: 0.05, maxReclaimBars: 3, displacementBars: 3, displacementBodyAtr: 0.6, displacementRangeAtr: 1.2 },
  break: { minCloseAtr: 0.1, holdBars: 5, retestWindow: 10 },
};

/** Synthetic confirmed swing — mirrors Phase 4A output shape. */
const sw = (
  kind: "high" | "low",
  price: number,
  pivot: number,
  confirmed: number,
  atr = 1,
  equalCount = 1,
): SwingPoint => ({
  id: swingId("T", "5m", kind, E + pivot * M5),
  symbol: "T",
  timeframe: "5m",
  kind,
  price,
  pivotIndex: pivot,
  pivotAt: new Date(E + pivot * M5).toISOString(),
  confirmedIndex: confirmed,
  confirmedAt: new Date(E + confirmed * M5).toISOString(),
  status: "confirmed",
  metadata: { atrAtPivot: atr, paramsVersion: "v1", equalCount },
});

const ms = (swings: SwingPoint[]): MarketStructure => ({
  symbol: "T",
  timeframe: "5m",
  trend: "transition",
  bias: "neutral",
  swings,
  updatedAt: new Date(E).toISOString(),
});

/** Neutral candles (close=base, ±0.5 wicks) — safe against pools near 10/15. */
const mk = (n: number, base = 11): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    time: E + i * M5,
    open: base,
    high: base + 0.5,
    low: base - 0.5,
    close: base,
  }));

const setBar = (candles: Candle[], i: number, ohlc: Partial<Candle>) => {
  candles[i] = { ...candles[i], ...ohlc };
};

const run = (candles: Candle[], swings: SwingPoint[], cfg = CFG, upToIndex?: number) =>
  analyzeLiquidity(candles, ms(swings), "T", "5m", cfg, "v1", upToIndex);

describe("pool formation", () => {
  it("swing high → buy_side pool at the confirmation bar", () => {
    const { pools, events } = run(mk(6), [sw("high", 15, 0, 2)]);
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({ side: "buy_side", price: 15, status: "resting", touches: 1 });
    expect(pools[0].sources).toEqual(["swing_high"]);
    expect(events[0].kind).toBe("pool_formed");
    expect(events[0].atBar).toBe(2); // formed at the swing-confirmation bar, not the pivot
  });

  it("swing low → sell_side pool", () => {
    const { pools } = run(mk(6), [sw("low", 10, 0, 2)]);
    expect(pools[0]).toMatchObject({ side: "sell_side", price: 10 });
    expect(pools[0].sources).toEqual(["swing_low"]);
  });

  it("equal highs within tolerance → equal_highs source on ONE pool", () => {
    const { pools } = run(mk(8), [sw("high", 15, 0, 2), sw("high", 15.03, 1, 4)]);
    const buy = pools.filter((p) => p.side === "buy_side");
    expect(buy).toHaveLength(1); // one pool per level band
    expect(buy[0].sources).toEqual(expect.arrayContaining(["equal_highs", "swing_high"]));
    expect(buy[0].touches).toBeGreaterThanOrEqual(2);
  });

  it("merged swing with equalCount ≥ 2 → equal_highs source", () => {
    const { pools } = run(mk(6), [sw("high", 15, 0, 2, 1, 2)]);
    expect(pools[0].sources).toContain("equal_highs");
  });

  it("highs outside tolerance → separate pools, no equal source", () => {
    const { pools } = run(mk(8), [sw("high", 15, 0, 2), sw("high", 15.3, 1, 4)]);
    const buy = pools.filter((p) => p.side === "buy_side");
    expect(buy).toHaveLength(2);
    expect(buy.every((p) => p.sources.length === 1 && p.sources[0] === "swing_high")).toBe(true);
  });

  it("≥ clusterMinCount highs within clusterWidthAtr → cluster_high band pool", () => {
    const { pools } = run(mk(10), [
      sw("high", 15.0, 0, 2),
      sw("high", 15.1, 1, 4),
      sw("high", 15.2, 2, 6),
    ]);
    const buy = pools.filter((p) => p.side === "buy_side");
    expect(buy).toHaveLength(1); // cascade merge — one pool per band
    expect(buy[0].sources).toContain("cluster_high");
    expect(buy[0].lowerPrice).toBeCloseTo(15.0);
    expect(buy[0].upperPrice).toBeCloseTo(15.2);
    expect(buy[0].price).toBeCloseTo(15.1);
    expect(buy[0].touches).toBe(3);
  });

  it("equal lows within tolerance → equal_lows source (sell_side)", () => {
    const { pools } = run(mk(8), [sw("low", 10, 0, 2), sw("low", 10.03, 1, 4)]);
    const sell = pools.filter((p) => p.side === "sell_side");
    expect(sell).toHaveLength(1);
    expect(sell[0].sources).toEqual(expect.arrayContaining(["equal_lows", "swing_low"]));
  });

  it("≥ clusterMinCount lows → cluster_low band pool", () => {
    const { pools } = run(mk(10), [sw("low", 10.0, 0, 2), sw("low", 10.1, 1, 4), sw("low", 10.2, 2, 6)]);
    const sell = pools.filter((p) => p.side === "sell_side");
    expect(sell).toHaveLength(1);
    expect(sell[0].sources).toContain("cluster_low");
    expect(sell[0].lowerPrice).toBeCloseTo(10.0);
    expect(sell[0].upperPrice).toBeCloseTo(10.2);
  });

  it("separate clusters do NOT merge — distinct bands stay distinct", () => {
    const { pools } = run(mk(14), [
      sw("high", 15.0, 0, 2), sw("high", 15.1, 1, 4), sw("high", 15.2, 2, 6),
      sw("high", 17.0, 3, 8), sw("high", 17.1, 4, 10), sw("high", 17.2, 5, 12),
    ]);
    const buy = pools.filter((p) => p.side === "buy_side");
    expect(buy).toHaveLength(2);
    expect(buy.map((p) => p.price).sort()).toEqual([15.1, 17.1]);
  });

  it("repeated tests accumulate touches — pool does not re-form", () => {
    const { pools, events } = run(mk(10), [sw("high", 15, 0, 2), sw("high", 15.03, 1, 4)]);
    expect(pools.filter((p) => p.side === "buy_side")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "pool_formed")).toHaveLength(1); // formed once, merged once
    expect(pools[0].touches).toBeGreaterThanOrEqual(2);
  });

  it("below clusterMinCount → no cluster source", () => {
    const { pools } = run(mk(8), [sw("high", 15.0, 0, 2), sw("high", 15.1, 1, 4)]);
    expect(pools.every((p) => !p.sources.includes("cluster_high"))).toBe(true);
  });

  it("prev_day pools form at the UTC day boundary", () => {
    const candles = mk(6);
    candles[3].time += DAY;
    candles[4].time += DAY;
    candles[5].time += DAY;
    candles[0].high = 15;
    candles[1].high = 16;
    candles[2].high = 14;
    candles[0].low = 9;
    candles[1].low = 8;
    candles[2].low = 10;
    const { pools } = run(candles, []);
    expect(pools.find((p) => p.sources.includes("prev_day_high"))?.price).toBe(16);
    expect(pools.find((p) => p.sources.includes("prev_day_low"))?.price).toBe(8);
  });

  it("pool ids are deterministic — symbol/timeframe/side/level/formation", () => {
    const a = run(mk(6), [sw("high", 15, 0, 2)]);
    const b = run(mk(6), [sw("high", 15, 0, 2)]);
    expect(a.pools[0].id).toBe(b.pools[0].id);
    expect(a.pools[0].id).toMatch(/^liq:T:5m:buy_side:15:/);
  });

  it("strength reflects touches + sources, bounded 0–100", () => {
    const single = run(mk(6), [sw("high", 15, 0, 2)]).pools[0];
    const equal = run(mk(8), [sw("high", 15, 0, 2), sw("high", 15.03, 1, 4)]).pools[0];
    expect(equal.strength).toBeGreaterThan(single.strength);
    for (const s of [single.strength, equal.strength]) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });
});

describe("approach + expiry lifecycle", () => {
  it("bar within approachAtr of the level → approaching; moving away → resting", () => {
    const candles = mk(8);
    setBar(candles, 4, { high: 14.95, low: 10.5, close: 12 }); // buy pool 15: high in [14.9,15)
    setBar(candles, 5, { high: 14, low: 10.5, close: 12 });
    const at4 = liquidityStateAt(candles, ms([sw("high", 15, 0, 2)]), "T", "5m", CFG, "v1", 4);
    expect(at4[0].status).toBe("approaching");
    const { pools } = run(candles, [sw("high", 15, 0, 2)]);
    expect(pools[0].status).toBe("resting");
  });

  it("pool expires after poolExpiryBars untouched", () => {
    const cfg = { ...CFG, poolExpiryBars: 5 };
    const { pools } = run(mk(12), [sw("high", 15, 0, 2)], cfg);
    expect(pools[0].status).toBe("expired");
    expect(pools[0].expiredAt).toBeDefined();
  });
});

describe("sweeps", () => {
  it("textbook sell-side sweep — wick, reclaim, displacement → confirmed", () => {
    const candles = mk(14);
    setBar(candles, 9, { low: 9.9, close: 9.95 }); // penetration below 10 − 0.05, no reclaim
    setBar(candles, 10, { close: 10.3 }); // reclaim — closes back above 10
    setBar(candles, 11, { open: 10.3, high: 11.8, low: 10.2, close: 11.5 }); // displacement
    const { pools, events } = run(candles, [sw("low", 10, 0, 2)]);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("sweep_developing");
    expect(kinds).toContain("sweep_confirmed");
    expect(events.find((e) => e.kind === "sweep_developing")?.atBar).toBe(10);
    expect(events.find((e) => e.kind === "sweep_confirmed")?.atBar).toBe(11);
    expect(pools[0].status).toBe("swept");
    expect(pools[0].sweptAt).toBeDefined();
  });

  it("wick through with no reclaim → no sweep events", () => {
    const candles = mk(14);
    setBar(candles, 9, { low: 9.9, close: 9.95 });
    setBar(candles, 10, { close: 9.96 });
    setBar(candles, 11, { close: 9.97 });
    setBar(candles, 12, { close: 9.98 });
    setBar(candles, 13, { close: 10.3 }); // late reclaim — outside maxReclaimBars(3)
    const { events, pools } = run(candles, [sw("low", 10, 0, 2)]);
    expect(events.every((e) => e.kind !== "sweep_developing" && e.kind !== "sweep_confirmed")).toBe(true);
    expect(pools[0].status).not.toBe("swept");
  });

  it("close-through then reclaim inside maxReclaimBars → sweep wins, not false breakout", () => {
    const candles = mk(14);
    setBar(candles, 9, { low: 9.6, close: 9.7 }); // wick penetration + close beyond (break attempt)
    setBar(candles, 10, { close: 10.3 }); // reclaim within maxReclaimBars → sweep wins
    setBar(candles, 11, { open: 10.3, high: 11.8, low: 10.2, close: 11.5 });
    const { events } = run(candles, [sw("low", 10, 0, 2)]);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("break_attempt");
    expect(kinds).toContain("sweep_developing");
    expect(kinds).not.toContain("false_breakout");
  });

  it("reclaim without displacement within displacementBars → aborted, pool still swept", () => {
    const candles = mk(15);
    setBar(candles, 9, { low: 9.9, close: 9.95 });
    setBar(candles, 10, { close: 10.3 });
    // bars 11–14: ordinary — no displacement candle
    const { events, pools, diagnostics } = run(candles, [sw("low", 10, 0, 2)]);
    expect(events.some((e) => e.kind === "sweep_developing")).toBe(true);
    expect(events.some((e) => e.kind === "sweep_confirmed")).toBe(false);
    expect(diagnostics.abortedSweeps).toBe(1);
    expect(pools[0].status).toBe("swept");
    expect(pools[0].metadata?.sweepAborted).toBe(true);
  });

  it("buy-side sweep mirrors — wick above, close below, bearish displacement", () => {
    const candles = mk(14);
    setBar(candles, 9, { high: 15.2, close: 14.9 }); // penetration + same-bar reclaim
    setBar(candles, 10, { open: 14.9, high: 15.0, low: 13.5, close: 13.6 }); // bearish displacement
    const { events, pools } = run(candles, [sw("high", 15, 0, 2)]);
    expect(events.some((e) => e.kind === "sweep_developing")).toBe(true);
    expect(events.some((e) => e.kind === "sweep_confirmed")).toBe(true);
    expect(pools[0].status).toBe("swept");
  });

  it("sweep events carry side, level, extreme, bar refs and a deterministic id", () => {
    const candles = mk(14);
    setBar(candles, 9, { low: 9.8, close: 9.95 }); // wick extreme 9.8
    setBar(candles, 10, { close: 10.3 });
    setBar(candles, 11, { open: 10.3, high: 11.8, low: 10.2, close: 11.5 });
    const { events, pools } = run(candles, [sw("low", 10, 0, 2)]);
    const dev = events.find((e) => e.kind === "sweep_developing")!;
    expect(dev.metadata?.side).toBe("sell_side");
    expect(dev.metadata?.level).toBe(10);
    expect(dev.metadata?.extreme).toBe(9.8);
    expect(dev.metadata?.penetrationBar).toBe(9);
    expect(dev.metadata?.eventId).toBe(`${pools[0].id}:sweep:${candles[10].time}`);
    const conf = events.find((e) => e.kind === "sweep_confirmed")!;
    expect(conf.metadata?.eventId).toBe(`${pools[0].id}:sweep-confirmed:${candles[11].time}`);
    expect(conf.metadata?.extreme).toBe(9.8);
  });

  it("sweep of an equal-highs cluster targets the one merged pool", () => {
    const candles = mk(14);
    setBar(candles, 9, { high: 15.2, close: 14.9 }); // raid + same-bar reclaim
    setBar(candles, 10, { open: 14.9, high: 15.0, low: 13.5, close: 13.6 });
    const { pools, events } = run(candles, [sw("high", 15, 0, 2), sw("high", 15.03, 1, 4)]);
    expect(pools.filter((p) => p.side === "buy_side")).toHaveLength(1);
    const dev = events.find((e) => e.kind === "sweep_developing")!;
    expect(dev.refId).toBe(pools[0].id);
    expect(dev.metadata?.level).toBeCloseTo(15);
  });

  it("a confirmed sweep emits exactly once — no per-candle duplicates", () => {
    const candles = mk(14);
    setBar(candles, 9, { low: 9.9, close: 9.95 });
    setBar(candles, 10, { close: 10.3 });
    setBar(candles, 11, { open: 10.3, high: 11.8, low: 10.2, close: 11.5 });
    const { events } = run(candles, [sw("low", 10, 0, 2)]);
    expect(events.filter((e) => e.kind === "sweep_developing")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "sweep_confirmed")).toHaveLength(1);
    expect(new Set(events.map((e) => e.metadata?.eventId)).size).toBe(events.length);
  });

  it("unconfirmed/developing swings never enter a pool (invariant 1)", () => {
    const developing: SwingPoint = { ...sw("high", 15, 0, 3), status: "developing" };
    const superseded: SwingPoint = { ...sw("high", 16, 1, 4), status: "superseded" };
    const { pools } = run(mk(8), [developing, superseded]);
    expect(pools).toHaveLength(0);
  });

  it("liquidity events are distinct from structure events — same candle, no conflation", () => {
    // A candle can sweep a pool; structure events are emitted by the Structure engine,
    // never by this one — liquidity output contains no structure_break kind.
    const candles = mk(14);
    setBar(candles, 9, { low: 9.8, close: 9.95 });
    setBar(candles, 10, { close: 10.3 });
    const { events } = run(candles, [sw("low", 10, 0, 2)]);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("sweep_developing");
    expect(kinds).not.toContain("structure_break");
    expect(kinds).not.toContain("break_failed");
  });

  it("swept pool preserves its composition + level — history is never deleted", () => {
    const candles = mk(14);
    setBar(candles, 9, { low: 9.9, close: 9.95 });
    setBar(candles, 10, { close: 10.3 });
    const memberSwings = [sw("low", 10, 0, 2), sw("low", 10.02, 1, 4)]; // equal lows → 2 members
    const { pools } = run(candles, memberSwings);
    const p = pools.find((x) => x.side === "sell_side")!;
    expect(p.status).toBe("swept");
    expect(p.price).toBeCloseTo(10); // original level intact
    expect((p.metadata?.memberSwingIds as string).split(",")).toHaveLength(2);
    expect(typeof p.metadata?.freshnessBars).toBe("number"); // bar-based freshness, no wall-clock
  });
});

describe("break family", () => {
  it("break held for holdBars → breakout_success, pool broken", () => {
    const candles = mk(16);
    setBar(candles, 9, { low: 9.6, close: 9.7 }); // break_attempt (close < 10 − 0.1)
    for (let i = 10; i <= 14; i += 1) setBar(candles, i, { low: 9.0, close: 9.2 }); // stays beyond, no retest
    const { events, pools } = run(candles, [sw("low", 10, 0, 2)]);
    const success = events.find((e) => e.kind === "breakout_success");
    expect(success?.atBar).toBe(14);
    expect(success?.metadata?.mode).toBe("held");
    expect(pools[0].status).toBe("broken");
  });

  it("re-entry after the sweep window but inside holdBars → false_breakout", () => {
    const candles = mk(16);
    setBar(candles, 9, { low: 9.6, close: 9.7 }); // break
    for (let i = 10; i <= 12; i += 1) setBar(candles, i, { low: 9.0, close: 9.2 });
    setBar(candles, 13, { close: 10.3 }); // re-entry at breakBar+4 — too late for sweep, inside holdBars
    const { events, pools } = run(candles, [sw("low", 10, 0, 2)]);
    expect(events.some((e) => e.kind === "false_breakout")).toBe(true);
    expect(events.some((e) => e.kind === "breakout_success")).toBe(false);
    expect(pools[0].status).toBe("swept");
    expect(pools[0].metadata?.falseBroken).toBe(true);
  });

  it("retest that holds closes the break early — breakout_success via retest_hold", () => {
    const candles = mk(14);
    setBar(candles, 9, { low: 9.6, close: 9.7 }); // break below 10
    setBar(candles, 10, { open: 9.7, high: 10.0, low: 9.6, close: 9.8 }); // retest 10-band, holds below
    const { events } = run(candles, [sw("low", 10, 0, 2)]);
    const success = events.find((e) => e.kind === "breakout_success");
    expect(success?.atBar).toBe(10);
    expect(success?.metadata?.mode).toBe("retest_hold");
  });
});

describe("look-ahead + determinism", () => {
  it("pools only exist from swings confirmed by t — snapshot before confirmation is empty", () => {
    const candles = mk(10);
    const early = liquidityStateAt(candles, ms([sw("high", 15, 0, 5)]), "T", "5m", CFG, "v1", 3);
    expect(early).toHaveLength(0);
    const late = liquidityStateAt(candles, ms([sw("high", 15, 0, 5)]), "T", "5m", CFG, "v1", 5);
    expect(late).toHaveLength(1);
  });

  it("sweep events never appear before the reclaim close", () => {
    const candles = mk(14);
    setBar(candles, 9, { low: 9.9, close: 9.95 });
    setBar(candles, 10, { close: 10.3 });
    const { events } = run(candles, [sw("low", 10, 0, 2)]);
    const dev = events.find((e) => e.kind === "sweep_developing");
    expect(dev?.atBar).toBeGreaterThanOrEqual(10); // reclaim bar
  });

  it("truncated snapshots equal the full run up to t — replay-safe", () => {
    const candles = mk(14);
    setBar(candles, 9, { low: 9.9, close: 9.95 });
    setBar(candles, 10, { close: 10.3 });
    setBar(candles, 11, { open: 10.3, high: 11.8, low: 10.2, close: 11.5 });
    const full = run(candles, [sw("low", 10, 0, 2)]);
    for (let t = 0; t < candles.length; t += 1) {
      const part = run(candles, [sw("low", 10, 0, 2)], CFG, t);
      expect(part.events).toEqual(full.events.filter((e) => e.atBar <= t));
    }
  });

  it("byte-identical output on repeat — deterministic pools, ids, events", () => {
    const candles = mk(12);
    setBar(candles, 9, { low: 9.9, close: 9.95 });
    const a = run(candles, [sw("low", 10, 0, 2), sw("high", 15, 1, 4)]);
    const b = run(candles, [sw("low", 10, 0, 2), sw("high", 15, 1, 4)]);
    expect(JSON.stringify(a.pools)).toBe(JSON.stringify(b.pools));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(new Set(a.pools.map((p) => p.id)).size).toBe(a.pools.length);
  });
});

describe("engine contract + scale", () => {
  it("implements LiquidityEngine → EngineResult<{pools, events}>", () => {
    const engine = createLiquidityEngine();
    const res = engine.analyze({
      series: { symbol: "T", timeframe: "5m", candles: mk(8) },
      structure: ms([sw("high", 15, 0, 2)]),
      config: CFG,
    });
    expect(res.ok).toBe(true);
    expect(res.data!.pools).toHaveLength(1);
    expect(res.data!.events[0].kind).toBe("pool_formed");
    expect(res.meta.stage).toBe("liquidity");
  });

  it("invalid config → invalid_config, never throws", () => {
    const engine = createLiquidityEngine();
    const res = engine.analyze({
      series: { symbol: "T", timeframe: "5m", candles: mk(5) },
      structure: ms([]),
      config: { ...CFG, clusterMinCount: 0 },
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0].code).toBe("invalid_config");
  });

  it("multi-asset — sweep lifecycle works at BTC scale", () => {
    // base 64600: default lows 64100 (above sell pool 63980, outside approach band),
    // default highs 65100 (below buy pool 66000) — only intended bars interact.
    const candles = mk(14, 64600);
    const swings = [sw("low", 63980, 0, 2, 500), sw("high", 66000, 1, 4, 500)];
    // sell pool at 63980, atr 500 → pen 63955; bar9 low 63940 < 63955 ✓
    setBar(candles, 9, { low: 63940, close: 63970 });
    setBar(candles, 10, { close: 64020 });
    setBar(candles, 11, { open: 64020, high: 64800, low: 63950, close: 64700 }); // displacement (body 680 ≥ 300, range 850 ≥ 600)
    const { events, pools } = run(candles, swings);
    expect(events.some((e) => e.kind === "sweep_developing")).toBe(true);
    expect(events.some((e) => e.kind === "sweep_confirmed")).toBe(true);
    expect(pools.find((p) => p.side === "sell_side")?.status).toBe("swept");
  });
});
