import { describe, expect, it } from "vitest";
import type { Candle, StructureConfig, SwingPoint } from "@/lib/types";
import { analyzeStructure, createMarketStructureEngine, structureStateAt } from "../structure";
import { detectSwings, swingId } from "../swing";
import { FIXTURE_EPOCH as E } from "@/lib/market-data";

const M5 = 300_000;
const CFG: StructureConfig = {
  classifyToleranceAtr: 0.05,
  minBreakAtr: 0.1,
  failedBreakBars: 3,
  minSwingsForTrend: 3,
};

/** Synthetic confirmed swing — mirrors Phase 4A output shape. */
const sw = (
  kind: "high" | "low",
  price: number,
  pivot: number,
  confirmed: number,
  atr = 1,
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
  metadata: { atrAtPivot: atr, paramsVersion: "v1", equalCount: 1 },
});

/** Candles with controllable closes; highs/lows default to ±0.5 around close. */
const mk = (n: number, closes?: number[]): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = closes?.[i] ?? 10;
    return { time: E + i * M5, open: c, high: c + 0.5, low: c - 0.5, close: c };
  });

const run = (candles: Candle[], swings: SwingPoint[], cfg = CFG, upToIndex?: number) =>
  analyzeStructure(candles, swings, "T", "5m", cfg, "v1", upToIndex);

/** Clean uptrend: L(9)→H(15)→HL(10)→HH(16) confirming at bars 2,4,6,8 → uptrend at t=8. */
const upSwings = () => [
  sw("low", 9, 0, 2),
  sw("high", 15, 1, 4),
  sw("low", 10, 3, 6),
  sw("high", 16, 5, 8),
];
/** Clean downtrend: H(15)→L(9)→LH(14)→LL(8). */
const downSwings = () => [
  sw("high", 15, 0, 2),
  sw("low", 9, 1, 4),
  sw("high", 14, 3, 6),
  sw("low", 8, 5, 8),
];

describe("classification — HH/HL/LH/LL/EH/EL", () => {
  it("classifies HH and HL → uptrend", () => {
    const { structure, swings } = run(mk(10), upSwings());
    expect(structure.trend).toBe("uptrend");
    expect(swings.find((s) => s.price === 10)?.classification).toBe("HL");
    expect(swings.find((s) => s.price === 16)?.classification).toBe("HH");
  });

  it("classifies LH and LL → downtrend", () => {
    const { structure, swings } = run(mk(10), downSwings());
    expect(structure.trend).toBe("downtrend");
    expect(swings.find((s) => s.price === 14)?.classification).toBe("LH");
    expect(swings.find((s) => s.price === 8)?.classification).toBe("LL");
  });

  it("first swing of each kind has no classification", () => {
    const { swings } = run(mk(10), upSwings());
    expect(swings.find((s) => s.price === 9)?.classification).toBeUndefined();
    expect(swings.find((s) => s.price === 15)?.classification).toBeUndefined();
  });

  it("classifies EH within classifyToleranceAtr — never float equality", () => {
    const swings = [sw("high", 15, 0, 2), sw("high", 15.04, 1, 4), sw("low", 9, 2, 6)];
    const { swings: out } = run(mk(8), swings, { ...CFG, minSwingsForTrend: 1 });
    expect(out[1].classification).toBe("EH"); // tol = 0.05
  });

  it("classifies EL within tolerance", () => {
    const swings = [sw("low", 9, 0, 2), sw("low", 9.03, 1, 4), sw("high", 15, 2, 6)];
    const { swings: out } = run(mk(8), swings, { ...CFG, minSwingsForTrend: 1 });
    expect(out[1].classification).toBe("EL");
  });

  it("EH/EL dominant → range, not trend", () => {
    const swings = [
      sw("high", 15, 0, 2),
      sw("low", 9, 1, 4),
      sw("high", 15.02, 3, 6),
      sw("low", 9.01, 4, 8),
    ];
    const { structure } = run(mk(10), swings);
    expect(structure.trend).toBe("range");
  });

  it("skips invalidated swings in the comparison chain", () => {
    const invalidated: SwingPoint = {
      ...sw("high", 15, 0, 2),
      status: "invalidated",
      metadata: { atrAtPivot: 1, invalidatedIndex: 5 },
    };
    const swings = [invalidated, sw("high", 14, 3, 6), sw("high", 16, 4, 8), sw("low", 9, 5, 9)];
    const { swings: out } = run(mk(11), swings);
    // 15 invalidated at bar5 → chain tail removed. high@14 (conf 6) sees no previous high →
    // unclassified; high@16 (conf 8) compares vs the surviving 14 → HH.
    expect(out[2].classification).toBe("HH");
  });
});

