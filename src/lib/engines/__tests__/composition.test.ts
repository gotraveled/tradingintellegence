/**
 * Spec 29 — Pipeline Composition (docs/engine/29-pipeline-composition.md).
 *
 * Composition-only phase: wire the spec-27 regime producer and the spec-28 plan
 * producer into the existing `runBacktest` at(t) join. The candle series is the same
 * crafted 1h fixture as the spec-26 suite (bullish reversal develops ~47, confirms ~49,
 * activates ~56, resolves during the phase-D rally; two late bearish setups cancel) so
 * every assertion rides the REAL upstream pipeline — nothing is fabricated.
 */
import { describe, expect, it } from "vitest";
import type {
  BacktestCell,
  Candle,
  CandleSeries,
  EngineConfig,
  SystemBacktestResult,
  TradePlan,
} from "@/lib/types";
import { runBacktest } from "../backtest";
import { toScanPlan } from "../trade-plan";

const E = Date.UTC(2024, 0, 1);
const H1 = 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  time: E + i * H1, open: o, high: h, low: l, close: c, volume: 1000,
});

const mk = (): Candle[] => {
  const c: Candle[] = [];
  const a: [number, number][] = [
    [100, 101], [101, 102], [102, 103], [103, 104], [104, 102.6],
    [102.7, 103.5], [103.5, 104.5], [104.5, 105.5], [105.5, 107], [107, 105.6],
    [105.7, 106.5], [106.5, 107.5], [107.5, 108.5], [108.5, 110], [110, 108.6],
    [108.7, 109.5], [109.5, 110.5], [110.5, 111.5], [111.5, 112.5], [112.5, 113],
    [113, 111.8], [111.9, 112.4], [112.4, 113], [113, 113.5], [113.5, 112.6],
    [112.7, 113], [113, 113.8], [113.8, 114.3], [114.3, 113.9], [113.9, 114.2],
  ];
  a.forEach(([o, cl], i) => c.push(bar(i, o, Math.max(o, cl) + 0.4, Math.min(o, cl) - 0.3, cl)));
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
    if (30 + i === 43) c.push(bar(43, o, Math.max(o, cl) + 0.3, 94.8, cl));
    else c.push(bar(30 + i, o, Math.max(o, cl) + 0.3, Math.min(o, cl) - 0.5, cl));
  });
  const d: [number, number][] = [
    [95.9, 96.8], [96.8, 99], [99, 101.5], [101.5, 104], [104, 106.5], [106.5, 109],
    [109, 111], [111, 112.8], [112.8, 113], [113, 112.7],
  ];
  d.forEach(([o, cl], i) => c.push(bar(46 + i, o, Math.max(o, cl) + 0.2, Math.min(o, cl) - 0.2, cl)));
  const e: [number, number][] = [
    [112.7, 113.4], [113.4, 114.2], [114.2, 115], [115, 115.8], [115.8, 116.5],
    [116.5, 117.2], [117.2, 118], [118, 118.6], [118.6, 119], [119, 119.3],
  ];
  e.forEach(([o, cl], i) => {
    if (56 + i === 56) c.push(bar(56, o, Math.max(o, cl) + 0.2, 96.0, cl));
    else c.push(bar(56 + i, o, Math.max(o, cl) + 0.2, Math.min(o, cl) - 0.2, cl));
  });
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
  stats: { minSamples: 2, scoreBands: [40, 60, 80], methodVersion: "v1-stats" },
  scanner: { topK: 0, includeDeveloping: true, methodVersion: "v1-scan" },
  backtest: { methodVersion: "v1-bt" },
};

/** expandAtrTrend ≈ 0 forces `high_volatility` (family "expanding") whenever momentum
 *  features carry a defined atrTrend — deterministic non-transition regime. */
