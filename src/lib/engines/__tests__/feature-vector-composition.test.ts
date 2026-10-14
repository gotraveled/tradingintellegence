/**
 * Spec 35 — Outcome feature-vector completion (docs/engine/17 ML-schema closure).
 *
 * The spec-17 schema declares `featureVector` = flattened engine inputs at
 * `confirmBar`: "swing params context, zone strength components, displacement fᵢ,
 * momentum features, MTF votes, regime, score contributions". V1 flattened only the
 * `score.*` keys; spec 35 transports the remaining canonical classes through the
 * existing `at(cb)` join — additive optional input, honest absence for every
 * unavailable slice, `mtf.*` only on framed cells (spec-34 parity rule).
 *
 * Key grammar (pinned): swing.{leftBars,rightBars,atrLength,minSignificanceAtr,
 * equalToleranceAtr,mergeEqual} | zone.{strength,remainingStrength,retestCount,
 * penetrationDepthPct,htfAligned} | disp.score | momentum.{directionalMove,
 * rateOfChange,atrTrend,bodyStrength,consecDirection,volumeRatio,rsi14} |
 * mtf.{votes.htf,votes.itf,votes.etf,score} | regime.<label> indicators |
 * score.<dimension>, score.total (unchanged).
 */
import { describe, expect, it } from "vitest";
import type {
  BacktestCell,
  Candle,
  CandleSeries,
  EngineConfig,
  Setup,
  SetupOutcome,
  SystemBacktestResult,
  Timeframe,
} from "@/lib/types";
import { runBacktest } from "../backtest";
import { measureOutcome, type OutcomeFeatureBundle } from "../outcomes";

const E = Date.UTC(2024, 0, 1);
const H1 = 3_600_000;
const M15 = 900_000;
const H4 = 4 * H1;
const bar = (i: number, o: number, h: number, l: number, c: number, base = E): Candle => ({
  time: base + i * H1, open: o, high: h, low: l, close: c, volume: 1000,
});

/** The spec-26→34 fixture cell — 1h reversal pattern (rise → crash → recovery). */
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
const FRAMED = { htf: BULL4H, etf: BULL15M };
const framed = (): SystemBacktestResult => run({ cells: [cell("AA", mk(), FRAMED)] });

const rows = (r: SystemBacktestResult): SetupOutcome[] => r.outcomes ?? [];
const fvOf = (r: SystemBacktestResult, idx = 0): Record<string, number> => {
  const f = rows(r)[idx]?.featureVector;
  if (!f) throw new Error("expected featureVector on outcome row");
  return f;
};

const MOMENTUM_KEYS = [
  "momentum.directionalMove", "momentum.rateOfChange", "momentum.atrTrend",
  "momentum.bodyStrength", "momentum.consecDirection", "momentum.volumeRatio",
  "momentum.rsi14",
];
const MTF_KEYS = ["mtf.votes.htf", "mtf.votes.itf", "mtf.votes.etf", "mtf.score"];
const REGIME_LABELS = [
  "trending_bullish", "trending_bearish", "ranging",
  "high_volatility", "low_volatility", "transition",
];

// ---------------------------------------------------------------------------

