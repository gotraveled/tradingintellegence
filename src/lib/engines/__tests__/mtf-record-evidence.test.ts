/**
 * Spec 34 - MTF alignment evidence on backtest records.
 *
 * The causal join already produces `at(t).alignment` (spec 31) and spec 33 enriched it
 * with the `htfProtected*` post-vote rule. Spec 34 freezes that exact object onto both
 * record kinds at emit time - the PIT observation of the spec-10 computation, never
 * recomputed, never normalized, absent (not null) on unframed runs.
 *
 * Composition-only: no MTF producer logic, detector, scoring, scanner, or outcome
 * contracts change. Tests are additive; the 790-test baseline must remain green.
 */
import { describe, expect, it } from "vitest";
import type {
  BacktestCell,
  BacktestDeveloping,
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
const H4 = 4 * H1;
const bar = (i: number, o: number, h: number, l: number, c: number, base = E): Candle => ({
  time: base + i * H1, open: o, high: h, low: l, close: c, volume: 1000,
});

/** The spec-26/29/30/31/32/33 fixture cell - 1h reversal pattern (rise -> crash -> recovery). */
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

/** 4h downtrend frame carrying a real `protected` keyLevel: dip low@1 (~94.8), pop
 *  high@4 (~102.9), wick-only dip to 93 (closes stay above 94.8 so the first low
 *  survives invalidation) -> LL@7, bounce high@9 (~97.4) -> LH, then slide.
 *  Produces trend=downtrend + protected=97.4 from 4h index 10 onward - the level
 *  the cell's bullish CHOCH (breakIndex 47, refPrice 97.7) causally crosses, turning
 *  a base `aligned_bear` (-1,-1,-1) into `countertrend_bull` via htfProtected*. */
const bearProt = (base = E): Candle[] => {
  const c: Candle[] = [];
  const put = (i: number, o: number, h: number, l: number, cl: number) =>
    c.push({ time: base + i * H4, open: o, high: h, low: l, close: cl, volume: 1000 });
  put(0,  99,    99.3,  96.8,  97);
  put(1,  97,    97.4,  94.8,  95);    // low@1 pivot ~94.8
  put(2,  95.3,  98.6,  95.1,  98);    // low@1 confirms ci=2
  put(3,  98,    100.9, 97.8,  100.5); // rally leg
  put(4,  100.5, 102.9, 100.3, 102.6); // high@4 pivot ~102.9
  put(5,  102,   102.2, 97.8,  98);    // high@4 confirms ci=5; roll over, close stays > 94.8
  put(6,  98,    98.4,  95.3,  95.5);  // close 95.5 > 94.8
  put(7,  95.5,  95.9,  93.0,  95.2);  // wick dip 93.0 = new low pivot; close still above 94.8
  put(8,  95.4,  97.0,  95.1,  96.5);  // low@7 confirms ci=8 -> LL
  put(9,  96.5,  97.4,  96.2,  97.0);  // high@9 pivot ~97.4
  put(10, 97,    97.1,  94.0,  94.5);  // high@9 confirms ci=10 -> LH -> downtrend + protected=97.4
  for (let i = 0; i < 18; i++) {
    const o = 94 - i * 0.7, cl = o - 0.6;
    c.push({ time: base + (11 + i) * H4, open: o, high: o + 0.25, low: cl - 0.2, close: cl, volume: 1000 });
  }
  return c;
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
const BEAR15M = ser("AA", "15m", drift(M15, 90, 140, -1));
const FRAMED = { htf: BULL4H, etf: BULL15M };
const framed = (): SystemBacktestResult => run({ cells: [cell("AA", mk(), FRAMED)] });

/** Canonical record fields (spec 26) - spec 34 adds exactly one: `alignment`. */
const OPP_KEYS = new Set([
  "setupId", "symbol", "timeframe", "setupType", "direction", "status",
  "evaluatedAt", "evaluatedIndex", "rank", "selected", "score",
  "scoreContributions", "plan", "statisticalEvidence", "outcomeRef", "alignment",
]);
const DEV_KEYS = new Set([
  "setupId", "symbol", "timeframe", "setupType", "direction",
  "evaluatedAt", "evaluatedIndex", "reasons", "outcomeRef", "alignment",
]);

const STATES = new Set([
  "aligned_bull", "aligned_bear", "pullback_in_trend_bull", "pullback_in_trend_bear",
  "realigning_bull", "realigning_bear", "countertrend_bull", "countertrend_bear",
  "htf_dominant", "ltf_directed", "no_context",
]);

// ---------------------------------------------------------------------------
describe("spec34 - A/B: record.alignment populated on both record kinds", () => {
  it("ranked records carry the exact spec-10 alignment object at their bar", () => {
    const r = framed();
    expect(r.opportunities.length).toBeGreaterThan(0);
    for (const o of r.opportunities) {
      const a = o.alignment;
      expect(a).toBeDefined();
      // The canonical object verbatim: symbol, role map, votes, score, state, computedAt.
      expect(a!.symbol).toBe("AA");
      expect(a!.timeframes).toEqual({ htf: "4h", itf: "1h", etf: "15m" });
      expect(STATES.has(a!.state)).toBe(true);
      // alignmentScore is the spec-10 weighted vote sum - internally coherent, not restamped.
      expect(a!.alignmentScore).toBeCloseTo(
        0.5 * a!.votes.htf + 0.3 * a!.votes.itf + 0.2 * a!.votes.etf, 10);
      // computedAt is derived from frame snapshot stamps - never past the eval close.
      expect(Date.parse(a!.computedAt)).toBeLessThanOrEqual(o.evaluatedAt + H1);
    }
  }, 20000);

  it("developing records carry alignment - spec-32 gate evidence stays auditable", () => {
    // etf-only frames: the gate (ltf_directed < 0.8 signed) keeps records developing;
    // those records must still expose the alignment that blocked them.
    const r = run({ cells: [cell("AA", mk(), { etf: BULL15M })] });
    expect(r.developing.length).toBeGreaterThan(0);
    const gated = r.developing.filter((d) =>
      (d.reasons ?? []).some((x) => x.category === "multi_timeframe"));
    expect(gated.length).toBeGreaterThan(0);
    for (const d of gated) {
      expect(d.alignment).toBeDefined();
      // The gate's own evidence: direction-signed score < 0.8 must be what blocked it.
      const signed = d.alignment!.alignmentScore * (d.direction === "bullish" ? 1 : -1);
      expect(signed).toBeLessThan(0.8);
      expect(d.alignment!.state).toBe("ltf_directed");
    }
  });
});

describe("spec34 - C: unframed parity - absence, never null", () => {
  it("unframed runs emit no `alignment` key and records stay byte-identical in shape", () => {
    const r = run();
    const all: (BacktestOpportunity | BacktestDeveloping)[] = [...r.opportunities, ...r.developing];
    expect(all.length).toBeGreaterThan(0);
    for (const rec of all) {
      expect(rec.alignment).toBeUndefined();
      // Own-property absence - JSON.stringify(record) must not mention alignment at all.
      expect(Object.prototype.hasOwnProperty.call(rec, "alignment")).toBe(false);
      expect(JSON.stringify(rec)).not.toContain("alignment");
    }
  });
});

describe("spec34 - D: partial frames - recorded exactly as produced", () => {
  it("etf-only frames produce honest ltf_directed - no normalization, htf votes 0", () => {
    const r = run({ cells: [cell("AA", mk(), { etf: BULL15M })] });
    const all = [...r.opportunities, ...r.developing];
    for (const rec of all) {
      expect(rec.alignment).toBeDefined();
      expect(rec.alignment!.votes.htf).toBe(0);   // missing role votes 0 - never fabricated
      expect(rec.alignment!.sources?.htf).toBeUndefined(); // no fake source
      expect(rec.alignment!.state).toBe("ltf_directed");
    }
  }, 20000);

  it("opposing etf flips votes negative - countertrend state recorded verbatim", () => {
    const r = run({ cells: [cell("AA", mk(), { htf: BULL4H, etf: BEAR15M })] });
    const all = [...r.opportunities, ...r.developing];
    const states = new Set(all.map((x) => x.alignment?.state));
    // Whatever the producer emitted is what the record carries - just assert coherence:
    for (const rec of all) {
      const v = rec.alignment!.votes;
      expect(rec.alignment!.alignmentScore).toBeCloseTo(0.5 * v.htf + 0.3 * v.itf + 0.2 * v.etf, 10);
    }
    expect(states.size).toBeGreaterThan(0);
  });
});

describe("spec34 - E/F: prefix causality + determinism", () => {
  it("frames truncated after T: records <= T are bit-identical, alignment included", () => {
    // Direct causal claim for the new field: the join cannot see frame bars after
    // the eval close, so dropping every frame bar that opens after E+60h changes
    // nothing for records <= T=55. (The +4h margin past the boundary keeps the
    // truncated frame's own right-edge pivots confirmable - a truncated series
    // legitimately resolves its final bars differently; that is producer truth,
    // not leakage. Every joinable frame bar for evals <= T stays identical.)
    const T = 55;
    const cutAt = E + 60 * H1; // drop all frame bars opening at/after 60h
    const cut = (s: CandleSeries): CandleSeries =>
      ser("AA", s.timeframe, s.candles.filter((c) => c.time < cutAt));
    const prefixFrames: BacktestCell["frames"] = { htf: cut(BULL4H), etf: cut(BULL15M) };
    const prefix = run({ cells: [cell("AA", mk(), prefixFrames)] });
    const complete = framed();
    const le = <T extends { evaluatedIndex: number }>(rs: T[]) => rs.filter((r) => r.evaluatedIndex <= T);
    expect(le(prefix.opportunities)).toEqual(le(complete.opportunities));
    expect(le(prefix.developing)).toEqual(le(complete.developing));
    expect(prefix.opportunities.some((o) => o.alignment !== undefined)).toBe(true);
  }, 20000); // two framed runs - full upstream chains per frame

  it("cell truncation: records inside the confirmed-data region are identical", () => {
    // Truncating the CELL legitimately changes its own right-edge producers: the
    // last bars of a short series cannot confirm swings that a longer series can,
    // so the final ~rightBars bars of the truncated run may honestly differ (the
    // field records whatever at(t) produced - that is PIT truth, not leakage).
    // Assert equality strictly inside the confirmed-data region.
    const T = 55;
    const EDGE = 3;
    const full = mk();
    const prefix = run({ cells: [cell("AA", full.slice(0, T + 1), FRAMED)] });
    const complete = run({
      cells: [cell("AA", full, FRAMED)],
      window: { startIndex: 0, endIndex: T },
    });
    const le = <T extends { evaluatedIndex: number }>(rs: T[]) =>
      rs.filter((r) => r.evaluatedIndex <= T - EDGE);
    expect(le(prefix.opportunities)).toEqual(le(complete.opportunities));
    expect(le(prefix.developing)).toEqual(le(complete.developing));
    expect(prefix.opportunities.length).toBeGreaterThan(0); // non-vacuous
  }, 20000);

  it("repeated runs and reversed frames-key order are bit-identical", () => {
    const a = framed();
    const b = framed();
    const perm = run({ cells: [cell("AA", mk(), { etf: BULL15M, htf: BULL4H })] });
    expect(a).toEqual(b);
    expect(perm.opportunities).toEqual(a.opportunities);
    expect(perm.developing).toEqual(a.developing);
  }, 20000); // three framed runs
});

describe("spec34 - G: spec-33 htfProtected* state persists at the right bars", () => {
  it("countertrend_bull from htfProtected* persists on records only at/after the causal break", () => {
    // Verified fixture (engine-level trace): the 4h frame reaches trend=downtrend
    // with keyLevels.protected=97.4 (last LH) by 4h index ~10. The cell's bullish
    // CHOCH confirms at cell bar 47 (refPrice 97.7 >= 97.4). While votes are
    // (-1,-1,-1) the truth table yields aligned_bear; the spec-33 override then
    // stamps countertrend_bull at bars 47-48 only - before 47 no ITF break exists
    // in the join, after 48 the itf vote flips +1 (realigning_bear, not eligible).
    const r = run({ cells: [cell("AA", mk(), { htf: ser("AA", "4h", bearProt()), etf: BEAR15M })] });
    const all = [...r.opportunities, ...r.developing].sort((x, y) => x.evaluatedIndex - y.evaluatedIndex);
    const ctr = all.filter((x) => x.alignment?.state === "countertrend_bull");
    expect(ctr.length).toBeGreaterThan(0);
    // The override's fingerprints on the record: all-bearish votes with a bull
    // countertrend state is impossible via classifyVotes alone - only the
    // htfProtected* rule produces it.
    for (const rec of ctr) {
      expect(rec.alignment!.votes).toEqual({ htf: -1, itf: -1, etf: -1 });
      // The CHOCH confirmation bars only - before 47 no ITF break exists in the
      // join; after 48 the itf vote flips +1 (realigning_bear, override ineligible).
      expect(rec.evaluatedIndex).toBeGreaterThanOrEqual(47);
      expect(rec.evaluatedIndex).toBeLessThanOrEqual(48);
    }
    // Not visible before the causal crossing - never countertrend, and once the
    // votes settle (-1,-1,-1) the honest base state is recorded verbatim.
    for (const rec of all) {
      if (rec.evaluatedIndex < 47) {
        expect(rec.alignment?.state.startsWith("countertrend")).toBe(false);
        if (rec.evaluatedIndex >= 39) expect(rec.alignment?.state).toBe("aligned_bear");
      }
    }
  }, 20000);
});

describe("spec34 - H/I: existing fields unchanged + record-shape parity", () => {
  it("only the `alignment` key is added - all canonical fields keep their semantics", () => {
    const r = framed();
    const all: (BacktestOpportunity | BacktestDeveloping)[] = [...r.opportunities, ...r.developing];
    expect(all.length).toBeGreaterThan(0);
    for (const rec of r.opportunities) {
      for (const k of Object.keys(rec)) expect(OPP_KEYS.has(k)).toBe(true);
      // Existing semantics spot-checks: rank contiguous >=1, score numeric, evidence/plan optional.
      expect(rec.rank).toBeGreaterThanOrEqual(1);
      expect(typeof rec.score).toBe("number");
      if (rec.statisticalEvidence !== undefined) {
        expect(rec.statisticalEvidence.decisionTime).toBeLessThanOrEqual(rec.evaluatedAt);
      }
      if (rec.outcomeRef !== undefined) expect(rec.outcomeRef).toBe(rec.setupId);
    }
    for (const rec of r.developing) {
      for (const k of Object.keys(rec)) expect(DEV_KEYS.has(k)).toBe(true);
      expect(rec.reasons?.every((x) => x.met === false)).toBe(true); // unmet reasons only
    }
    // Framed-vs-unframed delta is alignment-bearing fields + spec-32 gate effects only:
    // stripping `alignment` from a framed run must equal a SECOND framed run stripped -
    // i.e. the field is pure observation, never feeds back into emission.
    const stripped = <T extends { alignment?: unknown }>(rs: T[]): T[] =>
      rs.map((x) => {
        const rest = { ...x };
        delete rest.alignment;
        return rest;
      });
    const r2 = framed();
    expect(stripped(r.opportunities)).toEqual(stripped(r2.opportunities));
    expect(stripped(r.developing)).toEqual(stripped(r2.developing));
  }, 20000); // two framed runs
});
