/**
 * Spec 30 — Statistical Evidence Composition (docs/engine/30-statistical-evidence-composition.md).
 *
 * Composition-only phase: wire the existing spec-24 producer `estimateProbability` into
 * `runBacktest` so scoreable `ScanCandidate`s carry `statisticalEvidence` — a per-setup,
 * confirmBar-anchored, resolution-gated (`resolvedAt < τ`) fact frozen at emit.
 *
 * The candle series is the same crafted 1h fixture as the spec-26/29 suites (bullish
 * reversal develops ~47, confirms ~49, activates ~56, resolves during the phase-D rally).
 * Cross-cell history: identical shape replayed at different wall-clock offsets lets one
 * cell's resolved rows seed another cell's cohort — spec-24 history is wall-clock gated,
 * not index-gated.
 */
import { describe, expect, it } from "vitest";
import type {
  BacktestCell,
  BacktestOpportunity,
  Candle,
  CandleSeries,
  EngineConfig,
  SetupOutcome,
  SystemBacktestResult,
} from "@/lib/types";
import { runBacktest } from "../backtest";

const E = Date.UTC(2024, 0, 1);
const H1 = 3_600_000;
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

/** Valid spec-24 stats config — edges must be ascending in [0,100] starting at 0. */
const STATS = { minSamples: 2, scoreBands: [0, 50, 70, 85], methodVersion: "v1-stats" };

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
  stats: STATS,
  scanner: { topK: 0, includeDeveloping: true, methodVersion: "v1-scan" },
  backtest: { methodVersion: "v1-bt" },
};

/** expandAtrTrend ≈ 0 forces `high_volatility` whenever momentum features carry atrTrend. */
const FORCED_HV = { expandAtrTrend: 0.01, compressAtrTrend: 0.005, atrLength: 5, atrLookback: 10, minBars: 10 };

/** Same candle shape at a wall-clock offset — cross-cell cohort history (spec-24 gates on
 *  wall-clock `resolvedAt`, never bar index). */
const shift = (candles: Candle[], hours: number): Candle[] =>
  candles.map((k) => ({ ...k, time: k.time + hours * H1 }));

const cell = (symbol: string, candles: Candle[]): BacktestCell => ({
  symbol,
  timeframe: "1h",
  series: { symbol, timeframe: "1h", candles } as CandleSeries,
});

const run = (over: Partial<Parameters<typeof runBacktest>[0]> = {}): SystemBacktestResult => {
  const res = runBacktest({ cells: [cell("AA", mk())], config: CFG, ...over });
  if (!res.ok || res.data === undefined) throw new Error(`run failed: ${JSON.stringify(res.errors)}`);
  return res.data;
};

/** Eligible history at τ per spec-24 E1–E4 over the run's own outcome rows. */
const eligibleAt = (outcomes: SetupOutcome[], tau: number): SetupOutcome[] => {
  const superseded = new Set(
    outcomes.map((r) => r.supersedes).filter((x): x is string => typeof x === "string"),
  );
  return outcomes.filter(
    (r) =>
      r.unresolved !== true &&
      r.resolvedAt !== undefined &&
      Date.parse(r.resolvedAt) < tau &&
      r.paramsVersion === CFG.version &&
      !superseded.has(r.setupId),
  );
};

const bandOf = (score: number, edges: number[]): number => {
  let i = -1;
  for (const e of edges) if (score >= e) i++;
  return i;
};
const bandLabel = (i: number, edges: number[]): string =>
  `${edges[i]}-${i + 1 < edges.length ? edges[i + 1] - 1 : 100}`;

const bRow = (r: SystemBacktestResult): SetupOutcome =>
  r.outcomes.find((o) => o.setupId.startsWith("rev:BB:")) ??
  (() => { throw new Error("BB outcome row missing"); })();

const bRecs = (r: SystemBacktestResult): BacktestOpportunity[] =>
  r.opportunities.filter((o) => o.setupId.startsWith("rev:BB:"));