describe("spec-35 featureVector — canonical key set + grammar", () => {
  it("emits every spec-17 feature class at confirmBar (unframed)", () => {
    const fv = fvOf(run());
    // swing params context — the config values in force, echoed verbatim.
    expect(fv["swing.leftBars"]).toBe(CFG.swing.leftBars);
    expect(fv["swing.rightBars"]).toBe(CFG.swing.rightBars);
    expect(fv["swing.atrLength"]).toBe(CFG.swing.atrLength);
    expect(fv["swing.minSignificanceAtr"]).toBe(CFG.swing.minSignificanceAtr);
    expect(fv["swing.equalToleranceAtr"]).toBe(CFG.swing.equalToleranceAtr);
    expect(fv["swing.mergeEqual"]).toBe(1);
    // zone.* — the reversal fixture's anchor zone is causally visible at cb.
    expect(fv["zone.strength"]).toEqual(expect.any(Number));
    expect(fv["zone.retestCount"]).toEqual(expect.any(Number));
    // momentum + displacement composites at cb.
    expect(fv["disp.score"]).toEqual(expect.any(Number));
    for (const k of MOMENTUM_KEYS) {
      if (fv[k] !== undefined) expect(fv[k]).toEqual(expect.any(Number));
    }
    // score.* preserved (V1 semantics).
    expect(fv["score.total"]).toEqual(expect.any(Number));
    expect(Object.keys(fv).filter((k) => k.startsWith("score.")).length).toBeGreaterThan(1);
  });

  it("namespace grammar — every key is a known namespaced class", () => {
    const fv = fvOf(run());
    const prefix = /^(swing|zone|disp|momentum|mtf|regime|score)\.[A-Za-z0-9_.]+$/;
    for (const k of Object.keys(fv)) expect(k).toMatch(prefix);
  });

  it("regime.* — indicator encoding: exactly one label hot, consistent with the row field", () => {
    const r = run();
    const row = rows(r)[0];
    const fv = row.featureVector!;
    expect(row.regime).toBeDefined();
    for (const l of REGIME_LABELS) {
      expect(fv[`regime.${l}`]).toBe(row.regime === l ? 1 : 0);
    }
    const hot = REGIME_LABELS.filter((l) => fv[`regime.${l}`] === 1);
    expect(hot).toHaveLength(1);
  });

  it("featureVector stays absent when neither features nor contributions exist (contract path)", () => {
    // Direct measureOutcome without `features` — V1 shape must be preserved.
    const candles = drift(H1, 60, 100, 1);
    const setup: Setup = {
      id: "rev:AA:1h:bullish:z1:s1", symbol: "AA", timeframe: "1h",
      type: "reversal", direction: "bullish", score: 50,
      reasons: [], status: "confirmed",
      createdAt: new Date(E).toISOString(), updatedAt: new Date(E + 45 * H1).toISOString(),
      metadata: { confirmBar: 45, candidateBar: 40, entryBandLow: 100, entryBandHigh: 101, invalidation: 98, targets: "104,108" },
    } as Setup;
    const res = measureOutcome({ setup, candles });
    expect(res.ok).toBe(true);
    expect(res.data?.featureVector).toBeUndefined();
  });

  it("unit flattening — a synthetic bundle emits the exact documented keys/values", () => {
    const candles = drift(H1, 60, 100, 1);
    const setup: Setup = {
      id: "rev:AA:1h:bullish:z1:s1", symbol: "AA", timeframe: "1h",
      type: "reversal", direction: "bullish", score: 50,
      reasons: [], status: "confirmed",
      createdAt: new Date(E).toISOString(), updatedAt: new Date(E + 45 * H1).toISOString(),
      metadata: { confirmBar: 45, candidateBar: 40, entryBandLow: 100, entryBandHigh: 101, invalidation: 98, targets: "104,108" },
    } as Setup;
    const features: OutcomeFeatureBundle = {
      swing: { leftBars: 2, rightBars: 3, atrLength: 5, minSignificanceAtr: 0.1, equalToleranceAtr: 0.15, mergeEqual: false },
      zone: { id: "z1", strength: 72, retestCount: 1, remainingStrength: 61.5, penetrationDepthPct: 20, htfAligned: true } as never,
      momentum: { state: "strengthening", bias: "bullish", displacementScore: 66, features: { directionalMove: 1.9, rsi14: 57 } },
      alignment: { votes: { htf: 1, itf: -1, etf: 0 }, alignmentScore: 0.2 } as never,
    };
    const res = measureOutcome({
      setup, candles, features, regime: "ranging",
      contributions: [{ dimension: "structure", label: "s", weight: 20, feature: 0.9, points: 18, signalIds: ["x"] }],
      scoreAtConfirmation: 90,
    });
    const fv = res.data!.featureVector!;
    expect(fv["swing.leftBars"]).toBe(2);
    expect(fv["swing.rightBars"]).toBe(3);
    expect(fv["swing.atrLength"]).toBe(5);
    expect(fv["swing.minSignificanceAtr"]).toBe(0.1);
    expect(fv["swing.equalToleranceAtr"]).toBe(0.15);
    expect(fv["swing.mergeEqual"]).toBe(0);
    expect(fv["zone.strength"]).toBe(72);
    expect(fv["zone.remainingStrength"]).toBe(61.5);
    expect(fv["zone.retestCount"]).toBe(1);
    expect(fv["zone.penetrationDepthPct"]).toBe(20);
    expect(fv["zone.htfAligned"]).toBe(1);
    expect(fv["disp.score"]).toBe(66);
    expect(fv["momentum.directionalMove"]).toBe(1.9);
    expect(fv["momentum.rsi14"]).toBe(57);
    expect(fv["momentum.rateOfChange"]).toBeUndefined(); // absent feature → absent key
    expect(fv["mtf.votes.htf"]).toBe(1);
    expect(fv["mtf.votes.itf"]).toBe(-1);
    expect(fv["mtf.votes.etf"]).toBe(0);
    expect(fv["mtf.score"]).toBe(0.2);
    expect(fv["regime.ranging"]).toBe(1);
    expect(fv["regime.transition"]).toBe(0);
    expect(fv["score.structure"]).toBe(0.9);
    expect(fv["score.total"]).toBe(90);
    // exact total key count for the synthetic bundle
    expect(Object.keys(fv).length).toBe(
      6 /*swing*/ + 5 /*zone*/ + 1 /*disp*/ + 2 /*momentum*/ + 4 /*mtf*/ + 6 /*regime*/ + 2 /*score*/,
    );
  });
});