describe("trend state + initial structure", () => {
  it("insufficient confirmed swings → transition, no events", () => {
    const { structure, breaks } = run(mk(10), upSwings().slice(0, 2));
    expect(structure.trend).toBe("transition");
    expect(breaks).toHaveLength(0);
  });

  it("no swings at all → transition, empty keyLevels", () => {
    const { structure } = run(mk(10), []);
    expect(structure.trend).toBe("transition");
    expect(structure.bias).toBe("neutral");
    expect(structure.keyLevels).toHaveLength(0);
  });

  it("mixed structure stays transition — never forced", () => {
    const swings = [
      sw("low", 9, 0, 2),
      sw("high", 15, 1, 4),
      sw("low", 10, 3, 6),
      sw("high", 14, 5, 8),
    ];
    const { structure } = run(mk(10), swings);
    expect(structure.trend).toBe("transition"); // HL + LH → mixed
  });

  it("exposes protected level + last extremes in keyLevels", () => {
    const { structure } = run(mk(10), upSwings());
    const labels = structure.keyLevels!.map((k) => k.label);
    expect(labels).toContain("protected");
    expect(structure.keyLevels!.find((k) => k.label === "protected")!.price).toBe(10);
    expect(labels).toEqual(expect.arrayContaining(["lastHigh", "lastLow"]));
  });
});

describe("BOS", () => {
  it("bullish BOS on close beyond the confirmed extreme", () => {
    const candles = mk(11, undefined);
    candles[9].close = 16.5; // close > 16 + 0.1×1
    candles[10].close = 16.2; // stays outside the failed-band (16 − 0.1)
    const { structure, breaks, events } = run(candles, upSwings());
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({
      type: "BOS",
      direction: "bullish",
      refPrice: 16,
      breakIndex: 9,
      confirmed: true,
    });
    expect(events[0].kind).toBe("structure_break");
    expect(events[0].metadata?.breakType).toBe("BOS");
    expect(structure.trend).toBe("uptrend"); // continuation — trend unchanged
  });

  it("bearish BOS mirrors on the low", () => {
    const candles = mk(11);
    candles[9].close = 7.5; // < 8 − 0.1
    const { breaks } = run(candles, downSwings());
    expect(breaks[0]).toMatchObject({
      type: "BOS",
      direction: "bearish",
      refPrice: 8,
      breakIndex: 9,
    });
  });

  it("wick beyond the level is an attempt — never a BOS", () => {
    const candles = mk(11);
    candles[9].high = 20;
    candles[9].close = 15; // wick through 16, close inside
    const { breaks } = run(candles, upSwings());
    expect(breaks).toHaveLength(0);
  });

  it("first qualifying close only — no duplicate BOS on follow-through", () => {
    const candles = mk(12);
    candles[9].close = 17;
    candles[10].close = 18;
    candles[11].close = 19;
    const { breaks } = run(candles, upSwings());
    expect(breaks).toHaveLength(1);
    expect(breaks[0].breakIndex).toBe(9);
  });

  it("a second BOS requires a NEW confirmed extreme", () => {
    const swings = [...upSwings(), sw("high", 17, 9, 11)];
    const candles = mk(14);
    candles[9].close = 16.5; // BOS on 16
    candles[12].close = 17.5; // BOS on 17
    const { breaks } = run(candles, swings);
    expect(breaks).toHaveLength(2);
    expect(breaks[1].refPrice).toBe(17);
  });

  it("exact level / exact margin boundary is not a break", () => {
    const candles = mk(11);
    candles[9].close = 16.1; // == 16 + 0.1 → strictly-greater required
    const { breaks } = run(candles, upSwings());
    expect(breaks).toHaveLength(0);
  });

  it("no BOS while transition — trend gate is enforced", () => {
    const candles = mk(10);
    candles[9].close = 20;
    const { breaks } = run(candles, upSwings().slice(0, 2)); // only 2 swings → transition
    expect(breaks).toHaveLength(0);
  });
});

