/**
 * Spec 33 — MTF Frame-Element Composition (docs/engine/33-mtf-frame-element-composition.md).
 *
 * Closes spec-10's "HTF elements consumed" surface: FrameSource.at supplies full
 * FrameSnapshots (structure/momentum/liquidity/zones/imbalances/events) through the
 * existing causal join, and the named consumers activate — Zone.htfAligned + spec-05
 * confluence, htfConflict, liquidityContext (scoring), htfProtected* (alignment).
 *
 * Composition-only: no producer algorithms change; everything is additive and
 * parity-preserving when no frames are supplied.
 */
import { describe, expect, it, vi } from "vitest";

// Each test runs full spec-26 engine pipelines — several seconds per case is normal.
// Scoped file-level timeout; the 5s default flakes under parallel worker contention.
vi.setConfig({ testTimeout: 30_000 });
import type {
  BacktestCell,
  Candle,
  CandleSeries,
  EngineConfig,
  LiquidityPool,
  MarketStructure,
  Setup,
  SystemBacktestResult,
  Timeframe,
  Zone,
  ZoneType,
} from "@/lib/types";
import { runBacktest } from "../backtest";
import { causalAlignAt, causalFramesAt, closedIndexAt, type FrameSnapshot, type FrameSource } from "../mtf";
import { detectSwings } from "../swing";
import { analyzeStructure, structureStateAt } from "../structure";
import { analyzeLiquidity, liquidityStateAt } from "../liquidity";
import { analyzeZones, zoneStateAt, type ZoneHtfProvider } from "../zones";
import { analyzeImbalances, imbalanceStateAt } from "../imbalances";
import { momentumStateAt } from "../momentum";
import { scoreOpportunity } from "../scoring";

const E = Date.UTC(2024, 0, 1);
const H1 = 3_600_000;
const M15 = 900_000;
const H4 = 4 * H1;
const bar = (i: number, o: number, h: number, l: number, c: number, base = E): Candle => ({
  time: base + i * H1, open: o, high: h, low: l, close: c, volume: 1000,
});

/** The spec-26/29/30/31/32 fixture cell — 1h reversal pattern (rise → crash → recovery). */
const mk = (base = E): Candle[] => {
  const c: Candle[] = [];
  const a: [number, number][] = [
    [100, 101], [101, 102], [102, 103], [103, 104], [104, 102.6],
    [102.7, 103.5], [103.5, 104.5], [104.5, 105.5], [105.5, 107], [107, 105.6],
    [105.7, 106.5], [106.5, 107.5], [107.5, 108.5], [108.5, 110], [110, 108.6],
    [108.7, 109.5], [109.5, 110.5], [110.5, 111.5], [111.5, 112.5], [112.5, 113],
    [113, 111.8], [111.9, 112.4], [112.4, 113], [113, 113.5], [113.5, 112.6],
    [112.7, 113], [113, 113.8], [113.8, 114.3], [114.3, 113.9], [113.9, 114.2],
  ];
  a.forEach(([o, cl], i) => c.push(bar(i, o, Math.max(o, cl) + 0.4, Math.min(o, cl) - 0.3, cl, base)));
  const b: [number, number][] = [
    [111.9, 110.2], [110.2, 108.5], [108.5, 107], [107, 106], [106, 105.9], [105.9, 107.5],
    [106.2, 105.5], [105.5, 104.3], [104.3, 102.8], [102.8, 101.3],
    [101.3, 95.8],
    [95.9, 96.3],
    [96.3, 96.0],
    [97.4, 95.6],
    [95.8, 96.4],
    [96.4, 95.9],
  ];
  b.forEach(([o, cl], i) => {
    if (30 + i === 43) c.push(bar(43, o, Math.max(o, cl) + 0.3, 94.8, cl, base));
    else c.push(bar(30 + i, o, Math.max(o, cl) + 0.3, Math.min(o, cl) - 0.5, cl, base));
  });
  const d: [number, number][] = [
    [95.9, 96.8], [96.8, 99], [99, 101.5], [101.5, 104], [104, 106.5], [106.5, 109],
    [109, 111], [111, 112.8], [112.8, 113], [113, 112.7],
  ];
  d.forEach(([o, cl], i) => c.push(bar(46 + i, o, Math.max(o, cl) + 0.2, Math.min(o, cl) - 0.2, cl, base)));
  const e: [number, number][] = [
    [112.7, 113.4], [113.4, 114.2], [114.2, 115], [115, 115.8], [115.8, 116.5],
    [116.5, 117.2], [117.2, 118], [118, 118.6], [118.6, 119], [119, 119.3],
  ];
  e.forEach(([o, cl], i) => {
    if (56 + i === 56) c.push(bar(56, o, Math.max(o, cl) + 0.2, 96.0, cl, base));
    else c.push(bar(56 + i, o, Math.max(o, cl) + 0.2, Math.min(o, cl) - 0.2, cl, base));
  });
  return c;
};

