/**
 * Historical Scenario Validation — deterministic tests (hv1 contract).
 *
 * Synthetic fixtures with KNOWN outcomes: crafted Setup artifacts carry the
 * lifecycle stamps the canonical detectors would emit (confirmBar, activeBar,
 * entryBand, invalidation, targets, terminal stamps). Outcome semantics are
 * exercised through the canonical spec-17 measureOutcome — these tests verify
 * the product layer's windowing, status, cost, and disclosure rules, NOT the
 * engine's detection (already proven by the canonical suites).
 */
import { describe, expect, it } from "vitest";
import type { BacktestCell, Candle, CandleSeries, Setup, SystemBacktestResult } from "@/lib/types";
import {
  aggregateScenarios,
  analyzeBoundaryLeakage,
  analyzeDependence,
  blockBootstrapMean,
  BOUNDARY_PURGE_RULE,
  computeUncertainty,
  evaluateScenario,
  meanTInterval,
  movingBlockResampleIndices,
  mulberry32,
  purgeCohortSlice,
  runCostSensitivity,
  runHistoricalValidation,
  runHorizonSensitivity,
  walkForwardStatus,
  wilsonInterval,
  type SplitAggregate,
  type ValidatedScenario,
  type ValidationRunConfig,
} from "../historical-validation";
import { defaultConfig } from "../engine-defaults";

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const BAR = 60_000;

const mkCandles = (specs: [number, number, number, number][]): Candle[] =>
  specs.map(([o, h, l, c], i) => ({
    time: BASE + i * BAR,
    open: o, high: h, low: l, close: c,
  }));

/** Flat drift baseline + per-bar overrides — keeps fixtures readable. */
const series = (n: number, start = 100, step = 0.5): Candle[] => {
  const specs: [number, number, number, number][] = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const nc = c + step;
    specs.push([c, Math.max(c, nc) + 0.2, Math.min(c, nc) - 0.2, nc]);
    c = nc;
  }
  return specs && mkCandles(specs);
};

const mkSetup = (meta: Setup["metadata"], over: Partial<Setup> = {}): Setup => ({
  id: over.id ?? "s1",
  symbol: "SYN",
  timeframe: "1m",
  type: "reversal",
  direction: "bullish",
  score: 70,
  status: "confirmed",
  reasons: [],
  createdAt: new Date(BASE).toISOString(),
  metadata: meta,
  ...over,
});

const BASE_CFG: ValidationRunConfig = { horizonBars: 10 };

const bull = (meta: Partial<Record<string, string | number | boolean>> = {}) =>
  mkSetup({
    confirmBar: 2,
    entryBandLow: 100, entryBandHigh: 101,
    invalidation: 98,
    targets: "110",
    ...meta,
  });

// ---------------------------------------------------------------------------
// Frozen artifact — anchor-time information never reshaped by future candles
// ---------------------------------------------------------------------------

describe("frozen scenario artifact", () => {
  it("same anchor produces identical scenario fields under different futures", () => {
    const rising = series(20);
    const crashing = mkCandles(
      series(6).map((c) => [c.open, c.high, c.low, c.close] as [number, number, number, number])
        .concat(Array.from({ length: 14 }, (_, i) => [90 - i, 90 - i, 88 - i, 89 - i] as [number, number, number, number])),
    );
    const s = bull({ activeBar: 4, targetReachedBar: 5, targetBars: "5" });
    const a = evaluateScenario({ setup: s, candles: rising, config: BASE_CFG });
    const b = evaluateScenario({ setup: s, candles: crashing, config: BASE_CFG });
    // The frozen artifact is invariant under whatever came after the anchor —
    // scenario fields are stamps verbatim; only measured outcome fields may vary.
    expect(a.scenario).toEqual(b.scenario);
    expect(a.anchorBar).toBe(b.anchorBar);
    expect(a.anchorTime).toBe(b.anchorTime);
    expect(a.direction).toBe(b.direction);
    expect(a.status).toBe("target"); // stamp-anchored status — evaluated on its own candles
  });
});

// ---------------------------------------------------------------------------
// Status taxonomy — entry/stop/target/expiry/censoring
// ---------------------------------------------------------------------------

describe("outcome statuses", () => {
  it("target inside the window → status target with canonical fill at proximal edge", () => {
    const s = bull({ activeBar: 4, targetReachedBar: 6, targetBars: "6" });
    const r = evaluateScenario({ setup: s, candles: series(20), config: BASE_CFG });
    expect(r.status).toBe("target");
    expect(r.entryPrice).toBe(101); // proximal edge for a bullish band, never the open
    expect(r.initialRisk).toBeCloseTo(3, 10);
    expect(r.targetsReached).toBe(1);
    expect(r.grossR).toBeGreaterThan(0);
  });

  it("invalidation inside the window → status stop, grossR < 0", () => {
    const candles = series(20);
    candles[7] = { ...candles[7], open: 102.5, high: 102.8, low: 97.0, close: 97.4 };
    const s = bull({ activeBar: 4, invalidatedBar: 7 });
    const r = evaluateScenario({ setup: s, candles, config: BASE_CFG });
    expect(r.status).toBe("stop");
    expect(r.grossR).toBeLessThan(0);
  });

  it("same-bar stop+target resolves to the conservative worst outcome (stop)", () => {
    const s = bull({ activeBar: 4, targetReachedBar: 7, invalidatedBar: 7, targetBars: "7" });
    const r = evaluateScenario({ setup: s, candles: series(20), config: BASE_CFG });
    expect(r.status).toBe("stop"); // never the favorable ordering
  });

  it("activated but unresolved at the horizon → censored, marked-to-market", () => {
    const s = bull({ activeBar: 4 });
    const r = evaluateScenario({ setup: s, candles: series(20), config: { horizonBars: 5 } });
    expect(r.status).toBe("censored");
    expect(r.resolvedBar).toBe(7); // cb=2 + horizon=5
    expect(r.entryPrice).toBe(101);
    expect(r.grossR).toBeDefined();
  });

  it("expiry beyond the horizon is invisible → censored, not expired", () => {
    const s = bull({ activeBar: 4, expiredBar: 15 });
    const r = evaluateScenario({ setup: s, candles: series(20), config: { horizonBars: 5 } });
    expect(r.status).toBe("censored");
  });

  it("target beyond the horizon is never credited", () => {
    const s = bull({ activeBar: 4, targetReachedBar: 12, targetBars: "12" });
    const r = evaluateScenario({ setup: s, candles: series(20), config: { horizonBars: 5 } });
    expect(r.status).toBe("censored");
    expect(r.targetsReached).toBe(0);
  });

  it("never activated → not_filled with zero PnL, never a win/loss", () => {
    const s = bull(); // no activeBar stamp
    const r = evaluateScenario({ setup: s, candles: series(20), config: BASE_CFG });
    expect(r.status).toBe("not_filled");
    expect(r.entryPrice).toBeUndefined();
    expect(r.grossR).toBe(0);
  });

  it("expired before activation reports expired, not a trade", () => {
    const s = bull({ expiredBar: 6 });
    const r = evaluateScenario({ setup: s, candles: series(20), config: BASE_CFG });
    expect(r.status).toBe("expired");
    expect(r.entryPrice).toBeUndefined();
  });

  it("entry deadline caps activation — late fill is not_filled", () => {
    const s = bull({ activeBar: 9 });
    const r = evaluateScenario({
      setup: s, candles: series(20),
      config: { horizonBars: 15, entryDeadlineBars: 5 },
    });
    expect(r.status).toBe("not_filled"); // activeBar 9 > cb 2 + deadline 5
  });

  it("a scenario anchored on the last bar has no forward data → unevaluable", () => {
    const s = bull({ confirmBar: 19 });
    const r = evaluateScenario({ setup: s, candles: series(20), config: BASE_CFG });
    expect(r.status).toBe("unevaluable");
  });
});

// ---------------------------------------------------------------------------
// Entry gate — no credit without activation
// ---------------------------------------------------------------------------