describe("CHOCH", () => {
  it("bearish CHOCH — close through the protected HL → transition", () => {
    const candles = mk(11);
    candles[9].close = 9.5; // < protected 10 − 0.1
    const { structure, breaks, events } = run(candles, upSwings());
    expect(breaks[0]).toMatchObject({ type: "CHOCH", direction: "bearish", refPrice: 10 });
    expect(structure.trend).toBe("transition");
    expect(events[0].metadata?.structureBefore).toBe("uptrend");
    expect(events[0].metadata?.structureAfter).toBe("transition");
  });

  it("bullish CHOCH — close through the protected LH → transition", () => {
    const candles = mk(11);
    candles[9].close = 14.5; // > protected 14 + 0.1
    candles[10].close = 14.2; // stays outside the failed-band (14 − 0.1)
    const { structure, breaks } = run(candles, downSwings());
    expect(breaks[0]).toMatchObject({ type: "CHOCH", direction: "bullish", refPrice: 14 });
    expect(structure.trend).toBe("transition");
  });

  it("BOS ≠ CHOCH — trend-continuing vs counter-trend break", () => {
    // Same uptrend, two scenarios: break the high → BOS; break the HL → CHOCH.
    const up = mk(11);
    up[9].close = 16.5;
    const bos = run(up, upSwings()).breaks[0];
    const down = mk(11);
    down[9].close = 9.5;
    const choch = run(down, upSwings()).breaks[0];
    expect(bos.type).toBe("BOS");
    expect(bos.direction).toBe("bullish");
    expect(choch.type).toBe("CHOCH");
    expect(choch.direction).toBe("bearish");
  });

  it("CHOCH does not duplicate — one event per protected break", () => {
    const candles = mk(12);
    candles[9].close = 9.5;
    candles[10].close = 9;
    candles[11].close = 8.5;
    const { breaks } = run(candles, upSwings());
    expect(breaks.filter((b) => b.type === "CHOCH")).toHaveLength(1);
  });
});

describe("failed breaks", () => {
  it("close back inside within failedBreakBars → failed, trend → transition", () => {
    const candles = mk(13);
    candles[9].close = 16.5; // bullish BOS
    candles[10].close = 15; // back inside (15 < 16 − 0.1)
    const { breaks, events, structure } = run(candles, upSwings());
    expect(breaks[0].failed).toBe(true);
    expect(breaks[0].failedAt).toBeDefined();
    expect(events.some((e) => e.kind === "break_failed")).toBe(true);
    expect(structure.trend).toBe("transition");
  });

  it("failed CHOCH restores the prior trend", () => {
    const candles = mk(13);
    candles[9].close = 9.5; // bearish CHOCH → transition
    candles[10].close = 10.5; // back above protected (10.5 > 10 + 0.1)
    const { breaks, structure } = run(candles, upSwings());
    expect(breaks[0]).toMatchObject({ type: "CHOCH", failed: true });
    expect(structure.trend).toBe("uptrend"); // restored — the sequence is intact again
  });

  it("expired assessment window leaves the break standing", () => {
    const candles = mk(15);
    candles[9].close = 16.5; // BOS
    for (let i = 10; i <= 13; i += 1) candles[i].close = 16.2; // inside window, NOT back inside
    candles[14].close = 15; // back inside but > failedBreakBars(3) after break — stands
    const { breaks } = run(candles, upSwings());
    expect(breaks[0].failed).toBeUndefined();
  });
});