/** Steady one-directional `tf`-frame drift covering `hours` wall-clock hours. */
const drift = (tfMs: number, hours: number, start: number, dir: 1 | -1, base = E): Candle[] => {
  const n = Math.ceil((hours * H1) / tfMs);
  return Array.from({ length: n }, (_, i) => {
    const o = start + i * dir * 0.5;
    const c = o + dir * 0.45;
    return { time: base + i * tfMs, open: o, high: Math.max(o, c) + 0.1, low: Math.min(o, c) - 0.1, close: c, volume: 1000 };
  });
};

const CFG: EngineConfig = {
  version: "v1",
  marketData: { maxMissingBarPct: 0 },
  swing: { leftBars: 1, rightBars: 1, atrLength: 5, minSignificanceAtr: 0.1, equalToleranceAtr: 0.15, mergeEqual: true },
  structure: { classifyToleranceAtr: 0.15, minBreakAtr: 0.05, failedBreakBars: 3, minSwingsForTrend: 2 },
  liquidity: {
    equalToleranceAtr: 0.2, clusterMinCount: 2, clusterWidthAtr: 0.3, poolExpiryBars: 500,
    sweep: { minPenetrationAtr: 0.05, maxReclaimBars: 4, displacementBars: 4, displacementBodyAtr: 0.4, displacementRangeAtr: 0.7 },
    break: { minCloseAtr: 0.2, holdBars: 2, retestWindow: 10 },
    range: { lookbackBars: 20 },
  },
  zone: {
    leg: { lookbackBars: 6, minMoveAtr: 0.5 },
    base: { minBars: 1, maxBars: 6, maxRangeAtr: 1.2, maxBodyAtr: 0.9 },
    departure: { minMoveAtr: 0.7, maxBars: 6, displacementBodyAtr: 0.4, displacementRangeAtr: 1.0 },
    retest: { depthMitigatedPct: 50, invalidateCloseAtr: 0.6, maxRetests: 4, retestDecay: 0.5, depthDecay: 0.3 },
    freshnessMaxBars: 400, boundaryMode: "extremes", gapInvalidates: false,
    weights: { departureStrength: 0.2, structureBreak: 0.15, liquidityInteraction: 0.15, freshness: 0.15, fvgAssociation: 0.1, htfConfluence: 0.1, volumeExpansion: 0.1, zoneWidth: 0.05 },
  },
  fvg: { minGapAtr: 0.05, minMidBodyAtr: 0.2, partialFillPct: 50, invalidateAtr: 0.5, expiryBars: 500, atrLength: 5 },
  momentum: {
    lookback: 10, atrLength: 5, trendShift: 5, vol: { fast: 3, slow: 8 },
    state: { strengthMoveAtr: 0.5, strengthBodyAtr: 0.5, weakenFactor: 0.6, biasMoveAtr: 0.3 },
    disp: { bars: 3, threshold: 50, weights: { body: 0.25, range: 0.2, close: 0.15, dir: 0.15, move: 0.15, vol: 0.05, struct: 0.05 } },
  },
  mtf: { set: { htf: "4h", itf: "1h", etf: "15m" }, weights: { htf: 0.5, itf: 0.3, etf: 0.2 } },
  lifecycle: { expiryBars: 200, invalidateAtr: 0.5 },
  reversal: { zoneMaxAgeBars: 300, zoneMinStrength: 0, sweepMaxAgeBars: 80, dispMinScore: 0, entryZoneDepth: 0.5, invalidateAtr: 0.5 },
  breakout: { rangeMinBars: 4, rangeMaxWidthAtr: 3, compressionRatio: 0.75, compressionBars: 4, breakAtr: 0.3, dispMinScore: 0, dispBars: 4, holdBars: 2, retestWindow: 10, volumeMinRatio: 0, anchorNearAtr: 0.8 },
  continuation: { minTrendSwings: 2, impulseMinAtr: 0.8, impulseMaxBars: 20, pullbackMinPct: 0.15, pullbackMaxPct: 0.95, pullbackMinBars: 2, recoveryBodyAtr: 0.3, confirmCloseAtr: 0.15 },
  scoring: { minRR: 0, weights: { structure: 20, liquidity: 15, zoneQuality: 15, displacement: 15, momentum: 15, htfAlignment: 10, freshness: 5, fvg: 5 }, regimeMatrix: {} },
  regime: { expandAtrTrend: 1.2, compressAtrTrend: 0.8, atrLength: 5, atrLookback: 10, minBars: 10 },
  scanner: { topK: 0, includeDeveloping: true, methodVersion: "v1-scan" },
  backtest: { methodVersion: "v1-bt" },
};