const FORCED_HV = { expandAtrTrend: 0.01, compressAtrTrend: 0.005, atrLength: 5, atrLookback: 10, minBars: 10 };
/** Non-unity factors for every setup family under the "expanding" regime family. */
const MATRIX = {
  expanding: {
    reversal: { structure: 0.5, momentum: 1.5 },
    breakout: { structure: 0.5, momentum: 1.5 },
    continuation: { structure: 0.5, momentum: 1.5 },
  },
};
const INVALID_REGIME = { expandAtrTrend: -1, compressAtrTrend: 0.8, atrLength: 5, atrLookback: 10, minBars: 10 };

const cell = (symbol = "T", timeframe: "1h" = "1h", candles: Candle[] = mk()): BacktestCell => ({
  symbol,
  timeframe,
  series: { symbol, timeframe, candles } as CandleSeries,
});

const run = (over: Partial<Parameters<typeof runBacktest>[0]> = {}): SystemBacktestResult => {
  const res = runBacktest({ cells: [cell()], config: CFG, ...over });
  if (!res.ok || res.data === undefined) throw new Error(`run failed: ${JSON.stringify(res.errors)}`);
  return res.data;
};

const mkPlan = (over: Partial<TradePlan> = {}): TradePlan => ({
  setupId: "s1", symbol: "T", timeframe: "1h", direction: "bullish",
  entryZone: { low: 100, high: 102, basis: "demand zone proximal band" },
  invalidation: { price: 98, basis: "below zone low", closeOnly: true },
  targets: [
    { label: "T1", price: 104 },
    { label: "T2", price: 110, reached: true },
    { label: "T3", price: 118 },
  ],
  riskReward: 4.5,
  score: 72,
  scoreContributions: [],
  reasons: [],
  expiryBars: 200,
  createdAt: "2024-01-01T00:00:00.000Z",
  paramsVersion: "v1",
  ...over,
});

// ---------------------------------------------------------------------------
describe("spec29 — toScanPlan projection", () => {
  it("projects a bullish plan: midpoint entry, invalidation stop, targets/RR verbatim", () => {
    const p = mkPlan();
    const sp = toScanPlan(p);
    expect(sp.entry).toBe(101);
    expect(sp.stopLoss).toBe(98);
    expect(sp.targets).toBe(p.targets); // pass-through, not copied
    expect(sp.riskReward).toBe(4.5);
  });

  it("projects a bearish plan with mirrored midpoint", () => {
    const p = mkPlan({
      direction: "bearish",
      entryZone: { low: 99, high: 100, basis: "supply zone distal band" },
      invalidation: { price: 103, basis: "above zone high", closeOnly: true },
      riskReward: 2.25,
    });
    const sp = toScanPlan(p);
    expect(sp.entry).toBe(99.5);
    expect(sp.stopLoss).toBe(103);
    expect(sp.riskReward).toBe(2.25);
  });

  it("computes the midpoint for asymmetric bands", () => {
    expect(toScanPlan(mkPlan({ entryZone: { low: 100, high: 101.4, basis: "b" } })).entry).toBeCloseTo(100.7);
  });

  it("passes an absent riskReward through as absent", () => {
    expect(toScanPlan(mkPlan({ riskReward: undefined })).riskReward).toBeUndefined();
  });

  it("never mutates the source TradePlan", () => {
    const p = mkPlan();
    const snap = JSON.parse(JSON.stringify(p));
    toScanPlan(p);
    expect(p).toEqual(snap);
  });
});

