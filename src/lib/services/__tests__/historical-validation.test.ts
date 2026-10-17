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
import type { BacktestCell, Candle, Setup, SystemBacktestResult } from "@/lib/types";
import {
  aggregateScenarios,
  evaluateScenario,
  runHistoricalValidation,
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
      cells: [cell(series(10))], config: { horizonBars: 5, split: { trainPct: 0.9, validationPct: 0.2 } },
      deps: { config: defaultConfig() },
    })).toThrow(/split/);
  });
});