const ser = (symbol: string, tf: Timeframe, candles: Candle[]): CandleSeries =>
  ({ symbol, timeframe: tf, candles }) as CandleSeries;

const cell = (symbol: string, candles: Candle[], frames?: BacktestCell["frames"]): BacktestCell => ({
  symbol, timeframe: "1h",
  series: { symbol, timeframe: "1h", candles } as CandleSeries,
  frames,
});

const run = (over: Partial<Parameters<typeof runBacktest>[0]> = {}): SystemBacktestResult => {
  const res = runBacktest({ cells: [cell("AA", mk())], config: CFG, ...over });
  if (!res.ok || res.data === undefined) throw new Error(`run failed: ${JSON.stringify(res.errors)}`);
  return res.data;
};

const BULL4H = ser("AA", "4h", drift(H4, 90, 90, 1));
const BULL15M = ser("AA", "15m", drift(M15, 90, 90, 1));

/** Real-producer FrameSource — mirrors the spec-33 composition wiring. */
const frameSrc = (tf: Timeframe, candles: Candle[]): FrameSource => {
  const sw = detectSwings(candles, "AA", tf, CFG.swing, "v1");
  const st = analyzeStructure(candles, sw.swings, "AA", tf, CFG.structure, "v1");
  const pl = analyzeLiquidity(candles, st.structure, "AA", tf, CFG.liquidity, "v1");
  const zo = analyzeZones(candles, st.structure, pl.pools, "AA", tf, CFG.zone, "v1");
  const im = analyzeImbalances(candles, "AA", tf, CFG.fvg, "v1");
  const ev = [...sw.events, ...st.events, ...pl.events, ...zo.events, ...im.events];
  return {
    timeframe: tf, candles,
    at: (idx): FrameSnapshot => ({
      structure: structureStateAt(candles, sw.swings, "AA", tf, CFG.structure, "v1", idx),
      momentum: momentumStateAt(candles, "AA", tf, CFG.momentum, "v1", idx),
      liquidity: liquidityStateAt(candles, st.structure, "AA", tf, CFG.liquidity, "v1", idx),
      zones: zoneStateAt(candles, st.structure, pl.pools, "AA", tf, CFG.zone, "v1", idx),
      imbalances: imbalanceStateAt(candles, "AA", tf, CFG.fvg, "v1", idx),
      events: ev.filter((e) => e.atBar <= idx),
    }),
  };
};