// ---------------------------------------------------------------------------
describe("spec29 — runBacktest plan wiring", () => {
  it("every ranked record carries a populated ScanPlan (spec-16 evidence at that bar)", () => {
    const r = run();
    expect(r.opportunities.length).toBeGreaterThan(0);
    for (const o of r.opportunities) {
      expect(o.plan).toBeDefined();
      expect(o.plan!.entry).toEqual(expect.any(Number));
      expect(o.plan!.stopLoss).toEqual(expect.any(Number));
      expect(o.plan!.stopLoss).not.toBe(o.plan!.entry);
      expect(o.plan!.targets!.length).toBeGreaterThan(0);
      expect(o.plan!.riskReward).toEqual(expect.any(Number));
    }
  });

  it("plan exists only from the confirmation bar — developing/pre-confirm bars have none", () => {
    const r = run();
    // A resolved setup: developing window strictly precedes its first ranked observation.
    const withOutcome = r.opportunities.filter((o) => o.outcomeRef !== undefined);
    expect(withOutcome.length).toBeGreaterThan(0);
    const id = withOutcome[0].setupId;
    const firstRanked = Math.min(
      ...r.opportunities.filter((o) => o.setupId === id).map((o) => o.evaluatedIndex),
    );
    const devBars = r.developing.filter((d) => d.setupId === id).map((d) => d.evaluatedIndex);
    expect(devBars.length).toBeGreaterThan(0);
    expect(Math.max(...devBars)).toBeLessThan(firstRanked); // confirmBar−1 → developing, no plan
  });

  it("target `reached` flags are evaluated per-bar, never from the terminal artifact", () => {
    const r = run();
    const byId = new Map<string, typeof r.opportunities>();
    for (const o of r.opportunities) {
      byId.set(o.setupId, [...(byId.get(o.setupId) ?? []), o]);
    }
    let sawUnreachedThenReached = false;
    for (const recs of byId.values()) {
      const ordered = [...recs].sort((a, b) => a.evaluatedIndex - b.evaluatedIndex);
      const nT = Math.max(...ordered.map((o) => o.plan?.targets?.length ?? 0));
      for (let i = 0; i < nT; i++) {
        let seen = false;
        for (const o of ordered) {
          const reached = o.plan?.targets?.[i]?.reached === true;
          if (seen) expect(reached).toBe(true); // monotone — once reached, never reverts
          if (reached) seen = true;
        }
        if (ordered.some((o) => o.plan?.targets?.[i]?.reached === false)
            && ordered.some((o) => o.plan?.targets?.[i]?.reached === true)) {
          sawUnreachedThenReached = true;
        }
      }
    }
    expect(sawUnreachedThenReached).toBe(true); // fixture's resolved setup reaches T1 mid-window
  });
});

// ---------------------------------------------------------------------------
describe("spec29 — regime wiring into at(t)", () => {
  const base = run();

  it("configured regimeMatrix + non-transition regime modulates scores", () => {
    const mod = run({
      config: { ...CFG, regime: FORCED_HV, scoring: { ...CFG.scoring, regimeMatrix: MATRIX } },
    });
    expect(mod.opportunities.length).toBeGreaterThan(0);
    const key = (o: { setupId: string; evaluatedIndex: number }) => `${o.setupId}@${o.evaluatedIndex}`;
    const baseByKey = new Map(base.opportunities.map((o) => [key(o), o]));
    let observed = 0;
    for (const o of mod.opportunities) {
      const b = baseByKey.get(key(o));
      if (b === undefined || b.score === undefined) continue;
      expect(o.score).not.toBe(b.score); // identical join except regime → score must shift
      observed++;
    }
    expect(observed).toBeGreaterThan(0);
  });

  it("absent regimeMatrix → regime has no effect on scores (transparent wiring)", () => {
    const same = run({ config: { ...CFG, regime: FORCED_HV } });
    expect(same.opportunities.map((o) => [o.setupId, o.evaluatedIndex, o.score]))
      .toEqual(base.opportunities.map((o) => [o.setupId, o.evaluatedIndex, o.score]));
  });

  it("invalid regime config degrades to transition → no fabricated modulation, run unaffected", () => {
    const bad = run({
      config: { ...CFG, regime: INVALID_REGIME, scoring: { ...CFG.scoring, regimeMatrix: MATRIX } },
    });
    expect(bad.opportunities.map((o) => [o.setupId, o.evaluatedIndex, o.score]))
      .toEqual(base.opportunities.map((o) => [o.setupId, o.evaluatedIndex, o.score]));
  });
});

