/**
 * Spec 31 — MTF Alignment Composition (docs/engine/31-mtf-alignment-composition.md).
 *
 * Composition-only phase: wire the existing spec-10 producer `causalAlignAt` into
 * `runBacktest`'s causal join `at(t)` so `ReversalInput`/`BreakoutInput`/
 * `ContinuationInput`/`ScoringSnapshot.alignment` receive real data when the caller
 * supplies `BacktestCell.frames`. No producer/consumer logic changed — the dormant
 * slots are populated.
 *
 * Fixture strategy: the spec-26/29/30 `mk()` 1h reversal cell plus synthetic auxiliary
 * series. Frame votes are driven by `snapshotVote` = structure bias → momentum bias:
 * a steady drift produces a directional bias; dojis produce vote 0.
 */
import { describe, expect, it } from "vitest";
import type {
  BacktestCell,
  BacktestOpportunity,
  Candle,
  CandleSeries,
  EngineConfig,
  SystemBacktestResult,
  Timeframe,
} from "@/lib/types";
import { runBacktest } from "../backtest";

const E = Date.UTC(2024, 0, 1);
const H1 = 3_600_000;
const M15 = 900_000;
const bar = (i: number, o: number, h: number, l: number, c: number, base = E): Candle => ({
  time: base + i * H1, open: o, high: h, low: l, close: c, volume: 1000,
});

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

const shift = (candles: Candle[], hours: number): Candle[] =>
  candles.map((k) => ({ ...k, time: k.time + hours * H1 }));

/** Steady one-directional `tf`-frame drift covering `hours` wall-clock hours — structure
 *  trend + momentum bias agree → vote = `dir`. */
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
const runRes = (over: Parameters<typeof runBacktest>[0]) => runBacktest(over);

const htfContrib = (o: BacktestOpportunity) =>
  (o.scoreContributions ?? []).find((c) => c.dimension === "htfAlignment");
const mtfReasons = (r: SystemBacktestResult) =>
  r.developing.flatMap((d) => (d.reasons ?? []).filter((x) => x.category === "multi_timeframe"));

const BULL4H = ser("AA", "4h", drift(4 * H1, 90, 90, 1));
const BULL15M = ser("AA", "15m", drift(M15, 90, 90, 1));
const BEAR15M = ser("AA", "15m", drift(M15, 90, 130, -1));

// ---------------------------------------------------------------------------
describe("spec31 — population & consumer activation", () => {
  it("A: framed cell populates alignment — htfAlignment factor is real, not no_context", () => {
    const r = run({ cells: [cell("AA", mk(), { htf: BULL4H, etf: BULL15M })] });
    const recs = r.opportunities;
    expect(recs.length).toBeGreaterThan(0);
    const c49 = htfContrib(recs.find((o) => o.evaluatedIndex === 49)!);
    expect(c49?.label).toBe("mtf aligned_bull");
    expect(c49?.feature).toBe(1); // spec-15 factor: aligned_* = 1.0
  });

  it("B: countertrend veto — opposing frames cancel the bullish reversal (reversal slot)", () => {
    const framed = run({ cells: [cell("AA", mk(), { htf: BULL4H, etf: BEAR15M })] });
    const unframed = run({ cells: [cell("AA", mk())] });
    // baseline: the bullish reversal confirms (9 records); with countertrend context
    // the existing mtf_veto_* path cancels it — never confirmed, no outcome row.
    expect(unframed.opportunities.length).toBeGreaterThan(0);
    expect(framed.opportunities.length).toBe(0);
    expect(framed.outcomes.length).toBe(0);
    const c8 = mtfReasons(framed).filter((x) => x.id === "C8");
    expect(c8.length).toBeGreaterThan(0);
    expect(c8.every((x) => x.met === false)).toBe(true);
  });

  it("C/D: detector reason slots consume real alignment — C8 met verdict tracks state", () => {
    // brk/cnt detectors share the identical `at(t)` join (one function, one object —
    // population proven behaviorally via reversal; mk() emits no brk/cnt setups, so the
    // observable surface is the multi_timeframe reason verdict on reversal devs).
    const aligned = run({ cells: [cell("AA", mk(), { htf: BULL4H, etf: BULL15M })] });
    const bullDevs = aligned.developing.filter((d) => d.setupId.includes("bullish"));
    // C8 acceptable under aligned_bull ⇒ met ⇒ absent from unmet-reasons lists.
    const bullC8 = bullDevs.flatMap((d) => (d.reasons ?? []).filter((x) => x.id === "C8"));
    expect(bullDevs.length).toBeGreaterThan(0);
    expect(bullC8.length).toBe(0); // met reasons are not "what's missing"
  });

  it("E: scoring dimension reflects the canonical state per spec-15 factor table", () => {
    const aligned = run({ cells: [cell("AA", mk(), { htf: BULL4H, etf: BULL15M })] });
    const noCtx = run({ cells: [cell("AA", mk())] });
    const a49 = htfContrib(aligned.opportunities.find((o) => o.evaluatedIndex === 49)!);
    const n49 = htfContrib(noCtx.opportunities.find((o) => o.evaluatedIndex === 49)!);
    expect(a49?.feature).toBe(1);
    expect(a49?.points).toBe(10); // weight 10 × 1.0
    expect(n49?.feature).toBeCloseTo(0.2); // no_context bucket
    expect(n49?.points).toBe(2);
    expect(aligned.opportunities[0].score).toBeGreaterThan(noCtx.opportunities[0].score);
  });
});