const emptySrc = (tf: Timeframe): FrameSource => ({ timeframe: tf, candles: [], at: () => null });

/** Minimal hand-built structure snapshot — `causalAlignAt` only reads fields. */
const struct = (over: Partial<MarketStructure>): MarketStructure =>
  ({ symbol: "AA", timeframe: "4h", trend: "uptrend", bias: "bullish", swings: [], updatedAt: new Date(E).toISOString(), ...over });

const snapSrc = (tf: Timeframe, snap: FrameSnapshot): FrameSource => ({
  timeframe: tf,
  candles: [{ time: E, open: 1, high: 1, low: 1, close: 1 }],
  at: () => snap,
});

const pool = (id: string, lo: number, hi: number, tf: Timeframe = "1h"): LiquidityPool =>
  ({ id, symbol: "AA", timeframe: tf, side: "buy_side", status: "resting", price: (lo + hi) / 2, lowerPrice: lo, upperPrice: hi, formedAt: new Date(E).toISOString() } as LiquidityPool);

// ---------------------------------------------------------------------------
describe("spec33 — A: FrameSnapshot slot population (transport)", () => {
  it("joined frames carry liquidity/zones/imbalances/events, not just the vote slice", () => {
    const htfCandles = drift(H4, 60, 90, 1);
    const roles = {
      htf: frameSrc("4h", htfCandles),
      itf: frameSrc("1h", mk()),
      etf: emptySrc("15m"),
    };
    const asOf = htfCandles[10].time + H4; // last closed 4h bar
    const joined = causalFramesAt(roles, asOf);
    expect(joined.htf).not.toBeNull();
    const snap = joined.htf!.snapshot;
    expect(snap.structure).toBeDefined();
    expect(snap.momentum).toBeDefined();
    expect(snap.liquidity).toBeDefined();
    expect(snap.zones).toBeDefined();
    expect(snap.imbalances).toBeDefined();
    expect(snap.events).toBeDefined();
    // Elements are genuinely populated on a live frame — transport is real.
    expect(Array.isArray(snap.liquidity)).toBe(true);
    expect(snap.events!.every((e) => e.atBar <= joined.htf!.barIndex)).toBe(true);
  });
});