// ---------------------------------------------------------------------------
describe("spec29 — outcome anchors (regime @ confirmBar, scoreAtDetection @ candidateBar)", () => {
  it("outcome rows carry regime + scoreAtDetection + scoreAtConfirmation", () => {
    const r = run();
    expect(r.outcomes.length).toBeGreaterThan(0);
    for (const o of r.outcomes) {
      expect(o.regime).toEqual(expect.any(String));
      expect(o.scoreAtDetection).toEqual(expect.any(Number));
      expect(o.scoreAtConfirmation).toEqual(expect.any(Number));
    }
  });

  it("outcome.regime equals the join's regime at confirmBar (forced-regime witness)", () => {
    const r = run({ config: { ...CFG, regime: FORCED_HV } });
    for (const o of r.outcomes) expect(o.regime).toBe("high_volatility");
  });
});

// ---------------------------------------------------------------------------
describe("spec29 — deferred surfaces stay untouched", () => {
  // Spec-30 wires statisticalEvidence — with this suite's invalid scoreBands
  // ([40,60,80] lacks the required 0 edge) the estimate degrades to honest absence.
  // Assert the contract, not the accident: absent OR well-formed, never fabricated.
  it("statisticalEvidence is absent or a well-formed spec-24 shape — never fabricated", () => {
    const r = run();
    for (const o of r.opportunities) {
      const ev = o.statisticalEvidence;
      if (ev === undefined) continue;
      expect(typeof ev.decisionTime).toBe("number");
      expect(ev.decisionTime).toBeLessThanOrEqual(o.evaluatedAt);
      expect(ev.estimate !== undefined || ev.unavailable === "insufficient_data").toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe("spec29 — prefix/full causality", () => {
  // cut=50 — the spec-26 suite's proven-safe truncation boundary: post-candidate (47)
  // and post-confirm (49), so the bullish setup carries both stamped anchors in the
  // prefix, yet clear of the series tail where rightBars swing confirmation makes
  // upstream structure legitimately diverge between prefix and full series.
  const T = 50;

  const strip = <R extends { outcomeRef?: unknown }>(o: R): Omit<R, "outcomeRef"> => {
    const { outcomeRef, ...rest } = o;
    void outcomeRef; // outcome rows legitimately differ under Model B
    return rest;
  };

  it("evaluation records at ≤T are identical between prefix series and full series", () => {
    const prefix = run({
      cells: [cell("T", "1h", mk().slice(0, T + 1))],
      window: { startIndex: 0, endIndex: T },
    });
    const full = run({ window: { startIndex: 0, endIndex: T } });
    expect(full.opportunities.length).toBeGreaterThan(0);
    expect(prefix.opportunities.map(strip)).toEqual(full.opportunities.map(strip));
    expect(prefix.developing.map(strip)).toEqual(full.developing.map(strip));
  });

  it("outcome anchor fields (regime/scoreAtDetection/scoreAtConfirmation) are prefix/full identical", () => {
    const prefix = run({
      cells: [cell("T", "1h", mk().slice(0, T + 1))],
      window: { startIndex: 0, endIndex: T },
    });
    const full = run({ window: { startIndex: 0, endIndex: T } });
    const anchor = (o: { setupId: string; regime?: string; scoreAtDetection?: number; scoreAtConfirmation: number }) =>
      ({ regime: o.regime, scoreAtDetection: o.scoreAtDetection, scoreAtConfirmation: o.scoreAtConfirmation });
    const pById = new Map(prefix.outcomes.map((o) => [o.setupId, o]));
    let compared = 0;
    for (const o of full.outcomes) {
      const p = pById.get(o.setupId);
      if (p === undefined) continue;
      expect(anchor(p)).toEqual(anchor(o));
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
    // non-triviality: the prefix outcome really was truncated (unresolved vs resolved)
    const drift = full.outcomes.some((o) => {
      const p = pById.get(o.setupId);
      return p !== undefined && (p.unresolved === true || p.rMultiple !== o.rMultiple);
    });
    expect(drift).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("spec29 — determinism", () => {
  it("two identical runBacktest calls produce identical results", () => {
    const a = run();
    const b = run();
    expect({ opportunities: a.opportunities, developing: a.developing, outcomes: a.outcomes })
      .toEqual({ opportunities: b.opportunities, developing: b.developing, outcomes: b.outcomes });
  });
});