// ---------------------------------------------------------------------------
describe("spec30 — evidence population & anchors", () => {
  // AA resolves ~E+55h, CC ~E+415h; BB (shifted +720h) confirms ~E+769h → both are
  // E2-eligible (resolvedAt < τ). ZZ (+1500h) resolves long after BB's τ — exists only
  // to prove E2 future-exclusion.
  const cells3 = () => [cell("AA", mk()), cell("CC", shift(mk(), 360)), cell("BB", shift(mk(), 720))];

  it("A: scoreable candidates carry statisticalEvidence with a real estimate", () => {
    const r = run({ cells: cells3() });
    const recs = bRecs(r);
    expect(recs.length).toBeGreaterThan(0);
    const ev = recs[0].statisticalEvidence;
    expect(ev).toBeDefined();
    expect(ev!.estimate).toBeDefined();
    expect(ev!.estimate!.sampleSize).toBeGreaterThanOrEqual(STATS.minSamples);
    expect(ev!.estimate!.pTarget[0]).toBeGreaterThanOrEqual(ev!.estimate!.pTarget[1]);
    expect(ev!.estimate!.pTarget[1]).toBeGreaterThanOrEqual(ev!.estimate!.pTarget[2]);
  });

  it("B: insufficient history degrades to {decisionTime, unavailable: insufficient_data}", () => {
    const r = run({ cells: [cell("BB", shift(mk(), 720))] }); // no earlier history
    const recs = bRecs(r);
    expect(recs.length).toBeGreaterThan(0);
    for (const rec of recs) {
      const ev = rec.statisticalEvidence;
      if (ev === undefined) continue; // honest absence also permitted
      expect(ev.estimate).toBeUndefined();
      expect(ev.unavailable).toBe("insufficient_data");
    }
    expect(recs.some((rec) => rec.statisticalEvidence?.unavailable === "insufficient_data")).toBe(true);
  });

  it("C: decisionTime anchors at confirmBar — equals row.confirmedAt, ≤ evaluatedAt", () => {
    const r = run({ cells: cells3() });
    const row = bRow(r);
    const tau = Date.parse(row.confirmedAt!);
    for (const rec of bRecs(r)) {
      const ev = rec.statisticalEvidence;
      expect(ev).toBeDefined();
      expect(ev!.decisionTime).toBe(tau);
      expect(ev!.decisionTime).toBeLessThanOrEqual(rec.evaluatedAt);
      // records persist past confirmBar — anchor stays confirmBar, never eval t
      if (rec.evaluatedAt > tau) expect(ev!.decisionTime).toBeLessThan(rec.evaluatedAt);
    }
    expect(bRecs(r).some((rec) => rec.evaluatedAt > tau)).toBe(true); // non-trivial
  });

  it("developing records never carry evidence", () => {
    const r = run({ cells: cells3() });
    for (const d of r.developing) expect("statisticalEvidence" in d).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("spec30 — cohort axes", () => {
  const cells3 = () => [cell("AA", mk()), cell("CC", shift(mk(), 360)), cell("BB", shift(mk(), 720))];

  it("D: regime axis uses the confirmBar regime (forced high_volatility witness)", () => {
    const r = run({ cells: cells3(), config: { ...CFG, regime: FORCED_HV } });
    const row = bRow(r);
    expect(row.regime).toBe("high_volatility");
    const ev = bRecs(r)[0].statisticalEvidence;
    expect(ev?.estimate).toBeDefined();
    if (ev!.estimate!.cohortLevel === 0) {
      expect(ev!.estimate!.cohortKey).toContain("reg=high_volatility");
    } else {
      // deeper levels drop the axis per the fixed ladder — never a different value
      expect(ev!.estimate!.cohortKey).not.toMatch(/reg=(?!high_volatility)/);
    }
  });

  it("E: scoreBand axis derives from scoreAtConfirmation, not the eval-time score", () => {
    const r = run({ cells: cells3() });
    const row = bRow(r);
    const ev = bRecs(r)[0].statisticalEvidence;
    expect(ev?.estimate).toBeDefined();
    const est = ev!.estimate!;
    if (est.cohortLevel <= 3) {
      // every level ≤ L3 constrains the sb axis — it must match the band of the row's
      // scoreAtConfirmation (the confirmBar score), not any later evaluation score.
      const expected = bandLabel(bandOf(row.scoreAtConfirmation, STATS.scoreBands), STATS.scoreBands);
      expect(est.cohortKey).toContain(`sb=${expected}`);
    }
  });
});

// ---------------------------------------------------------------------------
describe("spec30 — causality & contamination", () => {
  const cells3 = () => [cell("AA", mk()), cell("CC", shift(mk(), 360)), cell("BB", shift(mk(), 720))];
  const cells4 = () => [...cells3(), cell("ZZ", shift(mk(), 1500))];

  it("F: the candidate's own outcome row is excluded from its cohort", () => {
    const r = run({ cells: cells3() });
    const row = bRow(r);
    // BB's row is resolved — if it leaked, sampleSize would exceed the eligible count.
    expect(row.unresolved).not.toBe(true);
    const evidence = bRecs(r)[0].statisticalEvidence!;
    const ev = evidence.estimate!;
    const eligible = eligibleAt(r.outcomes, evidence.decisionTime);
    expect(eligible.some((o) => o.setupId === row.setupId)).toBe(false); // E2: own τ-gate
    expect(ev.sampleSize).toBeLessThanOrEqual(eligible.length);
    if (ev.cohortKey === "*") expect(ev.sampleSize).toBe(eligible.length);
  });

  it("G: rows resolving after τ cannot alter evidence — adding a future cell changes nothing", () => {
    const without = run({ cells: cells3() });
    const withFuture = run({ cells: cells4() });
    // non-triviality: ZZ really produced resolved outcome rows in the full dataset
    const zzRows = withFuture.outcomes.filter((o) => o.setupId.includes(":ZZ:"));
    expect(zzRows.length).toBeGreaterThan(0);
    for (const rec of bRecs(without)) {
      const twin = bRecs(withFuture).find(
        (o) => o.setupId === rec.setupId && o.evaluatedIndex === rec.evaluatedIndex,
      );
      expect(twin).toBeDefined();
      expect(twin!.statisticalEvidence).toEqual(rec.statisticalEvidence);
    }
  });

  it("H: prefix [0..T] vs full series — identical evidence for records ≤ T", () => {
    const T = 50; // spec-26/29 proven-safe boundary: post-candidate, post-confirm
    const prefix = run({
      cells: [cell("AA", mk()), cell("CC", shift(mk(), 360)), cell("BB", shift(mk(), 720).slice(0, T + 1))],
      window: { startIndex: 0, endIndex: T },
    });
    const full = run({ cells: cells3(), window: { startIndex: 0, endIndex: T } });
    const pRecs = bRecs(prefix);
    const fRecs = bRecs(full);
    expect(pRecs.length).toBeGreaterThan(0);
    expect(pRecs.map((r) => r.statisticalEvidence)).toEqual(fRecs.map((r) => r.statisticalEvidence));
    // non-triviality: the full run contains extra resolved rows the prefix never saw —
    // BB's own resolution happens after the cut.
    const pRow = prefix.outcomes.find((o) => o.setupId.startsWith("rev:BB:"));
    const fRow = full.outcomes.find((o) => o.setupId.startsWith("rev:BB:"));
    if (pRow !== undefined && fRow !== undefined) {
      expect(pRow.unresolved === true || pRow.rMultiple !== fRow.rMultiple).toBe(true);
    }
  });

  it("I: evidence is fixed per setup — identical on every record it appears on", () => {
    const r = run({ cells: cells3() });
    const byId = new Map<string, unknown>();
    for (const o of r.opportunities) {
      if (o.statisticalEvidence === undefined) continue;
      const prev = byId.get(o.setupId);
      if (prev === undefined) byId.set(o.setupId, o.statisticalEvidence);
      else expect(o.statisticalEvidence).toEqual(prev); // frozen, memoized, unchanging
    }
    expect(byId.size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("spec30 — determinism & degradation", () => {
  const cells3 = () => [cell("AA", mk()), cell("CC", shift(mk(), 360)), cell("BB", shift(mk(), 720))];

  it("J: identical runs produce identical evidence; permuted cells identical", () => {
    const a = run({ cells: cells3() });
    const b = run({ cells: cells3() });
    expect(a.opportunities.map((o) => o.statisticalEvidence))
      .toEqual(b.opportunities.map((o) => o.statisticalEvidence));
    const rev = run({ cells: [cell("BB", shift(mk(), 720)), cell("CC", shift(mk(), 360)), cell("AA", mk())] }); // reversed input
    expect(rev.opportunities.map((o) => [o.setupId, o.evaluatedIndex, o.statisticalEvidence]))
      .toEqual(a.opportunities.map((o) => [o.setupId, o.evaluatedIndex, o.statisticalEvidence]));
  });

  it("K: invalid stats config → diagnostics count, honest absence, run survives", () => {
    const res = runBacktest({
      cells: cells3(),
      config: { ...CFG, stats: { minSamples: 2, scoreBands: [40, 60, 80], methodVersion: "v1-stats" } },
    });
    expect(res.ok).toBe(true);
    const r = res.data!;
    for (const o of r.opportunities) expect(o.statisticalEvidence).toBeUndefined();
    const diag = res.meta.diagnostics as Record<string, unknown> | undefined;
    expect(diag?.statsFailures).toBeGreaterThan(0);
    // never mislabeled as insufficient_data — invalid config is not missing history
    expect(r.opportunities.some((o) => o.statisticalEvidence?.unavailable === "insufficient_data")).toBe(false);
  });
});