describe("spec33 — B/D: zone HTF confluence, htfAligned, htfConflict", () => {
  const setup = () => {
    const candles = mk();
    const sw = detectSwings(candles, "AA", "1h", CFG.swing, "v1");
    const st = analyzeStructure(candles, sw.swings, "AA", "1h", CFG.structure, "v1");
    const pl = analyzeLiquidity(candles, st.structure, "AA", "1h", CFG.liquidity, "v1");
    return { candles, st, pl };
  };
  const htfZone = (lo: number, hi: number, type: ZoneType): Zone =>
    ({
      id: `zone:AA:4h:${type}:0:0`, symbol: "AA", timeframe: "4h", type,
      pattern: type === "demand" ? "DBR" : "DBD", upperPrice: hi, lowerPrice: lo,
      strength: 90, freshness: "fresh", retestCount: 0, penetrationDepthPct: 0,
      remainingStrength: 90, status: "active", structureImpact: "strong",
      liquidityContext: "none",
      originAt: new Date(E).toISOString(), createdAt: new Date(E).toISOString(),
    }) as Zone;

  it("inside same-direction HTF zone → htfAligned=true + confluence strengthens the zone", () => {
    const { candles, st, pl } = setup();
    const base = analyzeZones(candles, st.structure, pl.pools, "AA", "1h", CFG.zone, "v1").zones;
    const demand = base.find((z) => z.type === "demand");
    expect(demand).toBeDefined();
    const at: ZoneHtfProvider = () => ({
      zones: [htfZone(demand!.lowerPrice - 5, demand!.upperPrice + 5, "demand")],
    });
    const withHtf = analyzeZones(candles, st.structure, pl.pools, "AA", "1h", CFG.zone, "v1", undefined, at).zones;
    const z2 = withHtf.find((z) => z.id === demand!.id);
    expect(z2).toBeDefined();
    expect(z2!.htfAligned).toBe(true);
    expect(z2!.strength).toBeGreaterThan(demand!.strength); // weight active at f=1.0 vs redistributed
    expect(z2!.metadata?.htfConflict).toBeUndefined();
  });

  it("inside opposing HTF zone → htfConflict, f=0, weaker strength", () => {
    const { candles, st, pl } = setup();
    const base = analyzeZones(candles, st.structure, pl.pools, "AA", "1h", CFG.zone, "v1").zones;
    const demand = base.find((z) => z.type === "demand");
    expect(demand).toBeDefined();
    const at: ZoneHtfProvider = () => ({
      zones: [htfZone(demand!.lowerPrice - 5, demand!.upperPrice + 5, "supply")],
    });
    const withHtf = analyzeZones(candles, st.structure, pl.pools, "AA", "1h", CFG.zone, "v1", undefined, at).zones;
    const z2 = withHtf.find((z) => z.id === demand!.id);
    expect(z2!.htfAligned).toBe(false); // evaluated, not aligned
    expect(z2!.metadata?.htfConflict).toBe(true);
    expect(z2!.strength).toBeLessThan(demand!.strength); // f=0 dilutes vs redistribution
  });

  it("provider absent or returning undefined → bit-identical zones (redistribution)", () => {
    const { candles, st, pl } = setup();
    const base = analyzeZones(candles, st.structure, pl.pools, "AA", "1h", CFG.zone, "v1").zones;
    const undef = analyzeZones(candles, st.structure, pl.pools, "AA", "1h", CFG.zone, "v1", undefined, () => undefined).zones;
    expect(undef).toEqual(base);
    expect(undef.every((z) => z.htfAligned === undefined)).toBe(true);
  });

  it("zoneStateAt forwards the provider identically", () => {
    const { candles, st, pl } = setup();
    const demand = zoneStateAt(candles, st.structure, pl.pools, "AA", "1h", CFG.zone, "v1", candles.length - 1)
      .find((z) => z.type === "demand")!;
    const at: ZoneHtfProvider = () => ({
      zones: [htfZone(demand.lowerPrice - 5, demand.upperPrice + 5, "demand")],
    });
    const z2 = zoneStateAt(candles, st.structure, pl.pools, "AA", "1h", CFG.zone, "v1", candles.length - 1, at)
      .find((z) => z.id === demand.id)!;
    expect(z2.htfAligned).toBe(true);
  });
});

describe("spec33 — C: liquidityContext — HTF-pool sweep strength in scoring", () => {
  const setupFor = (): Setup =>
    ({
      id: "rev:AA:1h:0", symbol: "AA", timeframe: "1h", type: "reversal", direction: "bullish",
      status: "confirmed", createdAt: new Date(E).toISOString(), score: 0, reasons: [],
      metadata: { anchorPoolId: "p1", entryBandLow: 100, entryBandHigh: 101, invalidation: 99, targets: "110" },
    }) as Setup;
  const snapBase = (p: LiquidityPool, frames?: Parameters<typeof scoreOpportunity>[0]["snap"]["frames"]) => ({
    provenance: "snapshot" as const,
    structure: struct({ trend: "uptrend", bias: "bullish", timeframe: "1h" }),
    momentum: { state: "strengthening", bias: "bullish", displacementScore: 60 } as never,
    pools: [p],
    frames,
  });
  const liquidityF = (r: ReturnType<typeof scoreOpportunity>) =>
    r.ok && r.data !== undefined
      ? (r.data.contributions ?? []).find((c) => c.dimension === "liquidity")?.feature
      : undefined;

  it("anchor pool overlapping an HTF-role pool upgrades resting evidence 0.5 → 1.0", () => {
    const p = pool("p1", 100, 101); // resting — never swept
    const htfPool = pool("hp1", 99, 102, "4h"); // same level on the HTF frame
    const without = scoreOpportunity({ setup: setupFor(), atBar: 0, snap: snapBase(p), config: CFG.scoring });
    const withHtf = scoreOpportunity({
      setup: setupFor(), atBar: 0,
      snap: snapBase(p, { htf: { timeframe: "4h", barIndex: 3, snapshot: { liquidity: [htfPool] } }, itf: null, etf: null }),
      config: CFG.scoring,
    });
    expect(liquidityF(without)).toBe(0.5);
    expect(liquidityF(withHtf)).toBe(1);
  });

  it("non-overlapping HTF pool leaves the tier at 0.5", () => {
    const p = pool("p1", 100, 101);
    const farPool = pool("hp2", 50, 60, "4h");
    const r = scoreOpportunity({
      setup: setupFor(), atBar: 0,
      snap: snapBase(p, { htf: { timeframe: "4h", barIndex: 3, snapshot: { liquidity: [farPool] } }, itf: null, etf: null }),
      config: CFG.scoring,
    });
    expect(liquidityF(r)).toBe(0.5);
  });
});