describe("look-ahead + replay (spec 18)", () => {
  it("no event references information after its confirmation bar", () => {
    const candles = mk(12);
    candles[9].close = 16.5;
    const { breaks, events } = run(candles, upSwings());
    for (const b of breaks) expect(b.breakIndex!).toBeLessThanOrEqual(11);
    for (const e of events) expect(e.atBar).toBeLessThanOrEqual(11);
  });

  it("state at t only uses swings confirmed by t", () => {
    const candles = mk(10);
    const early = structureStateAt(candles, upSwings(), "T", "5m", CFG, "v1", 5);
    // At bar5 only swings with confirmedIndex ≤ 5 exist (the two confirmed at 2 and 4).
    expect(early.trend).toBe("transition");
    expect(early.swings.every((s) => s.confirmedIndex! <= 5)).toBe(true);
  });

  it("incremental replay ≡ batch — prefix states match", () => {
    const candles = mk(12);
    candles[9].close = 16.5;
    candles[10].close = 9.4; // CHOCH after BOS
    const full = run(candles, upSwings());
    for (let t = 0; t < candles.length; t += 1) {
      const at = structureStateAt(candles, upSwings(), "T", "5m", CFG, "v1", t);
      const fullAtT = run(candles, upSwings(), CFG, t).structure;
      expect(at).toEqual(fullAtT);
    }
    expect(full.breaks.map((b) => b.type)).toEqual(["BOS", "CHOCH"]);
  });

  it("byte-identical output on repeat — deterministic events and ids", () => {
    const candles = mk(12);
    candles[9].close = 16.5;
    const a = run(candles, upSwings());
    const b = run(candles, upSwings());
    expect(JSON.stringify(a.breaks)).toBe(JSON.stringify(b.breaks));
    expect(a.breaks[0].id).toMatch(/^sb:T:5m:BOS:bullish:/);
    // Break ids unique; a break_failed event legitimately shares its break's refId.
    expect(new Set(a.breaks.map((b) => b.id)).size).toBe(a.breaks.length);
    const keys = a.events.map((e) => `${e.kind}:${e.refId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("integration — real Phase 4A output", () => {
  it("consumes detectSwings output directly (no recomputation)", () => {
    const highs = [10, 11, 15, 11, 10, 11, 16, 11, 10, 11];
    const lows = [9, 9, 10, 9, 8.5, 9, 10, 9, 9.2, 9];
    const candles = mk(10).map((c, i) => ({
      ...c,
      high: highs[i],
      low: lows[i],
      close: (highs[i] + lows[i]) / 2,
    }));
    const detected = detectSwings(
      candles,
      "T",
      "5m",
      {
        leftBars: 2,
        rightBars: 2,
        atrLength: 3,
        minSignificanceAtr: 0.1,
        equalToleranceAtr: 0.05,
        mergeEqual: true,
      },
      "v1",
    ).swings;
    const { structure, diagnostics } = run(candles, detected);
    expect(diagnostics.confirmedSwings).toBeGreaterThan(0);
    expect(["uptrend", "downtrend", "range", "transition"]).toContain(structure.trend);
  });

  it("multi-asset scale — structure works at BTC prices", () => {
    const btc = [
      sw("low", 59000, 0, 2, 500),
      sw("high", 65000, 1, 4, 500),
      sw("low", 60000, 3, 6, 500),
      sw("high", 66000, 5, 8, 500),
    ];
    // Realistic closes around the level — default closes would CHOCH the trend on the
    // confirmation bar itself (close < protected). Breaks only from the intended bar.
    const closes = Array(11).fill(64000);
    closes[9] = 67000; // > 66000 + 0.1×500 = 66050 → bullish BOS
    closes[10] = 66500; // outside the failed-band (66000 − 50)
    const candles = mk(11, closes);
    const { structure, breaks } = run(candles, btc);
    expect(structure.trend).toBe("uptrend");
    expect(breaks[0]).toMatchObject({ type: "BOS", direction: "bullish", refPrice: 66000 });
  });
});

describe("engine contract", () => {
  it("implements MarketStructureEngine → EngineResult<MarketStructure>", () => {
    const engine = createMarketStructureEngine();
    const res = engine.analyze({
      series: { symbol: "T", timeframe: "5m", candles: mk(11) },
      swings: upSwings(),
      config: CFG,
    });
    expect(res.ok).toBe(true);
    expect(res.data!.trend).toBe("uptrend");
    expect(res.meta.stage).toBe("structure");
    expect(res.meta.diagnostics?.bosCount).toBe(0);
  });

  it("invalid config → invalid_config, never throws", () => {
    const engine = createMarketStructureEngine();
    const res = engine.analyze({
      series: { symbol: "T", timeframe: "5m", candles: mk(5) },
      swings: [],
      config: { ...CFG, minSwingsForTrend: 0 },
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0].code).toBe("invalid_config");
  });
});