// ---------------------------------------------------------------------------
describe("spec31 — temporal boundary & causality", () => {
  /** ETF whose final 15m bar is a violent bearish move closing exactly at asOf(50)
   *  (E+51h) when extra=0, or 1ms later when extra=1 (invisible until t=51). */
  const boundaryEtf = (extra: number): CandleSeries => {
    const arr: Candle[] = [];
    const t20 = E + 51 * H1 - M15 + extra; // bar 20's close == E+51h + extra
    for (let i = 0; i < 10; i++)
      arr.push({ time: t20 - (20 - i) * M15, open: 100, high: 100.05, low: 99.95, close: 100, volume: 1000 });
    for (let i = 10; i < 20; i++) {
      const o = 100 + (i - 10) * 0.6;
      arr.push({ time: t20 - (20 - i) * M15, open: o, high: o + 0.65, low: o - 0.05, close: o + 0.55, volume: 1000 });
    }
    arr.push({ time: t20, open: 106, high: 106.2, low: 99.8, close: 100.2, volume: 1000 });
    return ser("AA", "15m", arr);
  };
  const lbl = (r: SystemBacktestResult, idx: number) =>
    htfContrib(r.opportunities.find((o) => o.evaluatedIndex === idx)!)?.label;

  it("E2-boundary: frame bar closing exactly at asOf is visible; +1ms is not", () => {
    const incl = run({ cells: [cell("AA", mk(), { htf: BULL4H, etf: boundaryEtf(0) })] });
    const excl = run({ cells: [cell("AA", mk(), { htf: BULL4H, etf: boundaryEtf(1) })] });
    // t=49: boundary bar open in both runs → identical
    expect(lbl(incl, 49)).toBe("mtf aligned_bull");
    expect(lbl(excl, 49)).toBe("mtf aligned_bull");
    // t=50: bar's close == asOf(50) → visible only in `incl` (etf -1 → pullback state)
    expect(lbl(incl, 50)).toBe("mtf pullback_in_trend_bull");
    expect(lbl(excl, 50)).toBe("mtf aligned_bull");
    // t≥51: closed for both → converge (non-triviality: the bar really does flip the vote)
    expect(lbl(incl, 51)).toBe(lbl(excl, 51));
    expect(lbl(incl, 51)).toBe("mtf pullback_in_trend_bull");
  });

  it("H: prefix cell + full frames — records ≤ T identical; future frame bars never leak", () => {
    const T = 50;
    const frames = () => ({ htf: BULL4H, etf: boundaryEtf(0) });
    const prefix = run({
      cells: [cell("AA", mk().slice(0, T + 1), frames())],
      window: { startIndex: 0, endIndex: T },
    });
    const full = run({ cells: [cell("AA", mk(), frames())], window: { startIndex: 0, endIndex: T } });
    expect(prefix.opportunities.length).toBeGreaterThan(0);
    // Records ≤ T are bit-identical even though the full cell continues past T
    // (the violent boundary bar at E+50h45m is data the prefix cell never saw).
    expect(prefix.opportunities).toEqual(full.opportunities);
    expect(prefix.developing).toEqual(full.developing);
    // non-triviality: the full run has records beyond the prefix horizon
    const fullLong = run({ cells: [cell("AA", mk(), frames())] });
    expect(fullLong.opportunities.some((o) => o.evaluatedIndex > T)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("spec31 — missing / partial / invalid frames", () => {
  it("G: frames-absent parity — undefined, {}, and {htf: undefined} are bit-identical", () => {
    const a = run({ cells: [cell("AA", mk())] });                        // no frames field
    const b = run({ cells: [cell("AA", mk(), {})] });                    // empty object
    const c = run({ cells: [cell("AA", mk(), { htf: undefined })] });    // undefined member
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // sanity: the baseline actually emits records and no_context factors
    expect(htfContrib(a.opportunities[0])?.label).toBe("mtf no_context");
  });

  it("F: partial frames — single supplied role composes; missing roles vote 0 honestly", () => {
    // etf only: htf absent → h=0 → ltf_directed (spec-10 truth table; missing roles
    // vote 0 — never fabricated). Spec-32 consequence: signed score ≤0.5 <0.8 → the
    // canonical confirmation gate holds the setup developing — observable via C10.
    const r = runRes({ cells: [cell("AA", mk(), { etf: BULL15M })], config: CFG });
    expect(r.ok).toBe(true);
    const d = r.data!;
    expect(d.developing.length).toBeGreaterThan(0); // composition ran — setups emitted
    const c10 = mtfReasons(d).filter((x) => x.id === "C10");
    expect(c10.length).toBeGreaterThan(0);
    expect(c10.every((x) => x.met === false)).toBe(true); // gate blocked — not fabricated
    expect((r.meta.diagnostics as Record<string, unknown>).mtfFramesSkipped).toBe("");
  });

  it("J: invalid frames degrade diagnostically — never fabricated, never fatal", () => {
    const bad4h: Candle[] = drift(4 * H1, 40, 90, 1).map((k) => ({ ...k, high: k.low - 1 }));
    const base = run({ cells: [cell("AA", mk())] });

    // (a) malformed htf candles → skipped; the valid etf frame still composes.
    // Spec-32: etf-only ⇒ ltf_directed (signed ≤0.5) ⇒ developing-only — never fatal.
    const ra = runRes({ cells: [cell("AA", mk(), { htf: ser("AA", "4h", bad4h), etf: BULL15M })], config: CFG });
    expect(ra.ok).toBe(true);
    expect((ra.meta.diagnostics as Record<string, unknown>).mtfFramesSkipped).toContain("AA:1h:htf");
    expect(ra.data!.developing.length).toBeGreaterThan(0); // etf-only composition survives

    // (b) declared timeframe mismatches the role's configured timeframe → skipped;
    // zero valid frames remain ⇒ no alignment ⇒ records identical to baseline
    const rb = runRes({ cells: [cell("AA", mk(), { etf: ser("AA", "4h", drift(4 * H1, 90, 90, 1)) })], config: CFG });
    expect(rb.ok).toBe(true);
    expect((rb.meta.diagnostics as Record<string, unknown>).mtfFramesSkipped).toContain("AA:1h:etf");
    expect(rb.data!.opportunities).toEqual(base.opportunities);

    // (c) frame supplied for the cell's own role (itf "1h") → skipped; the cell's
    // real series wins — a deliberately-bearish fake itf frame must not leak in:
    // records identical to the same run without the bogus frame.
    const fakeItf = ser("AA", "1h", drift(H1, 90, 130, -1));
    const rc = runRes({ cells: [cell("AA", mk(), { itf: fakeItf, etf: BULL15M })], config: CFG });
    const ref = runRes({ cells: [cell("AA", mk(), { etf: BULL15M })], config: CFG });
    expect(rc.ok).toBe(true);
    expect((rc.meta.diagnostics as Record<string, unknown>).mtfFramesSkipped).toContain("AA:1h:itf");
    expect(rc.data!.opportunities).toEqual(ref.data!.opportunities);
    expect(rc.data!.developing).toEqual(ref.data!.developing);

    // (d) all-invalid frames ⇒ no alignment ⇒ baseline-identical records
    const rd = runRes({ cells: [cell("AA", mk(), { htf: ser("AA", "4h", bad4h) })], config: CFG });
    expect(rd.data!.opportunities).toEqual(base.opportunities);
  });
});

// ---------------------------------------------------------------------------
describe("spec31 — determinism, permutation & statistics isolation", () => {
  it("I/J: identical and permuted runs produce identical results", () => {
    const cellsFwd = () => [
      cell("AA", mk(), { htf: BULL4H, etf: BULL15M }),
      cell("BB", shift(mk(), 720), { htf: ser("BB", "4h", drift(4 * H1, 90, 90, 1, E + 720 * H1)) }),
    ];
    const a = run({ cells: cellsFwd() });
    const b = run({ cells: cellsFwd() });
    expect(a).toEqual(b);
    const rev = run({ cells: [...cellsFwd()].reverse() });
    expect(rev.opportunities).toEqual(a.opportunities);
    expect(rev.developing).toEqual(a.developing);
    expect(rev.outcomes).toEqual(a.outcomes);
  });

  it("frame key insertion order cannot affect results", () => {
    const x = run({ cells: [cell("AA", mk(), { htf: BULL4H, etf: BULL15M })] });
    const y = run({ cells: [cell("AA", mk(), { etf: BULL15M, htf: BULL4H })] });
    expect(y).toEqual(x);
  });

  it("K: statistics isolation — MTF never appears as a cohort axis or evidence input", () => {
    // 3-cell cohort fixture (spec-30) with the BB cell framed+aligned.
    const cells = () => [
      cell("AA", mk()),
      cell("CC", shift(mk(), 360)),
      // BB framed with ALIGNED context — a lone htf would countertrend-veto the
      // reversal during its crash leg (spec-10 truth table), leaving no records.
      cell("BB", shift(mk(), 720), {
        htf: ser("BB", "4h", drift(4 * H1, 90, 90, 1, E + 720 * H1)),
        etf: ser("BB", "15m", drift(M15, 90, 90, 1, E + 720 * H1)),
      }),
    ];
    const statsCfg: EngineConfig = {
      ...CFG,
      stats: { minSamples: 2, scoreBands: [0, 50, 70, 85], methodVersion: "v1-stats" },
    };
    const r = run({ cells: cells(), config: statsCfg });
    const bb = r.opportunities.filter((o) => o.setupId.startsWith("rev:BB:"));
    expect(bb.length).toBeGreaterThan(0);
    for (const o of r.opportunities) {
      const ev = o.statisticalEvidence;
      if (ev?.estimate === undefined) continue;
      // cohort axes remain exactly spec-24's grammar: st|dir|reg|sb (| "*" fallback)
      expect(ev.estimate.cohortKey === "*" || /^st=[^|]+\|dir=[^|]+\|reg=[^|]+\|sb=[^|]+$/.test(ev.estimate.cohortKey)).toBe(true);
      expect(ev.estimate.cohortKey).not.toMatch(/mtf|tf=|align/i);
    }
    // evidence still populates (composition wired, frames change scores — not the axes)
    expect(bb[0].statisticalEvidence).toBeDefined();
  });
});