describe("spec33 — E: htfProtected* — ITF break of HTF protected level ends aligned state", () => {
  const ASOF = E + H4; // one closed 4h bar
  const W = CFG.mtf.weights;
  const roles = (htf: FrameSnapshot, itf: FrameSnapshot, etf: FrameSnapshot) => ({
    htf: snapSrc("4h", htf), itf: snapSrc("1h", itf), etf: snapSrc("15m", etf),
  });
  const bullStruct = (keyLevels?: MarketStructure["keyLevels"], breaks?: MarketStructure["breaks"]) =>
    struct({ trend: "uptrend", bias: "bullish", keyLevels, breaks });

  it("aligned_bull ends → countertrend_bear when ITF breaks the HTF protected low", () => {
    const htf = { structure: bullStruct([{ label: "protected", price: 100 }]) };
    const clean = { structure: bullStruct() };
    const broken = {
      structure: bullStruct(undefined, [
        { type: "CHOCH", direction: "bearish", price: 99, refPrice: 99, time: new Date(ASOF).toISOString(), confirmed: true, breakIndex: 2 },
      ]),
    };
    const base = causalAlignAt("AA", roles(htf, clean, clean), W, ASOF);
    expect(base.alignment.state).toBe("aligned_bull");
    const out = causalAlignAt("AA", roles(htf, broken, clean), W, ASOF);
    expect(out.alignment.state).toBe("countertrend_bear");
    expect(out.diagnostics.htfProtectedBroken).toBe(true);
    expect(out.alignment.votes).toEqual(base.alignment.votes); // votes untouched — post-vote rule
  });

  it("fires on pullback_in_trend too (aligned family), never on non-aligned states", () => {
    const htf = { structure: bullStruct([{ label: "protected", price: 100 }]) };
    const itf = {
      structure: bullStruct(undefined, [
        { type: "BOS", direction: "bearish", price: 98, refPrice: 98, time: new Date(ASOF).toISOString(), confirmed: true, breakIndex: 1 },
      ]),
    };
    const bearEtf = { structure: struct({ trend: "downtrend", bias: "bearish" }) };
    const out = causalAlignAt("AA", roles(htf, itf, bearEtf), W, ASOF);
    // votes (+1,+1,-1) classify pullback_in_trend_bull — the break ends it.
    expect(out.alignment.state).toBe("countertrend_bear");
    // Same break with a non-aligned base state is left alone:
    const neutrItf = { structure: struct({ trend: "transition", bias: "neutral", breaks: itf.structure.breaks }) };
    const cleanEtf = { structure: bullStruct() };
    const out2 = causalAlignAt("AA", roles(htf, neutrItf, cleanEtf), W, ASOF);
    expect(out2.alignment.state).not.toBe("countertrend_bear");
    expect(out2.diagnostics.htfProtectedBroken).toBe(false);
  });

  it("bearish mirror — ITF bullish break through HTF protected high → countertrend_bull", () => {
    const bearStruct = (keyLevels?: MarketStructure["keyLevels"], breaks?: MarketStructure["breaks"]) =>
      struct({ trend: "downtrend", bias: "bearish", keyLevels, breaks });
    const htf = { structure: bearStruct([{ label: "protected", price: 100 }]) };
    const itf = {
      structure: bearStruct(undefined, [
        { type: "CHOCH", direction: "bullish", price: 101, refPrice: 101, time: new Date(ASOF).toISOString(), confirmed: true, breakIndex: 2 },
      ]),
    };
    const out = causalAlignAt("AA", roles(htf, itf, { structure: bearStruct() }), W, ASOF);
    expect(out.alignment.state).toBe("countertrend_bull");
  });

  it("no protected level (HTF transition/range) → rule cannot fire", () => {
    const htf = { structure: struct({ trend: "transition", bias: "bullish" }) }; // no keyLevels
    const itf = {
      structure: bullStruct(undefined, [
        { type: "CHOCH", direction: "bearish", price: 99, refPrice: 99, time: new Date(ASOF).toISOString(), confirmed: true, breakIndex: 2 },
      ]),
    };
    const out = causalAlignAt("AA", roles(htf, itf, { structure: bullStruct() }), W, ASOF);
    expect(out.alignment.state).toBe("aligned_bull"); // htf vote still +1 via bias
    expect(out.diagnostics.htfProtectedBroken).toBe(false);
  });

  it("re-evaluates per call — a new protected level restores alignment (non-latching)", () => {
    const itf = {
      structure: bullStruct(undefined, [
        { type: "BOS", direction: "bearish", price: 95, refPrice: 95, time: new Date(ASOF).toISOString(), confirmed: true, breakIndex: 2 },
      ]),
    };
    const broken = causalAlignAt("AA", roles({ structure: bullStruct([{ label: "protected", price: 100 }]) }, itf, { structure: bullStruct() }), W, ASOF);
    expect(broken.alignment.state).toBe("countertrend_bear");
    // HTF confirmed a NEW protected low at 90 — the old break (refPrice 95) no longer crosses it.
    const restored = causalAlignAt("AA", roles({ structure: bullStruct([{ label: "protected", price: 90 }]) }, itf, { structure: bullStruct() }), W, ASOF);
    expect(restored.alignment.state).toBe("aligned_bull");
    expect(restored.diagnostics.htfProtectedBroken).toBe(false);
  });
});