describe("entry-before-outcome gate", () => {
  it("a target stamp without activation can never credit a win", () => {
    const s = bull({ targetReachedBar: 7, targetBars: "7" }); // no activeBar
    const r = evaluateScenario({ setup: s, candles: series(20), config: BASE_CFG });
    expect(r.entryPrice).toBeUndefined();
    expect(r.status).not.toBe("target");
    expect(r.grossR ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gap + fill conventions
// ---------------------------------------------------------------------------

describe("gap and fill conventions", () => {
  it("a gap bar spanning the band activates at the proximal edge, not the open", () => {
    // Bullish scenario: bar 4 opens at 104 (above band) — gap through counts.
    const candles = series(20);
    candles[4] = { ...candles[4], open: 104, high: 105, low: 103.5, close: 104.5 };
    const s = bull({ activeBar: 4, targetReachedBar: 6, targetBars: "6" });
    const r = evaluateScenario({ setup: s, candles, config: BASE_CFG });
    expect(r.entryPrice).toBe(101); // stamped proximal edge — never the gap open
  });

  it("bearish scenario fills at the low edge (proximal for supply-side)", () => {
    const s = mkSetup(
      {
        confirmBar: 2, entryBandLow: 100, entryBandHigh: 101,
        invalidation: 104, targets: "95",
        activeBar: 4, targetReachedBar: 6, targetBars: "6",
      },
      { direction: "bearish", id: "s-bear" },
    );
    const r = evaluateScenario({ setup: s, candles: series(20), config: BASE_CFG });
    expect(r.entryPrice).toBe(100);
    expect(r.initialRisk).toBeCloseTo(4, 10);
  });
});

// ---------------------------------------------------------------------------
// Unevaluable inputs — never fabricated levels
// ---------------------------------------------------------------------------

describe("unevaluable scenarios", () => {
  it("missing confirmBar → unevaluable", () => {
    const s = mkSetup({ entryBandLow: 1, entryBandHigh: 2, invalidation: 0.5 });
    const r = evaluateScenario({ setup: s, candles: series(20), config: BASE_CFG });
    expect(r.status).toBe("unevaluable");
  });

  it("missing entry band → unevaluable", () => {
    const s = mkSetup({ confirmBar: 2, invalidation: 98 });
    const r = evaluateScenario({ setup: s, candles: series(20), config: BASE_CFG });
    expect(r.status).toBe("unevaluable");
    expect(r.statusReason).toMatch(/entry band/i);
  });

  it("zero initial risk (entry == invalidation) → unevaluable, never 0÷0 R", () => {
    const s = bull({ entryBandLow: 100, entryBandHigh: 100, invalidation: 100, activeBar: 4 });
    const r = evaluateScenario({ setup: s, candles: series(20), config: BASE_CFG });
    expect(r.status).toBe("unevaluable");
    expect(r.netR).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Costs — explicit deduction, documented formula
// ---------------------------------------------------------------------------

describe("cost assumptions", () => {
  const s = () => bull({ activeBar: 4, targetReachedBar: 6, targetBars: "6" });

  it("zero configured costs → gross equals net, costR = 0", () => {
    const r = evaluateScenario({ setup: s(), candles: series(20), config: BASE_CFG });
    expect(r.costR).toBe(0);
    expect(r.netR).toBe(r.grossR);
  });

  it("bps costs reduce net by the documented round-trip formula", () => {
    // costR = (entry * (fee+slip)bps/1e4 + slipPoints) / initialRisk
    const r = evaluateScenario({
      setup: s(), candles: series(20),
      config: { horizonBars: 10, costs: { feeBps: 10, slippageBps: 5, slippagePoints: 0.3 } },
    });
    // entry=101, risk=3 → costR = (101*15/10000 + 0.3)/3 = (0.1515+0.3)/3 = 0.1505
    expect(r.costR).toBeCloseTo(0.1505, 4);
    expect(r.netR).toBeCloseTo(r.grossR! - r.costR!, 4);
  });

  it("costs never apply to unactivated scenarios", () => {
    const r = evaluateScenario({
      setup: bull(), candles: series(20),
      config: { horizonBars: 10, costs: { feeBps: 50 } },
    });
    expect(r.entryPrice).toBeUndefined();
    expect(r.costR).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Aggregation — precise denominators, drawdown, baseline
// ---------------------------------------------------------------------------

describe("aggregation", () => {
  it("counts statuses, computes expectancy/median/totalR on filled rows only", () => {
    const candles = series(20);
    // Bar 7 dips through the invalidation (98) — the stamped invalidatedBar
    // then exits the remainder below entry → an honest negative R.
    candles[7] = { ...candles[7], open: 102.5, high: 102.8, low: 97.0, close: 97.4 };
    const win = bull({ activeBar: 4, targetReachedBar: 6, targetBars: "6" });
    const open = bull({ activeBar: 4 });
    const flat = bull();
    const scenarios = [
      evaluateScenario({ setup: win, candles, config: BASE_CFG }),
      evaluateScenario({
        setup: mkSetup({
          confirmBar: 2, entryBandLow: 100, entryBandHigh: 101,
          invalidation: 98, targets: "110", activeBar: 4, invalidatedBar: 7,
        }, { id: "s2" }),
        candles, config: BASE_CFG,
      }),
      evaluateScenario({ setup: mkSetup({ ...open.metadata! }, { id: "s3" }), candles, config: BASE_CFG }),
      evaluateScenario({ setup: mkSetup({ ...flat.metadata! }, { id: "s4" }), candles, config: BASE_CFG }),
    ];
    const agg = aggregateScenarios(scenarios);
    expect(agg.scenarioCount).toBe(4);
    expect(agg.counts.target).toBe(1);
    expect(agg.counts.stop).toBe(1);
    expect(agg.counts.censored).toBe(1);
    expect(agg.counts.not_filled).toBe(1);
    expect(agg.filledCount).toBe(3);
    expect(agg.wins).toBe(2); // target + censored mark-to-market both exit above entry
    expect(agg.losses).toBe(1);
    expect(agg.expectancyR).toBeDefined();
    expect(agg.maxDrawdownR).toBeDefined(); // ≥2 filled → sequential curve
  });

  it("empty population leaves denominators undefined, never NaN", () => {
    const agg = aggregateScenarios([]);
    expect(agg.expectancyR).toBeUndefined();
    expect(agg.medianR).toBeUndefined();
    expect(agg.maxDrawdownR).toBeUndefined();
    expect(agg.meanBaselineR).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Orchestration — engine seam, splits, overlap disclosure, reproducibility
// ---------------------------------------------------------------------------

const fakeEngineResult = (outcomes: SystemBacktestResult["outcomes"]): SystemBacktestResult => ({
  cells: [{ symbol: "SYN", timeframe: "1m" }],
  opportunities: [],
  developing: [],
  outcomes,
  aggregate: {
    observationCount: 0, developingObservationCount: 0, uniqueSetupCount: outcomes.length,
    selectedObservationCount: 0, resolvedOutcomeCount: 0,
    outcomeCounts: { target: 0, stop: 0, expired: 0, cancelled: 0, unresolved: 0 },
  },
  versions: { methodVersion: "v1", paramsVersion: "selnof|tk*", configVersion: "cfg-v1" },
});

const cell = (candles: Candle[]): BacktestCell => ({
  symbol: "SYN", timeframe: "1m",
  series: { symbol: "SYN", timeframe: "1m", candles },
});

describe("runHistoricalValidation orchestration", () => {
  it("collects setups through the spec-26 hook and evaluates each", () => {
    const candles = series(25);
    const s1 = bull({ activeBar: 4, targetReachedBar: 6, targetBars: "6" });
    const s2 = mkSetup({ ...s1.metadata!, confirmBar: 10, activeBar: 12 }, { id: "s2" });
    const run: typeof import("@/lib/engines/backtest").runBacktest = (input) => {
      input.onMeasuredSetup?.(s1);
      input.onMeasuredSetup?.(s2);
      return { ok: true, data: fakeEngineResult([]), errors: [], meta: { stage: "x", paramsVersion: "", barsConsumed: { from: 0, to: 0 }, events: [] } };
    };
    const r = runHistoricalValidation({ cells: [cell(candles)], config: { horizonBars: 5 }, deps: { config: defaultConfig(), run } });
    expect(r.scenarioCount).toBe(2);
    expect(r.scenarios[0].setupId).toBe("s1"); // anchor order
    expect(r.scenarios[0].status).toBe("target");
    expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is fully reproducible — same input, identical fingerprint and scenarios", () => {
    const candles = series(25);
    const s1 = bull({ activeBar: 4, targetReachedBar: 6, targetBars: "6" });
    const run: typeof import("@/lib/engines/backtest").runBacktest = (input) => {
      input.onMeasuredSetup?.(s1);
      return { ok: true, data: fakeEngineResult([]), errors: [], meta: { stage: "x", paramsVersion: "", barsConsumed: { from: 0, to: 0 }, events: [] } };
    };
    const deps = { config: defaultConfig(), run };
    const a = runHistoricalValidation({ cells: [cell(candles)], config: { horizonBars: 5 }, deps });
    const b = runHistoricalValidation({ cells: [cell(candles)], config: { horizonBars: 5 }, deps });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(JSON.stringify(a.scenarios)).toBe(JSON.stringify(b.scenarios));
    expect(JSON.stringify(a.aggregate)).toBe(JSON.stringify(b.aggregate));
  });

  it("different data → different fingerprint", () => {
    const candlesA = series(25);
    const candlesB = series(25);
    candlesB[10] = { ...candlesB[10], close: candlesB[10].close + 50 };
    const run: typeof import("@/lib/engines/backtest").runBacktest = () => ({
      ok: true, data: fakeEngineResult([]), errors: [],
      meta: { stage: "x", paramsVersion: "", barsConsumed: { from: 0, to: 0 }, events: [] },
    });
    const deps = { config: defaultConfig(), run };
    const a = runHistoricalValidation({ cells: [cell(candlesA)], config: { horizonBars: 5 }, deps });
    const b = runHistoricalValidation({ cells: [cell(candlesB)], config: { horizonBars: 5 }, deps });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("chronological splits partition scenarios contiguously by anchor order", () => {
    const candles = series(30);
    const setups = [3, 10, 15, 20, 22].map((cb, i) =>
      mkSetup({ ...bull().metadata!, confirmBar: cb, activeBar: cb + 1 }, { id: `s${i}` }),
    );
    const run: typeof import("@/lib/engines/backtest").runBacktest = (input) => {
      for (const s of setups) input.onMeasuredSetup?.(s);
      return { ok: true, data: fakeEngineResult([]), errors: [], meta: { stage: "x", paramsVersion: "", barsConsumed: { from: 0, to: 0 }, events: [] } };
    };
    const r = runHistoricalValidation({
      cells: [cell(candles)],
      config: { horizonBars: 5, split: { trainPct: 0.4, validationPct: 0.2 } },
      deps: { config: defaultConfig(), run },
    });
    const splits = r.splits!;
    expect(splits.map((s) => s.name)).toEqual(["train", "validation", "test"]);
    expect(splits[0].aggregate.scenarioCount).toBe(2);   // floor(5*0.4)
    expect(splits[1].aggregate.scenarioCount).toBe(1);   // floor(5*0.2)
    expect(splits[2].aggregate.scenarioCount).toBe(2);   // remainder — test sees only the tail
    // Contiguity: no scenario index shared between cohorts.
    expect(splits[0].toScenario).toBe(splits[1].fromScenario);
    expect(splits[1].toScenario).toBe(splits[2].fromScenario);
  });

  it("overlapping evaluation windows are disclosed, not silently independent", () => {
    const candles = series(30);
    const s1 = bull({ activeBar: 4 });
    const s2 = mkSetup({ ...s1.metadata!, confirmBar: 5, activeBar: 6 }, { id: "s2" });
    const run: typeof import("@/lib/engines/backtest").runBacktest = (input) => {
      input.onMeasuredSetup?.(s1);
      input.onMeasuredSetup?.(s2);
      return { ok: true, data: fakeEngineResult([]), errors: [], meta: { stage: "x", paramsVersion: "", barsConsumed: { from: 0, to: 0 }, events: [] } };
    };
    const r = runHistoricalValidation({
      cells: [cell(candles)], config: { horizonBars: 10 }, deps: { config: defaultConfig(), run },
    });
    expect(r.scenarios[0].overlapsNext).toBe(true); // s2 anchors inside s1's window
    expect(r.warnings.some((w) => /overlap/i.test(w))).toBe(true);
  });

  it("selection marking excludes unselected setups from the evaluated population", () => {
    const candles = series(25);
    const s1 = bull({ activeBar: 4, targetReachedBar: 6, targetBars: "6" });
    const s2 = mkSetup({ ...s1.metadata!, confirmBar: 10 }, { id: "s2" });
    const run: typeof import("@/lib/engines/backtest").runBacktest = (input) => {
      input.onMeasuredSetup?.(s1);
      input.onMeasuredSetup?.(s2);
      const res = fakeEngineResult([]);
      res.opportunities = [{
        setupId: "s1", symbol: "SYN", timeframe: "1m", setupType: "reversal",
        direction: "bullish", status: "confirmed", evaluatedAt: BASE, evaluatedIndex: 2,
        rank: 1, score: 80, selected: true,
      }];
      return { ok: true, data: res, errors: [], meta: { stage: "x", paramsVersion: "", barsConsumed: { from: 0, to: 0 }, events: [] } };
    };
    const r = runHistoricalValidation({
      cells: [cell(candles)], config: { horizonBars: 5, minScore: 60 },
      deps: { config: defaultConfig(), run },
    });
    expect(r.scenarioCount).toBe(1); // only the selected setup evaluated
    expect(r.aggregate.excludedCount).toBe(1);
  });

  it("rejects malformed configs loudly", () => {
    expect(() => runHistoricalValidation({
      cells: [cell(series(10))], config: { horizonBars: 0 },
      deps: { config: defaultConfig() },
    })).toThrow(/horizonBars/);
    expect(() => runHistoricalValidation({
      cells: [cell(series(10))], config: { horizonBars: 5, costSensitivity: [{ feeBps: -1 }] },
      deps: { config: defaultConfig() },
    })).toThrow(/costSensitivity/);
    expect(() => runHistoricalValidation({
      cells: [cell(series(10))], config: { horizonBars: 5, horizonSensitivity: [5] },
      deps: { config: defaultConfig() },
    })).toThrow(/horizonSensitivity/); // cannot repeat the base horizon
    expect(() => runHistoricalValidation({
      cells: [cell(series(10))], config: { horizonBars: 5, horizonSensitivity: [3, 3] },
      deps: { config: defaultConfig() },
    })).toThrow(/horizonSensitivity/);
  });
});

// ---------------------------------------------------------------------------
// Robustness layer — uncertainty, cost/horizon sensitivity, reproducibility
// ---------------------------------------------------------------------------

describe("uncertainty intervals", () => {
  it("Wilson interval brackets the true proportion and stays in [0,1]", () => {
    const ci = wilsonInterval(6, 10)!;
    expect(ci.method).toBe("wilson-score");
    expect(ci.point).toBeCloseTo(0.6, 4);
    expect(ci.lower).toBeLessThan(0.6);
    expect(ci.upper).toBeGreaterThan(0.6);
    expect(ci.lower).toBeGreaterThanOrEqual(0);
    expect(ci.upper).toBeLessThanOrEqual(1);
    expect(ci.n).toBe(10);
    // Known reference: Wilson 95% for 6/10 ≈ [0.313, 0.832]
    expect(ci.lower).toBeCloseTo(0.313, 2);
    expect(ci.upper).toBeCloseTo(0.832, 2);
  });

  it("Student-t interval is symmetric around the mean and wider at small n", () => {
    const big = meanTInterval(Array.from({ length: 30 }, () => 1))!; // zero variance → collapsed
    expect(big.lower).toBeCloseTo(big.upper, 10);
    const ci = meanTInterval([1, -1, 1, -1, 1, -1, 1, -1])!; // mean 0, sd 1.07
    expect(ci.point).toBeCloseTo(0, 4);
    expect(ci.lower).toBeLessThan(0);
    expect(ci.upper).toBeGreaterThan(0);
    // n=8 → t₇=2.365 → half-width = 2.365·(1.069/√8) ≈ 0.894
    expect(ci.upper).toBeCloseTo(0.894, 2);
  });

  it("refuses intervals on unsupported denominators — with an explicit reason", () => {
    expect(wilsonInterval(0, 0)).toBeUndefined();
    expect(meanTInterval([])).toBeUndefined();
    expect(meanTInterval([0.5])).toBeUndefined();
    const s = [evaluateScenario({ setup: bull(), candles: series(20), config: BASE_CFG })]; // not_filled
    const u = computeUncertainty(s, analyzeDependence(s));
    expect(u.winRate).toBeUndefined();
    expect(u.expectancyR).toBeUndefined();
    expect(u.notes.join(" ")).toMatch(/denominator = 0|no realized outcomes|fewer than 2/i);
  });

  it("attaches the dependence caveat on the iid fallback when windows overlap", () => {
    const candles = series(30);
    const s1 = evaluateScenario({ setup: bull({ activeBar: 4, targetReachedBar: 6, targetBars: "6" }), candles, config: BASE_CFG });
    const s2 = evaluateScenario({
      setup: mkSetup({ ...bull().metadata!, confirmBar: 5, activeBar: 6, targetReachedBar: 7, targetBars: "7" }, { id: "s2" }),
      candles, config: BASE_CFG,
    });
    const dep = analyzeDependence([s1, s2]);
    expect(dep.overlappingPairs).toBeGreaterThan(0);
    const u = computeUncertainty([s1, s2], dep);
    // n=2 < bootstrap minimum → iid fallback with the violation caveat attached.
    expect(u.expectancyR?.dependenceHandling).toBe("iid-assumed");
    expect(u.expectancyR?.caveat).toMatch(/UNDERSTATES/i);
  });
});

describe("cost sensitivity", () => {
  const evalSet = () => {
    const candles = series(20);
    candles[7] = { ...candles[7], open: 102.5, high: 102.8, low: 97.0, close: 97.4 };
    return [
      evaluateScenario({ setup: bull({ activeBar: 4, targetReachedBar: 6, targetBars: "6" }), candles, config: BASE_CFG }),
      evaluateScenario({
        setup: mkSetup({ confirmBar: 2, entryBandLow: 100, entryBandHigh: 101, invalidation: 98, targets: "110", activeBar: 4, invalidatedBar: 7 }, { id: "s2" }),
        candles, config: BASE_CFG,
      }),
      evaluateScenario({ setup: bull(), candles, config: BASE_CFG }), // not_filled
    ];
  };

  it("re-prices only R fields — statuses, entries and risk are frozen", () => {
    const base = evalSet();
    const cases = runCostSensitivity(base, [{ feeBps: 20, slippageBps: 10 }], 0);
    expect(cases).toHaveLength(1);
    // The aggregate is computed over repriced clones — same population.
    expect(cases[0].aggregate.scenarioCount).toBe(3);
    expect(cases[0].aggregate.filledCount).toBe(2);
    // Cost arithmetic: entry 101, risk 3 → costR = 101·30/1e4 / 3 ≈ 0.101
    // Net expectancy must DROP by exactly the mean costR — never improve.
    const delta = cases[0].expectancyDeltaR!;
    expect(delta).toBeLessThan(0);
    expect(delta).toBeCloseTo(-(101 * 30 / 10_000 / 3 + 101 * 30 / 10_000 / 3) / 2, 3);
    expect(cases[0].signFlips).toBe(0);
    expect(cases[0].expectancySignChange).toBe(false);
  });

  it("large enough costs flip the classification — flagged, not hidden", () => {
    const base = evalSet(); // censored+target mix is positive overall
    const cases = runCostSensitivity(base, [{ feeBps: 5000, slippageBps: 5000, slippagePoints: 50 }], 0);
    expect(cases[0].signFlips).toBeGreaterThan(0);
    expect(cases[0].expectancySignChange).toBe(true);
  });
});

describe("horizon sensitivity", () => {
  const setupsFor = () => {
    // s1: target at bar 8 (only reachable with horizon ≥ 6)
    const s1 = bull({ activeBar: 4, targetReachedBar: 8, targetBars: "8" });
    // s2: activated, never resolves → censored at any horizon
    const s2 = mkSetup({ ...bull().metadata!, confirmBar: 10, activeBar: 12 }, { id: "s2" });
    return [s1, s2];
  };

  it("each horizon enforces its own cutoff — events beyond it are invisible", () => {
    const candles = series(30);
    const setups = setupsFor();
    const cellMap = new Map([["SYN@1m", candles] as const]);
    const baseScenarios = setups.map((s) => evaluateScenario({ setup: s, candles, config: { horizonBars: 10 } }));
    const out = runHorizonSensitivity(setups, cellMap, { horizonBars: 10 }, baseScenarios, new Map(), [4], 0);
    expect(out).toHaveLength(1);
    expect(out[0].horizonBars).toBe(4);
    // Horizon 4: s1's window ends at bar 6 — target (bar 8) invisible → censored.
    // s2 activates at 12 with no terminal stamp → censored at any horizon.
    expect(out[0].aggregate.counts.censored).toBe(2);
    expect(out[0].aggregate.counts.target).toBe(0);
    // Membership delta disclosed: target→censored transition recorded.
    expect(out[0].statusTransitions["target→censored"]).toBe(1);
    expect(out[0].changedCount).toBe(1);
  });

  it("a shorter horizon can never see past its own window — resolvedBar is capped", () => {
    const candles = series(30);
    const s1 = bull({ activeBar: 4, targetReachedBar: 20, targetBars: "20" });
    const r = evaluateScenario({ setup: s1, candles, config: { horizonBars: 3 } });
    expect(r.resolvedBar).toBe(5); // cb 2 + 3
    expect(r.status).toBe("censored");
    expect(r.targetsReached).toBe(0);
  });
});

describe("orchestration — sensitivity, cohorts, reproducibility records", () => {
  const mkRun = (setups: Setup[]) =>
    (input: Parameters<typeof import("@/lib/engines/backtest").runBacktest>[0]) => {
      for (const s of setups) input.onMeasuredSetup?.(s);
      return { ok: true as const, data: fakeEngineResult([]), errors: [], meta: { stage: "x", paramsVersion: "", barsConsumed: { from: 0, to: 0 }, events: [] } };
    };

  it("cost + horizon sensitivity run on the same frozen population", () => {
    const candles = series(30);
    const s1 = bull({ activeBar: 4, targetReachedBar: 8, targetBars: "8" });
    const r = runHistoricalValidation({
      cells: [cell(candles)],
      config: {
        horizonBars: 10,
        costs: { feeBps: 5 },
        costSensitivity: [{ feeBps: 50 }],
        horizonSensitivity: [4],
      },
      deps: { config: defaultConfig(), run: mkRun([s1]) },
    });
    expect(r.sensitivity?.costs).toHaveLength(1);
    expect(r.sensitivity?.horizons).toHaveLength(1);
    expect(r.sensitivity!.horizons![0].statusTransitions["target→censored"]).toBe(1);
    expect(r.warnings.some((w) => /horizon 4/i.test(w))).toBe(true);
    expect(r.methodology.metricDefinitions.expectancyR).toMatch(/filled rows/);
    expect(r.methodology.uncertaintyMethod).toMatch(/Wilson|Student/i);
  });

  it("cohorts carry anchor-time bounds and warn on tiny samples", () => {
    const candles = series(30);
    const setups = [3, 10, 15, 20, 22].map((cb, i) =>
      mkSetup({ ...bull().metadata!, confirmBar: cb, activeBar: cb + 1 }, { id: `s${i}` }),
    );
    const r = runHistoricalValidation({
      cells: [cell(candles)],
      config: { horizonBars: 4, split: { trainPct: 0.4, validationPct: 0.2 } },
      deps: { config: defaultConfig(), run: mkRun(setups) },
    });
    const splits = r.splits!;
    expect(splits[0].anchorFrom).toBe(splits[0].aggregate.scenarioCount > 0 ? r.scenarios[0].anchorTime : undefined);
    // Out-of-sample isolation: test cohort anchors are strictly later than train's.
    expect(splits[2].anchorFrom! > splits[0].anchorTo!).toBe(true);
    expect(r.warnings.some((w) => /cohort 'train'.*too small/i.test(w))).toBe(true);
    expect(r.methodology.cohortBoundaries).toMatch(/train=\[0,2\)/);
  });

  it("aggregate exposes overlappingWindows and per-metric denominators", () => {
    const candles = series(30);
    // s1 resolves at bar 12 → s2's anchor (5) shares its window's future bars.
    const s1 = bull({ activeBar: 4, targetReachedBar: 12, targetBars: "12" });
    const s2 = mkSetup({ ...s1.metadata!, confirmBar: 5, activeBar: 6, targetReachedBar: 7, targetBars: "7" }, { id: "s2" });
    const r = runHistoricalValidation({
      cells: [cell(candles)], config: { horizonBars: 10 },
      deps: { config: defaultConfig(), run: mkRun([s1, s2]) },
    });
    expect(r.aggregate.overlappingWindows).toBe(1);
    expect(r.aggregate.dependence!.overlappingPairs).toBe(1);
    expect(r.aggregate.uncertainty?.expectancyR?.caveat).toMatch(/UNDERSTATES/i);
    expect(r.methodology.metricDefinitions.filledCount).toMatch(/activeBar/);
  });

  it("sensitivity config is bound into the fingerprint — assumption changes are detectable", () => {
    const candles = series(25);
    const s1 = bull({ activeBar: 4, targetReachedBar: 6, targetBars: "6" });
    const deps = { config: defaultConfig(), run: mkRun([s1]) };
    const a = runHistoricalValidation({ cells: [cell(candles)], config: { horizonBars: 5 }, deps });
    const b = runHistoricalValidation({
      cells: [cell(candles)], config: { horizonBars: 5, costSensitivity: [{ feeBps: 10 }] }, deps,
    });
    expect(a.fingerprint).not.toBe(b.fingerprint); // different assumption set
    expect(b.scenarios[0].status).toBe(a.scenarios[0].status); // same frozen scenario
  });
});

// ---------------------------------------------------------------------------
// Dependence-aware statistics — denominators, overlap, bootstrap
// ---------------------------------------------------------------------------

describe("realized vs mark-to-market denominators", () => {
  const realizedSetup = bull({ activeBar: 4, targetReachedBar: 6, targetBars: "6" });
  const mtmSetup = mkSetup({ ...bull().metadata!, confirmBar: 5, activeBar: 7 }, { id: "mtm" }); // censored
  const mkAgg = () => {
    const candles = series(30);
    const s: ValidatedScenario[] = [
      evaluateScenario({ setup: realizedSetup, candles, config: BASE_CFG }),
      evaluateScenario({ setup: mtmSetup, candles, config: BASE_CFG }),
    ];
    return { agg: aggregateScenarios(s), scenarios: s };
  };

  it("realized and censored rows are counted in SEPARATE denominators", () => {
    const { agg, scenarios } = mkAgg();
    expect(scenarios[0].status).toBe("target");
    expect(scenarios[1].status).toBe("censored");
    expect(agg.filledCount).toBe(2);
    expect(agg.realizedCount).toBe(1);
    expect(agg.mtmCount).toBe(1);
    // realizedWinRate must be 1.0 over the single realized row — NOT diluted by M2M.
    expect(agg.realizedWins).toBe(1);
    expect(agg.realizedWinRate).toBe(1);
    expect(agg.mtmWins + agg.mtmLosses + agg.mtmBreakevens).toBe(1);
  });

  it("a positive M2M row is never silently counted as a realized win", () => {
    const { scenarios } = mkAgg();
    // Hand the censored row a positive mark-to-market value.
    scenarios[1] = { ...scenarios[1], netR: 0.5 };
    const agg = aggregateScenarios(scenarios);
    expect(agg.realizedWins).toBe(1);            // only the target row
    expect(agg.realizedCount).toBe(1);
    expect(agg.mtmWins).toBe(1);                 // counted — as M2M, not realized
    expect(agg.mtmMeanR).toBeCloseTo(0.5, 4);
    expect(agg.wins).toBe(2);                    // mixed field discloses BOTH populations
  });
});

describe("dependence analysis", () => {
  const ev = (setup: Setup, n = 40) =>
    evaluateScenario({ setup, candles: series(n), config: { horizonBars: 5 } });

  it("detects overlapping windows from anchor + resolved window", () => {
    // s1 resolves at bar 12 (anchor 2 + 10); s2 anchors at 5 → inside s1's window.
    const s1 = ev(bull({ activeBar: 4, targetReachedBar: 12, targetBars: "12" }));
    const s2 = ev(mkSetup({ ...bull().metadata!, confirmBar: 5, activeBar: 6, targetReachedBar: 7, targetBars: "7" }, { id: "s2" }));
    const dep = analyzeDependence([s1, s2]);
    expect(dep.overlappingPairs).toBe(1);
    expect(s1.overlapsNext).toBe(true);
    expect(dep.clusters).toBe(1);
    expect(dep.largestCluster).toBe(2);
    expect(dep.uniqueAnchors).toBe(2);
  });

  it("classifies disjoint windows as independent clusters", () => {
    const s1 = ev(bull({ activeBar: 4, targetReachedBar: 6, targetBars: "6" }));
    const s2 = ev(mkSetup({ ...bull().metadata!, confirmBar: 20, activeBar: 21, targetReachedBar: 22, targetBars: "22" }, { id: "s2" }));
    const dep = analyzeDependence([s1, s2]);
    expect(dep.overlappingPairs).toBe(0);
    expect(dep.clusters).toBe(2);
    expect(s1.overlapsNext).toBeUndefined();
  });

  it("transitive chains form ONE cluster even without pairwise reach", () => {
    // s1: window ends 8; s2 anchors 6 ends 11; s3 anchors 9 ends 14.
    // s1–s3 share NO bars, but s1→s2→s3 chains transitively.
    const mk = (cb: number, end: number, id: string) =>
      ev(mkSetup({ ...bull().metadata!, confirmBar: cb, activeBar: cb + 1, targetReachedBar: end, targetBars: String(end) }, { id }));
    const dep = analyzeDependence([mk(2, 8, "a"), mk(6, 11, "b"), mk(9, 14, "c")]);
    expect(dep.overlappingPairs).toBe(2); // (a,b) and (b,c) — NOT (a,c)
    expect(dep.clusters).toBe(1);
    expect(dep.largestCluster).toBe(3);
  });

  it("same-anchor scenarios are reported via uniqueAnchors, not ignored", () => {
    const s1 = ev(bull({ activeBar: 4, targetReachedBar: 6, targetBars: "6" }));
    const s2 = ev(mkSetup({ ...bull().metadata!, activeBar: 4, targetReachedBar: 6, targetBars: "6" }, { id: "s2" }));
    const dep = analyzeDependence([s1, s2]);
    expect(dep.uniqueAnchors).toBe(1); // SAME anchor — maximal dependence disclosed
    expect(dep.overlappingPairs).toBe(1);
  });
});

describe("moving-block bootstrap", () => {
  const vals = [1, -0.5, 1.2, -0.3, 0.8, -1, 0.4, 0.6, -0.2, 0.9, -0.7, 0.3];

  it("is deterministic — same seed reproduces the identical interval", () => {
    const a = blockBootstrapMean(vals)!;
    const b = blockBootstrapMean(vals)!;
    expect(a.lower).toBe(b.lower);
    expect(a.upper).toBe(b.upper);
    expect(a.method).toBe("moving-block-bootstrap");
    expect(a.dependenceHandling).toBe("moving-block-bootstrap");
    expect(a.bootstrap!.resamples).toBe(2000);
    expect(a.bootstrap!.blockLen).toBe(Math.ceil(Math.sqrt(vals.length)));
    expect(a.bootstrap!.seed).toBe(0x9E3779B9);
    expect(a.point).toBeCloseTo(vals.reduce((x, y) => x + y, 0) / vals.length, 3);
  });

  it("a different seed yields a (slightly) different but still valid band", () => {
    const a = blockBootstrapMean(vals)!;
    const b = blockBootstrapMean(vals, { seed: 42 })!;
    expect(b.lower).toBeLessThanOrEqual(b.upper);
    expect(b.lower).toBeLessThanOrEqual(b.point);
    expect(b.upper).toBeGreaterThanOrEqual(b.point);
    expect(Number.isFinite(a.lower)).toBe(true);
  });

  it("resampling preserves chronological runs — blocks, not iid shuffles", () => {
    const rng = mulberry32(7);
    const idx = movingBlockResampleIndices(12, 3, rng);
    expect(idx).toHaveLength(12);
    // With wrap-around blocks of 3, the index sequence must contain at least
    // one strictly-consecutive run of length ≥ 2 — an iid shuffle would almost
    // never preserve adjacency.
    let consecutiveRuns = 0;
    for (let i = 1; i < idx.length; i++) {
      if (idx[i] === idx[i - 1] + 1 || (idx[i] === 0 && idx[i - 1] === 11)) consecutiveRuns++;
    }
    expect(consecutiveRuns).toBeGreaterThan(0);
  });

  it("refuses when there are too few realized observations", () => {
    expect(blockBootstrapMean([1, 2, 3, 4, 5])).toBeUndefined();
    expect(blockBootstrapMean([1, 2, 3, 4, 5, 6, 7])).toBeUndefined();
    expect(blockBootstrapMean([1, 2, 3, 4, 5, 6, 7, 8])).toBeDefined();
  });
});

describe("dependence-aware uncertainty end-to-end", () => {
  /** Build N resolved scenarios with strictly disjoint windows + one overlap cluster. */
  const mkRunRows = (n: number): ValidatedScenario[] => {
    const candles = series(n * 20 + 40);
    return Array.from({ length: n }, (_, i) => {
      const cb = i * 20;
      const win = i % 3 === 0;
      return evaluateScenario({
        setup: mkSetup(
          { ...bull().metadata!, confirmBar: cb, activeBar: cb + 1,
            ...(win ? { targetReachedBar: cb + 3, targetBars: String(cb + 3) } : { invalidatedBar: cb + 3 }) },
          { id: `r${i}` },
        ),
        candles,
        config: { horizonBars: 8 },
      });
    });
  };

  it("produces a bootstrap CI when realized n and independent clusters suffice", () => {
    const rows = mkRunRows(12); // disjoint anchors every 20 bars → 12 clusters
    const dep = analyzeDependence(rows);
    expect(dep.overlappingPairs).toBe(0);
    const u = computeUncertainty(rows, dep);
    expect(u.expectancyR?.method).toBe("moving-block-bootstrap");
    expect(u.expectancyR?.dependenceHandling).toBe("moving-block-bootstrap");
    expect(u.winRate?.method).toBe("moving-block-bootstrap");
    expect(u.expectancyR?.bootstrap?.resamplingUnit).toMatch(/realized/);
    expect(u.expectancyR?.caveat).toMatch(/does NOT correct/i);
  });

  it("refuses the bootstrap and downgrades to labelled iid when clusters < 3", () => {
    // Two scenarios whose windows overlap → 1 cluster.
    const candles = series(30);
    const rows = [
      evaluateScenario({ setup: bull({ activeBar: 4, targetReachedBar: 12, targetBars: "12" }), candles, config: { horizonBars: 15 } }),
      evaluateScenario({ setup: mkSetup({ ...bull().metadata!, confirmBar: 5, activeBar: 6, targetReachedBar: 7, targetBars: "7" }, { id: "s2" }), candles, config: { horizonBars: 15 } }),
    ];
    const dep = analyzeDependence(rows);
    expect(dep.clusters).toBeLessThan(3);
    const u = computeUncertainty(rows, dep);
    expect(u.notes.some((n) => /bootstrap refused/i.test(n))).toBe(true);
    expect(u.expectancyR?.dependenceHandling).toBe("iid-assumed");
  });

  it("cohort membership never claims independence — cross-cohort overlap is disclosed", () => {
    const candles = series(40);
    // No terminal stamps → censored → windows reach the horizon end; cb 3,6,9
    // overlap each other's windows, cb 30 is disjoint.
    const setups = [3, 6, 9, 30].map((cb, i) =>
      mkSetup({ ...bull().metadata!, confirmBar: cb, activeBar: cb + 1 }, { id: `s${i}` }),
    );
    const mkRun = (ss: Setup[]) =>
      (input: Parameters<typeof import("@/lib/engines/backtest").runBacktest>[0]) => {
        for (const s of ss) input.onMeasuredSetup?.(s);
        return { ok: true as const, data: fakeEngineResult([]), errors: [], meta: { stage: "x", paramsVersion: "", barsConsumed: { from: 0, to: 0 }, events: [] } };
      };
    const r = runHistoricalValidation({
      cells: [cell(candles)],
      config: { horizonBars: 10, split: { trainPct: 0.5, validationPct: 0.25 } },
      deps: { config: defaultConfig(), run: mkRun(setups) },
    });
    // Train cohort (cb 3,6) overlaps internally — its own dependence is reported.
    expect(r.splits![0].aggregate.dependence!.overlappingPairs).toBeGreaterThan(0);
    // Cohorts in different slices each carry their own diagnostics.
    expect(r.splits![2].aggregate.dependence).toBeDefined();
  });

  it("realized-only interval denominators exclude M2M rows end-to-end", () => {
    const candles = series(40);
    const realized = bull({ activeBar: 4, targetReachedBar: 6, targetBars: "6" });
    const censored = mkSetup({ ...bull().metadata!, confirmBar: 30, activeBar: 31 }, { id: "c" });
    const mkRun = (ss: Setup[]) =>
      (input: Parameters<typeof import("@/lib/engines/backtest").runBacktest>[0]) => {
        for (const s of ss) input.onMeasuredSetup?.(s);
        return { ok: true as const, data: fakeEngineResult([]), errors: [], meta: { stage: "x", paramsVersion: "", barsConsumed: { from: 0, to: 0 }, events: [] } };
      };
    const r = runHistoricalValidation({
      cells: [cell(candles)], config: { horizonBars: 8 },
      deps: { config: defaultConfig(), run: mkRun([realized, censored]) },
    });
    expect(r.aggregate.realizedCount).toBe(1);
    expect(r.aggregate.mtmCount).toBe(1);
    expect(r.aggregate.uncertainty!.winRate!.n).toBe(1); // realized denominator only
    expect(r.aggregate.uncertainty!.notes.some((n) => /EXCLUDED from realized intervals/i.test(n))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Boundary-aware walk-forward — leakage diagnostics + purged cohorts
// ---------------------------------------------------------------------------

describe("boundary leakage diagnostics", () => {
  const candles = series(60);
  /** Scenario evaluated on shared candles; confirmBar+resolution chosen per test. */
  const ev = (cb: number, resolved: number | undefined, id: string, active?: number): ValidatedScenario =>
    evaluateScenario({
      setup: mkSetup({
        ...bull().metadata!, confirmBar: cb, activeBar: active ?? cb + 1,
        ...(resolved !== undefined
          ? { targetReachedBar: resolved, targetBars: String(resolved) }
          : {}),
      }, { id }),
      // Horizon 60 ⇒ hEnd = 59 for every row — stamps are never capped here.
      candles, config: { horizonBars: 60 },
    });
  const mkSplits = (rows: ValidatedScenario[], ranges: [SplitAggregate["name"], number, number][]): SplitAggregate[] =>
    ranges.map(([name, from, to]) => ({
      name, fromScenario: from, toScenario: to,
      anchorFrom: rows[from]?.anchorTime, anchorTo: rows[to - 1]?.anchorTime,
      aggregate: aggregateScenarios(rows.slice(from, to)),
    }));

  it("a prior scenario resolving before the next cohort begins is retained and clean", () => {
    const rows = [ev(5, 8, "a"), ev(20, 22, "b")];
    const splits = mkSplits(rows, [["train", 0, 1], ["test", 1, 2]]);
    const [b] = analyzeBoundaryLeakage(rows, splits);
    expect(b.status).toBe("clean");
    expect(b.contaminatedCount).toBe(0);
    expect(b.boundaryAnchorBar).toBe(20);
    expect(b.boundaryTime).toBe(rows[1].anchorTime);
    const purged = purgeCohortSlice(rows.slice(0, 1), [b], 0);
    expect(purged.retainedCount).toBe(1);
    expect(purged.purgedCount).toBe(0);
    expect(walkForwardStatus([b], false)).toBe("clean");
  });

  it("a prior scenario consuming the first later-cohort bar is flagged and purged", () => {
    // boundary anchor 20 → first consumed bar 21; resolvedBar 21 contaminates.
    const rows = [ev(5, 21, "a"), ev(20, 22, "b")];
    const splits = mkSplits(rows, [["train", 0, 1], ["test", 1, 2]]);
    const [b] = analyzeBoundaryLeakage(rows, splits);
    expect(b.status).toBe("leakage_detected");
    expect(b.contaminatedCount).toBe(1);
    expect(b.contamination[0].setupId).toBe("a");
    expect(b.contamination[0].barsIntoLaterCohort).toBe(1);
    expect(b.affectedAnchors).toBe(1);
    const purged = purgeCohortSlice(rows.slice(0, 1), [b], 0);
    expect(purged.retainedCount).toBe(0);
    expect(purged.purgedSetupIds).toEqual(["a"]);
    expect(walkForwardStatus([b], true)).toBe("purged");
  });

  it("a prior scenario consuming many later bars is counted ONCE per boundary", () => {
    const rows = [ev(5, 40, "a"), ev(20, 22, "b")]; // 20 bars deep into later cohort
    const splits = mkSplits(rows, [["train", 0, 1], ["test", 1, 2]]);
    const [b] = analyzeBoundaryLeakage(rows, splits);
    expect(b.contaminatedCount).toBe(1); // not 20 — scenario counted once
    expect(b.contamination[0].barsIntoLaterCohort).toBe(20);
    expect(b.laterBarsTouched).toBeGreaterThanOrEqual(1);
    const purged = purgeCohortSlice(rows.slice(0, 1), [b], 0);
    expect(purged.purgedCount).toBe(1);
  });

  it("duplicate anchors are diagnosed separately from boundary leakage", () => {
    // Two same-anchor rows in train, both resolving before the boundary —
    // anchor duplication is a DEPENDENCE diagnostic, not leakage.
    const rows = [
      ev(5, 8, "a1"), ev(5, 8, "a2"),
      ev(30, 32, "b"),
    ];
    const splits = mkSplits(rows, [["train", 0, 2], ["test", 2, 3]]);
    const dep = analyzeDependence(rows.slice(0, 2));
    const [b] = analyzeBoundaryLeakage(rows, splits);
    expect(dep.uniqueAnchors).toBe(1);              // duplication disclosed
    expect(b.contaminatedCount).toBe(0);            // but NOT leakage
    expect(b.status).toBe("clean");
  });

  it("missing timing data never produces a silent clean — indeterminate instead", () => {
    const rows = [ev(5, 8, "a"), ev(20, 22, "b")];
    // Strip resolvedBar from an evaluable row — safety can no longer be proven.
    rows[0] = { ...rows[0], resolvedBar: undefined };
    const splits = mkSplits(rows, [["train", 0, 1], ["test", 1, 2]]);
    const [b] = analyzeBoundaryLeakage(rows, splits);
    expect(b.status).toBe("indeterminate");
    expect(walkForwardStatus([b], true)).toBe("indeterminate");
    const purged = purgeCohortSlice(rows.slice(0, 1), [b], 0);
    expect(purged.aggregate).toBeUndefined();
    expect(purged.unavailableReason).toBeTruthy();
    // Missing series identity is equally indeterminate.
    rows[0] = { ...rows[0], resolvedBar: 8, symbol: undefined };
    expect(analyzeBoundaryLeakage(rows, splits)[0].status).toBe("indeterminate");
  });

  it("a scenario crossing MORE than one boundary is reported in each, once", () => {
    // Train row resolving at bar 50 crosses validation (anchor 20) AND test (anchor 40).
    const rows = [ev(5, 50, "a"), ev(10, 12, "x"), ev(20, 22, "b"), ev(40, 42, "c")];
    const splits = mkSplits(rows, [["train", 0, 2], ["validation", 2, 3], ["test", 3, 4]]);
    const reports = analyzeBoundaryLeakage(rows, splits);
    expect(reports).toHaveLength(2); // two adjacent boundaries, incl. final test boundary
    const val = reports[0], test = reports[1];
    expect(val.toCohort).toBe("validation");
    expect(val.contamination.filter((c) => c.setupId === "a")).toHaveLength(1);
    expect(test.toCohort).toBe("test");
    // The same train row also reaches the test boundary — counted there once.
    expect(test.contamination.filter((c) => c.setupId === "a")).toHaveLength(1);
    expect(test.contamination[0].fromCohort).toBe("train");
    // Scenario x resolved at 12 — reaches neither boundary.
    expect(val.contamination.filter((c) => c.setupId === "x")).toHaveLength(0);
  });

  it("cross-series indices are incomparable — never false leakage", () => {
    const rows = [ev(5, 50, "a"), ev(20, 22, "b")];
    rows[1] = { ...rows[1], symbol: "OTHER" }; // different series
    const splits = mkSplits(rows, [["train", 0, 1], ["test", 1, 2]]);
    const [b] = analyzeBoundaryLeakage(rows, splits);
    expect(b.contaminatedCount).toBe(0); // resolvedBar 50 means nothing vs another series
  });
});

describe("purged-cohort evaluation end-to-end", () => {
  const candles = series(60);
  const mkRun = (ss: Setup[]) =>
    (input: Parameters<typeof import("@/lib/engines/backtest").runBacktest>[0]) => {
      for (const s of ss) input.onMeasuredSetup?.(s);
      return { ok: true as const, data: fakeEngineResult([]), errors: [], meta: { stage: "x", paramsVersion: "", barsConsumed: { from: 0, to: 0 }, events: [] } };
    };
  /** 4 scenarios: safe train row, leaky train row, val row, test row. */
  const setups = [
    mkSetup({ ...bull().metadata!, confirmBar: 5, activeBar: 6, targetReachedBar: 8, targetBars: "8" }, { id: "safe" }),
    // leaky resolves at 35 — past validation's first consumed bar (31) but
    // short of test's (46).
    mkSetup({ ...bull().metadata!, confirmBar: 10, activeBar: 11, targetReachedBar: 35, targetBars: "35" }, { id: "leaky" }),
    mkSetup({ ...bull().metadata!, confirmBar: 30, activeBar: 31, targetReachedBar: 33, targetBars: "33" }, { id: "val" }),
    mkSetup({ ...bull().metadata!, confirmBar: 45, activeBar: 46, targetReachedBar: 48, targetBars: "48" }, { id: "test" }),
  ];
  const runCfg = (purge: boolean): ValidationRunConfig => ({
    horizonBars: 40, split: { trainPct: 0.5, validationPct: 0.25 },
    ...(purge ? { purgeBoundaries: true } : {}),
  });
  const run = (purge: boolean) => runHistoricalValidation({
    cells: [cell(candles)], config: runCfg(purge),
    deps: { config: defaultConfig(), run: mkRun(setups) },
  });

  it("leakage is reported in diagnostics-only mode; raw metrics stay backward-compatible", () => {
    const r = run(false);
    expect(r.walkForward!.status).toBe("leakage_detected");
    const valB = r.walkForward!.boundaries[0];
    expect(valB.toCohort).toBe("validation");
    expect(valB.contaminatedCount).toBe(1);
    expect(valB.contamination[0].setupId).toBe("leaky");
    // No purged blocks without the explicit flag.
    expect(r.splits![0].purged).toBeUndefined();
    // Raw aggregate still contains BOTH train rows.
    expect(r.splits![0].aggregate.scenarioCount).toBe(2);
    expect(r.warnings.some((w) => /boundary → validation.*leak|contaminated/i.test(w))).toBe(true);
  });

  it("purged metrics recompute denominators, dependence and CIs from retained rows only", () => {
    const r = run(true);
    expect(r.walkForward!.status).toBe("purged");
    const train = r.splits![0];
    expect(train.aggregate.scenarioCount).toBe(2);      // raw untouched
    expect(train.aggregate.realizedCount).toBe(2);
    const p = train.purged!;
    expect(p.rule).toBe(BOUNDARY_PURGE_RULE);
    expect(p.purgedCount).toBe(1);
    expect(p.purgedSetupIds).toEqual(["leaky"]);
    expect(p.retainedCount).toBe(1);
    // Purged denominators are genuinely recomputed — not relabeled.
    expect(p.aggregate!.scenarioCount).toBe(1);
    expect(p.aggregate!.realizedCount).toBe(1);
    expect(p.aggregate!.realizedWins + p.aggregate!.realizedLosses + p.aggregate!.realizedBreakevens).toBe(1);
    // Dependence re-derived on the retained slice — a singleton has 1 cluster.
    expect(p.aggregate!.dependence!.clusters).toBe(1);
    // Final cohort is never purged — it has no later boundary.
    expect(r.splits![2].purged).toBeUndefined();
  });

  it("empty purged samples degrade safely — no fabricated interval", () => {
    // Train = only the leaky row (trainPct 0.25 → floor(4*0.25)=1 row).
    const r = runHistoricalValidation({
      cells: [cell(candles)],
      config: { horizonBars: 40, split: { trainPct: 0.25, validationPct: 0.25 }, purgeBoundaries: true },
      deps: { config: defaultConfig(), run: mkRun(setups) },
    });
    // Train = [safe] only — boundary to validation: safe resolves at 8 → clean, nothing purged.
    const train = r.splits![0];
    expect(train.purged!.purgedCount).toBe(0);
    // Validation = [leaky] — resolves at 35, short of test's first consumed
    // bar (46) → clean. Contaminate validation directly with a row resolving
    // past bar 46.
    const leaky2 = mkSetup({ ...bull().metadata!, confirmBar: 30, activeBar: 31, targetReachedBar: 50, targetBars: "50" }, { id: "vleak" });
    const r2 = runHistoricalValidation({
      cells: [cell(candles)],
      config: { horizonBars: 40, split: { trainPct: 0.5, validationPct: 0.25 }, purgeBoundaries: true },
      deps: { config: defaultConfig(), run: mkRun([setups[0], setups[1], leaky2, setups[3]]) },
    });
    const val = r2.splits![1]; // validation = [vleak]; its window reaches the test cohort
    expect(val.purged!.purgedCount).toBe(1);
    expect(val.purged!.retainedCount).toBe(0);
    expect(val.purged!.aggregate!.realizedCount).toBe(0);           // empty purged sample
    expect(val.purged!.aggregate!.uncertainty?.expectancyR).toBeUndefined(); // refused, not fabricated
  });

  it("censored/M2M rows in the retained set are never reclassified as realized", () => {
    // Train: leaky realized row + a censored (M2M) row anchored before the boundary.
    const mtm = mkSetup({ ...bull().metadata!, confirmBar: 8, activeBar: 9 }, { id: "mtm" }); // censored at horizon end
    const r = runHistoricalValidation({
      cells: [cell(candles)],
      config: { horizonBars: 10, split: { trainPct: 0.5, validationPct: 0.25 }, purgeBoundaries: true },
      deps: { config: defaultConfig(), run: mkRun([setups[0], mtm, setups[2], setups[3]]) },
    });
    const p = r.splits![0].purged!;
    // safe resolves at 8 < 31 → retained; mtm censored at 18 < 31 → retained.
    expect(p.retainedCount).toBe(2);
    expect(p.aggregate!.mtmCount).toBe(1);
    expect(p.aggregate!.realizedCount).toBe(1); // censored row stays M2M in purged stats
    expect(p.aggregate!.realizedWins).toBe(1);
  });

  it("repeated runs are bit-identical — purge is deterministic", () => {
    const a = run(true);
    const b = run(true);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(JSON.stringify(a.splits)).toBe(JSON.stringify(b.splits));
    expect(JSON.stringify(a.walkForward)).toBe(JSON.stringify(b.walkForward));
    // But the purge flag itself is bound into the fingerprint.
    expect(run(false).fingerprint).not.toBe(a.fingerprint);
  });

  it("frozen scenarios and causal evaluation are untouched by purging", () => {
    const a = run(false);
    const b = run(true);
    // Same frozen scenario artifacts, statuses, and outcomes — only cohort STATISTICS differ.
    expect(b.scenarios.map((s) => [s.setupId, s.status, s.resolvedBar])).toEqual(
      a.scenarios.map((s) => [s.setupId, s.status, s.resolvedBar]));
    expect(b.aggregate).toEqual(a.aggregate); // run-level aggregate identical
    expect(b.splits![0].aggregate).toEqual(a.splits![0].aggregate); // raw cohort identical
    expect(b.methodology.boundaryPolicy).toMatch(/purged aggregates emitted/);
    expect(a.methodology.boundaryPolicy).toMatch(/diagnostics only/);
  });
});

// ---------------------------------------------------------------------------
// Boundary semantics audit — per-series partitions, anchor-time ordering,
// union purging, and consumed-domain semantics (regression + invariants).
// ---------------------------------------------------------------------------

describe("boundary semantics audit", () => {
  /** Minimal scenario row — analyzer-level tests need no engine evaluation. */
  const mkRow = (o: { id: string; a: number; r?: number; sym?: string; tf?: ValidatedScenario["timeframe"]; st?: ValidatedScenario["status"] }): ValidatedScenario => ({
    setupId: o.id, setupType: "reversal", direction: "bullish",
    symbol: o.sym ?? "SYN", timeframe: o.tf ?? "1m",
    anchorBar: o.a, anchorTime: new Date(BASE + Math.max(0, o.a) * BAR).toISOString(),
    scenario: { entryBandLow: 1, entryBandHigh: 2, invalidation: 0.5, targets: [3] },
    status: o.st ?? "target",
    resolvedBar: o.r,
    ...(o.r !== undefined ? { resolvedAt: new Date(BASE + o.r * BAR).toISOString() } : {}),
  });
  const mkSplits = (rows: ValidatedScenario[], ranges: [SplitAggregate["name"], number, number][]): SplitAggregate[] =>
    ranges.map(([name, from, to]) => ({
      name, fromScenario: from, toScenario: to,
      anchorFrom: rows[from]?.anchorTime, anchorTo: rows[to - 1]?.anchorTime,
      aggregate: aggregateScenarios(rows.slice(from, to)),
    }));

  it("per-series boundary: an earlier row is checked against ITS OWN series' partition", () => {
    // Old defect: boundary reference = firstLater's series only — an earlier
    // SYN row was never checked when the first later row was ETH.
    const rows = [
      mkRow({ id: "a", a: 5, r: 50 }),            // SYN, reaches deep
      mkRow({ id: "b", a: 2, r: 3, sym: "ETH" }), // ETH, safe
      mkRow({ id: "e", a: 10, r: 11, sym: "ETH" }),// later cohort, FIRST row — ETH
      mkRow({ id: "c", a: 20, r: 22 }),            // later cohort, SYN
    ];
    const splits = mkSplits(rows, [["train", 0, 2], ["test", 2, 4]]);
    const [b] = analyzeBoundaryLeakage(rows, splits);
    expect(b.contaminatedCount).toBe(1);
    expect(b.contamination[0].setupId).toBe("a"); // SYN row flagged vs SYN partition
    expect(b.contamination[0].boundaryAnchorBar).toBe(20);
    expect(b.perSeries.map((p) => p.series).sort()).toEqual(["ETH@1m", "SYN@1m"]);
    expect(b.boundaryBar).toBe(11); // earliest held-out consumed bar overall (ETH 10+1)
    // ETH row 'b' (r3 < ETH partition 11) is clean.
    expect(b.contamination.some((c) => c.setupId === "b")).toBe(false);
  });

  it("an unevaluable first later row cannot fabricate a boundary at bar 0", () => {
    // Old defect: firstLater.anchorBar === -1 → firstConsumed 0 → every
    // earlier row "contaminated". Now only boundable rows define the partition.
    const rows = [
      mkRow({ id: "a", a: 5, r: 10 }),
      mkRow({ id: "u", a: -1, st: "unevaluable" }), // consumed nothing
      mkRow({ id: "c", a: 20, r: 22 }),
    ];
    const splits = mkSplits(rows, [["train", 0, 1], ["test", 1, 3]]);
    const [b] = analyzeBoundaryLeakage(rows, splits);
    expect(b.status).toBe("clean");
    expect(b.contaminatedCount).toBe(0);
    expect(b.boundaryAnchorBar).toBe(20); // 'c' bounds the partition, not 'u'
  });

  it("a series that exists later but cannot be bounded makes the boundary indeterminate", () => {
    const rows = [
      mkRow({ id: "a", a: 5, r: 10 }),
      mkRow({ id: "u", a: -1, st: "unevaluable" }), // only SYN row in later cohort
    ];
    const splits = mkSplits(rows, [["train", 0, 1], ["test", 1, 2]]);
    const [b] = analyzeBoundaryLeakage(rows, splits);
    expect(b.status).toBe("indeterminate");
    expect(b.unverifiableCount).toBe(1); // 'a' — SYN partition exists but unboundable
    expect(b.perSeries).toHaveLength(0);   // no boundable series → no boundary claim
  });

  it("purging unions flags across ALL later boundaries — K→K+2 leaks purge cohort K", () => {
    // Old defect: only the immediately-adjacent boundary was consulted; a
    // train-SYN row leaking into test (when validation had no SYN rows)
    // survived train's purged statistics.
    const rows = [
      mkRow({ id: "a", a: 5, r: 50 }),           // train, SYN — reaches test
      mkRow({ id: "v", a: 20, r: 22, sym: "ETH" }),// validation, ETH only
      mkRow({ id: "t", a: 40, r: 42 }),           // test, SYN
    ];
    const splits = mkSplits(rows, [["train", 0, 1], ["validation", 1, 2], ["test", 2, 3]]);
    const boundaries = analyzeBoundaryLeakage(rows, splits);
    // Not flagged at →validation (no SYN partition there) — flagged at →test.
    expect(boundaries[0].contamination).toHaveLength(0);
    expect(boundaries[1].contamination.map((c) => c.setupId)).toEqual(["a"]);
    const purged = purgeCohortSlice(rows.slice(0, 1), boundaries.slice(0), 0);
    expect(purged.purgedCount).toBe(1);
    expect(purged.purgedSetupIds).toEqual(["a"]);
    expect(purged.purgeReasons).toEqual([{ setupId: "a", intoCohort: "test", barsIntoLaterCohort: 10 }]);
    expect(purged.retainedCount).toBe(0);
  });

  it("a row flagged at two boundaries is purged ONCE with a reason per boundary", () => {
    const rows = [
      mkRow({ id: "a", a: 5, r: 50 }), mkRow({ id: "x", a: 10, r: 12 }),
      mkRow({ id: "v", a: 20, r: 22 }), mkRow({ id: "t", a: 40, r: 42 }),
    ];
    const splits = mkSplits(rows, [["train", 0, 2], ["validation", 2, 3], ["test", 3, 4]]);
    const boundaries = analyzeBoundaryLeakage(rows, splits);
    const purged = purgeCohortSlice(rows.slice(0, 2), boundaries.slice(0), 0);
    expect(purged.purgedCount).toBe(1);                       // one ROW, not two flags
    expect(purged.purgedSetupIds).toEqual(["a"]);
    expect(purged.purgeReasons.map((r) => r.intoCohort)).toEqual(["validation", "test"]);
  });

  it("laterBarsTouched counts only bars a later row actually consumed", () => {
    // Later domain: (20,22] ∪ (30,32]; earlier row consumes (5,35].
    // Intersection = {21,22,31,32} — 4 bars, not the 12-bar envelope.
    const rows = [
      mkRow({ id: "a", a: 5, r: 35 }),
      mkRow({ id: "c1", a: 20, r: 22 }), mkRow({ id: "c2", a: 30, r: 32 }),
    ];
    const splits = mkSplits(rows, [["train", 0, 1], ["test", 1, 3]]);
    const [b] = analyzeBoundaryLeakage(rows, splits);
    expect(b.contaminatedCount).toBe(1);
    expect(b.laterBarsTouched).toBe(4);
  });

  it("a not_filled row's no-fill verdict consumed its whole window — it can contaminate", () => {
    const rows = [
      mkRow({ id: "nf", a: 5, r: 30, st: "not_filled" }),
      mkRow({ id: "c", a: 20, r: 22 }),
    ];
    const splits = mkSplits(rows, [["train", 0, 1], ["test", 1, 2]]);
    const [b] = analyzeBoundaryLeakage(rows, splits);
    expect(b.contamination.map((c) => c.setupId)).toEqual(["nf"]);
  });

  it("dependence diagnostics compare bars only inside one series", () => {
    // SYN a5→r20 window; ETH a10→r12 (coincidentally-overlapping INDICES,
    // incomparable series); SYN a12→r13 genuinely overlaps the SYN window.
    const rows = [
      mkRow({ id: "s1", a: 5, r: 20 }),
      mkRow({ id: "e1", a: 10, r: 12, sym: "ETH" }),
      mkRow({ id: "s2", a: 12, r: 13 }),
    ];
    const dep = analyzeDependence([...rows]);
    expect(dep.overlappingPairs).toBe(1);   // only s1↔s2 — never s1↔e1
    expect(dep.uniqueAnchors).toBe(3);      // 5/10/12 across TWO series are distinct
    expect(dep.clusters).toBe(2);           // SYN chain + ETH singleton
    expect(rows[1].overlapsNext).toBeUndefined(); // ETH row joins nothing
  });
});

describe("boundary invariants — table-driven", () => {
  const candles = series(60);
  const mkRow = (id: string, a: number, r?: number, sym = "SYN"): ValidatedScenario => ({
    setupId: id, setupType: "reversal", direction: "bullish", symbol: sym, timeframe: "1m",
    anchorBar: a, anchorTime: new Date(BASE + a * BAR).toISOString(),
    scenario: { entryBandLow: 1, entryBandHigh: 2, invalidation: 0.5, targets: [3] },
    status: "target", resolvedBar: r,
    ...(r !== undefined ? { resolvedAt: new Date(BASE + r * BAR).toISOString() } : {}),
  });
  const mkSplits = (rows: ValidatedScenario[], ranges: [SplitAggregate["name"], number, number][]): SplitAggregate[] =>
    ranges.map(([name, from, to]) => ({
      name, fromScenario: from, toScenario: to,
      aggregate: aggregateScenarios(rows.slice(from, to)),
    }));

  // Invariant 1+2: crossing exists iff resolvedBar > later cohort's earliest
  // same-series anchor. Moving resolution EARLIER never creates a crossing.
  it.each([
    [19, false], [20, false], [21, true], [30, true],
  ])("resolvedBar %i vs boundaryAnchor 20 → contaminated=%s", (r, expected) => {
    const rows = [mkRow("a", 5, r), mkRow("b", 20, 22)];
    const splits = mkSplits(rows, [["train", 0, 1], ["test", 1, 2]]);
    const [b] = analyzeBoundaryLeakage(rows, splits);
    expect(b.contaminatedCount).toBe(expected ? 1 : 0);
    expect(b.status).toBe(expected ? "leakage_detected" : "clean");
  });

  // Invariant: an outcome resolved early is NOT purged merely because its
  // configured horizon would have reached the boundary.
  it("early resolution inside a wide horizon never counts as a crossing", () => {
    const early = evaluateScenario({
      setup: mkSetup({ ...bull().metadata!, confirmBar: 5, activeBar: 6, targetReachedBar: 8, targetBars: "8" }, { id: "early" }),
      candles, config: { horizonBars: 60 }, // window COULD reach 65 — it didn't
    });
    const late = evaluateScenario({
      setup: mkSetup({ ...bull().metadata!, confirmBar: 20, activeBar: 21, targetReachedBar: 22, targetBars: "22" }, { id: "late" }),
      candles, config: { horizonBars: 60 },
    });
    const splits = mkSplits([early, late], [["train", 0, 1], ["test", 1, 2]]);
    const [b] = analyzeBoundaryLeakage([early, late], splits);
    expect(early.resolvedBar).toBe(8); // actual consumed window, not the horizon
    expect(b.contaminatedCount).toBe(0);
  });

  // Invariant 6: identical indices from unrelated series are never overlap.
  it.each([["ETH", "1m"], ["SYN", "5m"]] as const)(
    "different series (%s@%s) never contaminate by index coincidence", (sym, tf) => {
      const rows = [
        mkRow("a", 5, 50), // SYN@1m reaching bar 50
        { ...mkRow("c", 10, 12), symbol: sym, timeframe: tf as ValidatedScenario["timeframe"] },
      ];
      const splits = mkSplits(rows, [["train", 0, 1], ["test", 1, 2]]);
      const [b] = analyzeBoundaryLeakage(rows, splits);
      expect(b.contaminatedCount).toBe(0);
      expect(b.unverifiableCount).toBe(0); // verifiably clean — series proven absent
      expect(b.status).toBe("clean");
    });

  // Invariant 7: an unkeyed CONSUMING later row poisons verification globally.
  it("a later row with missing series identity makes the boundary indeterminate", () => {
    const rows = [
      mkRow("a", 5, 8),
      { ...mkRow("c", 20, 22), symbol: undefined, timeframe: undefined },
    ];
    const splits = mkSplits(rows, [["train", 0, 1], ["test", 1, 2]]);
    const [b] = analyzeBoundaryLeakage(rows, splits);
    expect(b.status).toBe("indeterminate"); // 'c' could be on ANY series
    expect(b.unverifiableCount).toBe(1);
  });

  // Invariant 8: shared anchors inside the later cohort keep one boundary.
  it("later rows sharing an anchor still produce a single same-series boundary", () => {
    const rows = [
      mkRow("a", 5, 30),
      mkRow("c1", 20, 22), mkRow("c2", 20, 25), // same anchor, different windows
    ];
    const splits = mkSplits(rows, [["train", 0, 1], ["test", 1, 3]]);
    const [b] = analyzeBoundaryLeakage(rows, splits);
    expect(b.boundaryAnchorBar).toBe(20);
    expect(b.contaminatedCount).toBe(1);
    expect(b.perSeries).toHaveLength(1);
  });

  // Invariant: non-contiguous source bars (session/day gaps) — index
  // semantics are unchanged; the boundary is an INDEX, not a timestamp delta.
  it("a timestamp gap inside a series does not perturb index semantics", () => {
    const gapped = mkCandles(Array.from({ length: 60 }, (_, i) => [100 + i, 101 + i, 99 + i, 100.5 + i] as [number, number, number, number]))
      .map((k, i) => (i >= 30 ? { ...k, time: k.time + 86_400_000 } : k)); // day gap after bar 29
    const a = evaluateScenario({
      setup: mkSetup({ ...bull().metadata!, confirmBar: 5, activeBar: 6, targetReachedBar: 35, targetBars: "35" }, { id: "g" }),
      candles: gapped, config: { horizonBars: 60 },
    });
    const c = evaluateScenario({
      setup: mkSetup({ ...bull().metadata!, confirmBar: 20, activeBar: 21, targetReachedBar: 22, targetBars: "22" }, { id: "c" }),
      candles: gapped, config: { horizonBars: 60 },
    });
    const splits = mkSplits([a, c], [["train", 0, 1], ["test", 1, 2]]);
    const [b] = analyzeBoundaryLeakage([a, c], splits);
    expect(b.contamination[0].barsIntoLaterCohort).toBe(15); // index arithmetic, not time
  });

  // Invariants 3+5+9 at run level: purging changes nothing raw, purged CIs use
  // only retained realized rows, and repeat runs are identical.
  it("run-level invariants: raw preserved, purged CI realized-only, deterministic", () => {
    const setups = [
      mkSetup({ ...bull().metadata!, confirmBar: 5, activeBar: 6, targetReachedBar: 8, targetBars: "8" }, { id: "safe" }),
      mkSetup({ ...bull().metadata!, confirmBar: 10, activeBar: 11, targetReachedBar: 35, targetBars: "35" }, { id: "leaky" }),
      mkSetup({ ...bull().metadata!, confirmBar: 30, activeBar: 31, targetReachedBar: 33, targetBars: "33" }, { id: "val" }),
      mkSetup({ ...bull().metadata!, confirmBar: 45, activeBar: 46, targetReachedBar: 48, targetBars: "48" }, { id: "test" }),
    ];
    const mkRun2 = (ss: Setup[]) =>
      (input: Parameters<typeof import("@/lib/engines/backtest").runBacktest>[0]) => {
        for (const s of ss) input.onMeasuredSetup?.(s);
        return { ok: true as const, data: fakeEngineResult([]), errors: [], meta: { stage: "x", paramsVersion: "", barsConsumed: { from: 0, to: 0 }, events: [] } };
      };
    const cfg = (purge: boolean): ValidationRunConfig => ({
      horizonBars: 40, split: { trainPct: 0.5, validationPct: 0.25 },
      ...(purge ? { purgeBoundaries: true } : {}),
    });
    const dep = { config: defaultConfig(), run: mkRun2(setups) };
    const raw = runHistoricalValidation({ cells: [cell(candles)], config: cfg(false), deps: dep });
    const pur = runHistoricalValidation({ cells: [cell(candles)], config: cfg(true), deps: dep });
    // Raw cohort membership + aggregates identical across modes.
    expect(pur.splits!.map((s) => [s.name, s.fromScenario, s.toScenario])).toEqual(
      raw.splits!.map((s) => [s.name, s.fromScenario, s.toScenario]));
    for (let i = 0; i < 3; i++) expect(pur.splits![i].aggregate).toEqual(raw.splits![i].aggregate);
    // Purged CI denominator = retained realized rows only.
    const p = pur.splits![0].purged!;
    expect(p.aggregate!.realizedCount).toBe(1);
    expect(p.aggregate!.uncertainty!.winRate!.n).toBe(1); // realized denominator, never mtm
    // Deterministic.
    const pur2 = runHistoricalValidation({ cells: [cell(candles)], config: cfg(true), deps: dep });
    expect(JSON.stringify(pur.splits)).toBe(JSON.stringify(pur2.splits));
    expect(pur.fingerprint).toBe(pur2.fingerprint);
    // Purged aggregates never change the RUN-level aggregate either.
    expect(pur.aggregate).toEqual(raw.aggregate);
  });

  // Invariant: anchor-TIME ordering across series — index order is not time.
  it("cohort membership follows anchor TIME, not raw confirmBar index", () => {
    const alt = series(60).map((k) => ({ ...k, time: k.time + 100 * BAR })); // starts 100 bars later in WALL CLOCK
    const cellAlt: BacktestCell = { symbol: "ALT", timeframe: "1m", series: { symbol: "ALT", timeframe: "1m", candles: alt } };
    // syn1 anchors at t=BASE+40 on SYN; alt1 anchors at bar 5 but t=BASE+105 on ALT.
    // Raw-index order would put alt1 first (5 < 40) — WRONG chronologically.
    const setups = [
      mkSetup({ ...bull().metadata!, confirmBar: 40, activeBar: 41, targetReachedBar: 43, targetBars: "43" }, { id: "syn1", symbol: "SYN" }),
      mkSetup({ ...bull().metadata!, confirmBar: 5, activeBar: 6, targetReachedBar: 8, targetBars: "8" }, { id: "alt1", symbol: "ALT" }),
    ];
    const r = runHistoricalValidation({
      cells: [cell(candles), cellAlt],
      config: { horizonBars: 40, split: { trainPct: 0.5, validationPct: 0 } },
      deps: {
        config: defaultConfig(),
        run: (input) => {
          for (const s of setups) input.onMeasuredSetup?.(s);
          return { ok: true as const, data: fakeEngineResult([]), errors: [], meta: { stage: "x", paramsVersion: "", barsConsumed: { from: 0, to: 0 }, events: [] } };
        },
      },
    });
    expect(r.scenarios.map((s) => s.setupId)).toEqual(["syn1", "alt1"]); // time order
    expect(r.splits![0].aggregate.scenarioCount).toBe(1); // train = earlier ANCHOR TIME
  });
});

// ---------------------------------------------------------------------------
// Sign-off fixture — one end-to-end run, every stage asserted against values
// computed by hand from the canonical contracts (specs 04/10/17 + hv1).
// ---------------------------------------------------------------------------

describe("end-to-end integrity fixture", () => {
  /**
   * Two compatible series on the same bar grid: AAA and BBB @1m, 40 bars each,
   * flat drift (bar i closes at 100 + 0.5(i+1)). horizonBars=25 so terminal
   * stamps through bar 25 stay observable.
   *
   *   s5  AAA no confirmBar            -> unevaluable, consumed nothing
   *   s1  AAA cb=2  active=3  tgt=20   -> target, netR=(110-101)/3 = 3
   *   s3  BBB cb=5  active=6  inv=7    -> stop, remainder exits close[7]=104 -> netR=1
   *   s2  AAA cb=8  active=9  no term  -> censored @hEnd=33, m2m netR=(117-101)/3=5.3333
   *   s6  AAA cb=10 no activeBar       -> not_filled, consumed (10,35]
   *   s7  BBB cb=18 active=19 inv=25   -> stop, exits close[25]=113 -> netR=4
   *
   * Anchor-time order: s5(BASE fallback), s1(t2), s3(t5), s2(t8), s6(t10), s7(t18).
   * split 0.5/0.17 -> train=[0,3) val=[3,4) test=[4,6): s1's window (2,20] crosses
   * BOTH later partitions -> deliberate contamination, two purge reasons.
   */
  const candles = series(40);
  const mkCell = (symbol: string, frames?: BacktestCell["frames"]): BacktestCell => ({
    symbol, timeframe: "1m",
    series: { symbol, timeframe: "1m", candles } as CandleSeries,
    ...(frames !== undefined ? { frames } : {}),
  });
  const lv = (cb: number) => ({ confirmBar: cb, entryBandLow: 100, entryBandHigh: 101, invalidation: 98, targets: "110" });
  const setups: Setup[] = [
    mkSetup(lv(2), { id: "s1", symbol: "AAA", metadata: { ...lv(2), activeBar: 3, targetReachedBar: 20, targetBars: "20" } }),
    mkSetup({}, { id: "s5", symbol: "AAA" }),
    mkSetup(lv(5), { id: "s3", symbol: "BBB", metadata: { ...lv(5), activeBar: 6, invalidatedBar: 7 } }),
    mkSetup(lv(8), { id: "s2", symbol: "AAA", metadata: { ...lv(8), activeBar: 9 } }),
    mkSetup(lv(10), { id: "s6", symbol: "AAA" }),
    mkSetup(lv(18), { id: "s7", symbol: "BBB", metadata: { ...lv(18), activeBar: 19, invalidatedBar: 25 } }),
  ];
  const frame: CandleSeries = { symbol: "AAA", timeframe: "4h", candles: series(12) } as CandleSeries;
  let engineCells: BacktestCell[] | undefined;
  const run: typeof import("@/lib/engines/backtest").runBacktest = (input) => {
    engineCells = input.cells;
    for (const s of setups) input.onMeasuredSetup?.(s);
    return { ok: true as const, data: fakeEngineResult([]), errors: [], meta: { stage: "x", paramsVersion: "", barsConsumed: { from: 0, to: 0 }, events: [] } };
  };
  const cfg: ValidationRunConfig = { horizonBars: 25, split: { trainPct: 0.5, validationPct: 0.17 }, purgeBoundaries: true };
  const deps = { config: defaultConfig(), run };

  it("every stage agrees — provenance through fingerprint", () => {
    const r = runHistoricalValidation({ cells: [mkCell("AAA", { htf: frame }), mkCell("BBB")], config: cfg, deps });

    // (1) Parsed input & series identity — both datasets recorded verbatim.
    expect(r.datasets.map((d) => `${d.symbol}@${d.timeframe}:${d.bars}`)).toEqual(["AAA@1m:40", "BBB@1m:40"]);

    // (2) Causal frame availability — the transport delivered the htf frame intact.
    expect(engineCells?.[0].frames?.htf?.candles).toHaveLength(12);

    // (3) Scenario eligibility & outcome — canonical statuses, exact netR.
    const byId = new Map(r.scenarios.map((s) => [s.setupId, s]));
    expect(r.scenarios.map((s) => s.setupId)).toEqual(["s5", "s1", "s3", "s2", "s6", "s7"]);
    expect(byId.get("s5")!.status).toBe("unevaluable");
    expect(byId.get("s1")!.status).toBe("target");
    expect(byId.get("s1")!.netR).toBeCloseTo(3, 4);
    expect(byId.get("s3")!.status).toBe("stop");
    expect(byId.get("s3")!.netR).toBeCloseTo(1, 4);
    expect(byId.get("s2")!.status).toBe("censored");
    expect(byId.get("s2")!.netR).toBeCloseTo(5.3333, 3);
    expect(byId.get("s6")!.status).toBe("not_filled");
    expect(byId.get("s7")!.status).toBe("stop");
    expect(byId.get("s7")!.netR).toBeCloseTo(4, 4);

    // (4) Raw cohort aggregates — contiguous, hand-computed membership.
    expect(r.splits!.map((s) => s.aggregate.scenarioCount)).toEqual([3, 1, 2]);
    expect(r.aggregate.filledCount).toBe(4); // s1,s3,s2,s7 activated
    expect(r.aggregate.realizedCount).toBe(3); // censored s2 excluded
    expect(r.aggregate.mtmCount).toBe(1);
    expect(r.aggregate.realizedWinRate).toBe(1); // 3/3 realized are wins
    expect(r.aggregate.realizedExpectancyR).toBeCloseTo(8 / 3, 4); // (3+1+4)/3

    // (5) Boundary diagnostics — per-series, two deliberate contaminations.
    const [bv, bt] = r.walkForward!.boundaries;
    expect(bv.toCohort).toBe("validation");
    expect(bv.contaminatedCount).toBe(1);
    expect(bv.contamination[0]).toMatchObject({
      setupId: "s1", scenarioIndex: 1, series: "AAA@1m",
      boundaryAnchorBar: 8, barsIntoLaterCohort: 12, fromCohort: "train",
    });
    expect(bv.laterBarsTouched).toBe(12); // (2,20] intersect s2's consumed [9,33]
    expect(bt.contaminatedCount).toBe(2); // s1 AND s2 reach the test partition
    expect(bt.laterBarsTouched).toBe(23); // merged [11,33] on AAA; BBB untouched
    expect(bt.perSeries.map((p) => `${p.series}:${p.boundaryAnchorBar}`))
      .toEqual(["AAA@1m:10", "BBB@1m:18"]);
    expect(r.walkForward!.status).toBe("purged");

    // (6) Purged membership — s1 removed from train for BOTH crossings, once.
    const trainP = r.splits![0].purged!;
    expect(trainP.purgedCount).toBe(1);
    expect(trainP.retainedCount).toBe(2);
    expect(trainP.purgeReasons.map((p) => p.intoCohort)).toEqual(["validation", "test"]);
    expect(trainP.aggregate!.realizedExpectancyR).toBeCloseTo(1, 4); // only s3 realized
    const valP = r.splits![1].purged!;
    expect(valP.purgedCount).toBe(1); // s2 leaks into test -> purged from validation
    expect(valP.aggregate!.scenarioCount).toBe(0);

    // (7) Realized vs censored denominators in the purged train aggregate.
    expect(trainP.aggregate!.realizedCount).toBe(1);
    expect(trainP.aggregate!.mtmCount).toBe(0);

    // (8) Dependence — AAA {s1,s2,s6} overlap transitively; BBB rows never pair
    //     with AAA rows; s5 (no window) closes nothing and counts anchor -1.
    expect(r.aggregate.dependence).toMatchObject({
      uniqueAnchors: 6, overlappingPairs: 3, overlappingWindows: 2,
      clusters: 3, largestCluster: 3,
    });

    // (9) Uncertainty — n_realized=3 < 8: bootstrap refused, labelled fallbacks.
    const u = r.aggregate.uncertainty!;
    expect(u.winRate!.method).toBe("wilson-score");
    expect(u.winRate!.point).toBe(1);
    expect(u.winRate!.n).toBe(3);
    expect(u.expectancyR!.method).toBe("student-t");
    expect(u.expectancyR!.caveat).toMatch(/iid assumption violated/);
    expect(u.notes.some((n) => /bootstrap refused/i.test(n))).toBe(true);

    // (10) Fingerprint + repeat-run equality (evaluatedAt is wall-clock run
    //      metadata — excluded from the content fingerprint by design).
    const again = runHistoricalValidation({ cells: [mkCell("AAA", { htf: frame }), mkCell("BBB")], config: cfg, deps });
    expect(again.fingerprint).toBe(r.fingerprint);
    expect(again.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(again.scenarios)).toBe(JSON.stringify(r.scenarios));
    expect(JSON.stringify(again.walkForward)).toBe(JSON.stringify(r.walkForward));
  });

  it("fingerprint binds frame OHLC — a high/low change with identical closes changes the run identity", () => {
    const frames = (open: number): BacktestCell["frames"] => ({
      htf: { symbol: "AAA", timeframe: "4h", candles: series(12).map((c, i) => i === 5 ? { ...c, open, high: open + 0.2 } : c) } as CandleSeries,
    });
    // Before the fix only time+close were hashed — these two frames hash alike
    // despite different candles feeding structure/momentum analysis.
    const a = runHistoricalValidation({ cells: [mkCell("AAA", frames(200)), mkCell("BBB")], config: cfg, deps });
    const b = runHistoricalValidation({ cells: [mkCell("AAA", frames(300)), mkCell("BBB")], config: cfg, deps });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});