describe("spec-35 featureVector — MTF semantics", () => {
  it("framed run emits mtf.* from the confirmBar join", () => {
    const fv = fvOf(framed());
    for (const k of MTF_KEYS) expect(fv[k]).toEqual(expect.any(Number));
    // votes are the signed producer outputs; score is the weighted sum (0.5/0.3/0.2).
    expect(fv["mtf.score"]).toBeCloseTo(
      0.5 * fv["mtf.votes.htf"] + 0.3 * fv["mtf.votes.itf"] + 0.2 * fv["mtf.votes.etf"], 10,
    );
  }, 20000);

  it("unframed run has zero mtf.* keys — honest absence, no fabricated neutral", () => {
    const fv = fvOf(run());
    expect(Object.keys(fv).filter((k) => k.startsWith("mtf."))).toHaveLength(0);
  });
});

describe("spec-35 featureVector — causality + determinism", () => {
  it("prefix/full: rows confirmed inside the shared region carry identical vectors", () => {
    const full = fvOf(run());
    // Truncate the cell series at bar 58 — the reversal confirms at ~49, well inside.
    const candles = mk().slice(0, 58);
    const pre = run({ cells: [cell("AA", candles)] });
    const row = rows(pre).find((o) => o.setupId === rows(run())[0].setupId);
    expect(row).toBeDefined();
    expect(row!.featureVector).toEqual(full);
  });

  it("no outcome feedback: a different post-cb tail leaves the vector untouched", () => {
    const base = fvOf(run());
    // Same prefix through bar 55; a different tail changes resolution, not features.
    const alt = mk();
    for (let i = 58; i < alt.length; i++) {
      alt[i] = { ...alt[i], open: alt[i].close, high: alt[i].close + 0.05, low: alt[i].close - 0.05, close: alt[i].close };
    }
    const row = rows(run({ cells: [cell("AA", alt)] })).find((o) => o.setupId === rows(run())[0].setupId);
    expect(row!.featureVector).toEqual(base);
  });

  it("mtf.* is cb-anchored: post-cb frame changes cannot alter the vector", () => {
    const full = fvOf(framed());
    // Chop the 15m frame right after the last joinable bar at cb — later etf bars gone.
    const cutEtf = ser("AA", "15m", drift(M15, 52, 90, 1)); // ~52h of 15m bars only
    const cut = run({ cells: [cell("AA", mk(), { htf: BULL4H, etf: cutEtf })] });
    const row = rows(cut)[0];
    for (const k of MTF_KEYS) expect(row.featureVector![k]).toBe(full[k]);
  }, 20000);

  it("determinism: identical run → identical vectors; cell permutation → identical rows", () => {
    const a = rows(run());
    const b = rows(run());
    expect(a).toEqual(b);
    const c2 = run({
      cells: [cell("AA", mk()), cell("BB", mk())],
    });
    const perm = run({
      cells: [cell("BB", mk()), cell("AA", mk())],
    });
    const map = (r: SetupOutcome[]) => new Map(r.map((o) => [`${o.symbol}:${o.setupId}`, o.featureVector]));
    expect(map(rows(perm))).toEqual(map(rows(c2)));
    // each cell's vector equals the single-cell vector for the same fixture
    expect(map(rows(c2)).get(`AA:${a[0].setupId}`)).toEqual(a[0].featureVector);
  });
});