describe("spec33 — F/G: missing frames + baseline parity", () => {
  it("unframed, empty, and all-invalid frames are bit-identical — no fabricated context", () => {
    const base = run();
    const empty = run({ cells: [cell("AA", mk(), {})] });
    const bad: Candle[] = drift(H4, 40, 90, 1).map((k, i) => (i % 3 === 0 ? { ...k, high: k.low - 1 } : k));
    const invalid = run({ cells: [cell("AA", mk(), { htf: ser("AA", "4h", bad) })] });
    expect(empty.opportunities).toEqual(base.opportunities);
    expect(empty.developing).toEqual(base.developing);
    expect(invalid.opportunities).toEqual(base.opportunities);
    expect(invalid.developing).toEqual(base.developing);
    expect(invalid.outcomes).toEqual(base.outcomes);
  });

  it("etf-only frames cannot supply HTF context — htf slot is honestly absent", () => {
    // zones must remain flag-free: no htf frame ⇒ no confluence, no htfAligned.
    const { candles } = { candles: mk() };
    const sw = detectSwings(candles, "AA", "1h", CFG.swing, "v1");
    const st = analyzeStructure(candles, sw.swings, "AA", "1h", CFG.structure, "v1");
    const pl = analyzeLiquidity(candles, st.structure, "AA", "1h", CFG.liquidity, "v1");
    const zones = analyzeZones(candles, st.structure, pl.pools, "AA", "1h", CFG.zone, "v1").zones;
    // The etf-only backtest path exercises the same zone engine without htfAt —
    // assert the contract: no provider → no htfAligned ever.
    expect(zones.every((z) => z.htfAligned === undefined)).toBe(true);
    // Run-level: etf-only joins as ltf_directed (< 0.8) — the spec-32 gate blocks every
    // confirm, so opportunities are empty while unframed baseline confirms. That IS the
    // honest-absence signal: an htf slot was joined empty, never fabricated.
    const r = run({ cells: [cell("AA", mk(), { etf: BULL15M })] });
    const base = run();
    expect(base.opportunities.length).toBeGreaterThan(0);
    expect(r.opportunities).toEqual([]);
    expect(r.developing.length).toBeGreaterThan(0);
  });
});

describe("spec33 — H/I: closed-bar boundary + prefix/full causality", () => {
  it("a frame zone closing exactly at asOf is visible; 1ms later it is not", () => {
    // Fabricated snapshots — visibility is join-level (closedIndexAt), producer-agnostic.
    const zone = (id: string): Zone =>
      ({ id, symbol: "AA", timeframe: "4h", type: "demand", upperPrice: 110, lowerPrice: 100, status: "active" } as Zone);
    const snaps = [ { zones: [] }, { zones: [zone("z1")] } ];
    const candles: Candle[] = [0, 1].map((i) => ({ time: E + i * H4, open: 1, high: 1, low: 1, close: 1 }));
    const src: FrameSource = { timeframe: "4h", candles, at: (idx) => snaps[idx] };
    const roles = { htf: src, itf: emptySrc("1h"), etf: emptySrc("15m") };
    const boundary = candles[1].time + H4; // second 4h bar's close
    expect(closedIndexAt(candles, "4h", boundary)).toBe(1);
    expect(causalFramesAt(roles, boundary).htf!.snapshot.zones!.map((z) => z.id)).toEqual(["z1"]);
    expect(closedIndexAt(candles, "4h", boundary - 1)).toBe(0);
    expect(causalFramesAt(roles, boundary - 1).htf!.snapshot.zones).toEqual([]);
  });

  it("prefix cell + full frames ≡ full run at T — future frame elements never leak", () => {
    const T = 50;
    const full = mk();
    // HTF frame whose LATE bars create new elements (zones/pools/events) after T.
    const htf = ser("AA", "4h", mk()); // same-shaped series on 4h — elements change late
    const prefix = run({
      cells: [cell("AA", full.slice(0, T + 1), { htf, etf: BULL15M })],
    });
    const complete = run({
      cells: [cell("AA", full, { htf, etf: BULL15M })],
      window: { startIndex: 0, endIndex: T },
    });
    expect(prefix.opportunities).toEqual(complete.opportunities);
    expect(prefix.developing).toEqual(complete.developing);
  }, 20000); // two framed runs — full upstream chains per frame
});

describe("spec33 — J/K/L: determinism, permutation, spec-32 interaction", () => {
  it("repeated framed runs are identical; frame key order is irrelevant", () => {
    const mk1 = () => cell("AA", mk(), { htf: BULL4H, etf: BULL15M });
    const mk2 = () => cell("AA", mk(), { etf: BULL15M, htf: BULL4H });
    const a = run({ cells: [mk1()] });
    const b = run({ cells: [mk1()] });
    const p = run({ cells: [mk2()] });
    expect(a).toEqual(b);
    expect(p.opportunities).toEqual(a.opportunities);
    expect(p.developing).toEqual(a.developing);
  }, 15000); // three framed runs — full upstream chains per frame

  it("spec-32 confirmation gate still applies with frame elements present", () => {
    // etf-only composition → ltf_directed alignment (< 0.8) — records must remain
    // developing with the spec-32 multi_timeframe reason; frame elements don't bypass it.
    const r = run({ cells: [cell("AA", mk(), { etf: BULL15M })] });
    const gated = r.developing.filter((d) =>
      (d.reasons ?? []).some((x) => x.category === "multi_timeframe"),
    );
    expect(gated.length).toBeGreaterThan(0);
    // And no opportunity may exist while the gate blocks — spec-32 invariant.
    const oppIds = new Set(r.opportunities.map((o) => o.setupId));
    for (const d of gated) expect(oppIds.has(d.setupId)).toBe(false);
  });
});
