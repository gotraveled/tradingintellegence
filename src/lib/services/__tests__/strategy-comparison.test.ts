/**
 * Strategy Comparison Lab — deterministic tests (comp-v1 protocol).
 *
 * Same fixture discipline as historical-validation.test.ts: crafted Setup
 * artifacts carry the lifecycle stamps the canonical detectors would emit;
 * outcomes are measured by canonical spec-17 measureOutcome inside
 * runHistoricalValidation. The stub `run` seam emits different setup sets per
 * engineConfig version so strategies produce KNOWN, different results —
 * these tests verify the comparison layer's fairness, freezing, aggregation,
 * and fingerprint rules, never engine detection.
 */
import { describe, expect, it, vi } from "vitest";
import type { BacktestCell, Candle, Setup, SystemBacktestResult } from "@/lib/types";
import { defaultConfig } from "../engine-defaults";
import {
  COMPARISON_PROTOCOL_VERSION,
  runStrategyComparison,
  stableStringify,
  type ComparisonSharedConfig,
  type ComparisonStrategy,
} from "../strategy-comparison";

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const BAR = 60_000;

const mkCandles = (specs: [number, number, number, number][]): Candle[] =>
  specs.map(([o, h, l, c], i) => ({
    time: BASE + i * BAR,
    open: o, high: h, low: l, close: c,
  }));

/** Flat drift — bar i closes at 100 + 0.5(i+1). */
const series = (n: number, start = 100, step = 0.5): Candle[] => {
  const specs: [number, number, number, number][] = [];
  let c = start;
  for (let i = 0; i < n; i += 1) {
    const nc = c + step;
    specs.push([c, Math.max(c, nc) + 0.2, Math.min(c, nc) - 0.2, nc]);
    c = nc;
  }
  return mkCandles(specs);
};

const mkSetup = (meta: Setup["metadata"], over: Partial<Setup> = {}): Setup => ({
  id: over.id ?? "s1",
  symbol: "AAA",
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

const lv = (cb: number) => ({ confirmBar: cb, entryBandLow: 100, entryBandHigh: 101, invalidation: 98, targets: "110" });

const cell = (symbol = "AAA", candles = series(40)): BacktestCell => ({
  symbol, timeframe: "1m",
  series: { symbol, timeframe: "1m", candles },
});

const SHARED: ComparisonSharedConfig = { horizonBars: 25 };

const fakeResult = (): SystemBacktestResult => ({
  runId: "x",
  cells: [{ symbol: "AAA", timeframe: "1m" }],
  opportunities: [],
  developing: [],
  outcomes: [],
  aggregate: {
    observationCount: 0, developingObservationCount: 0, uniqueSetupCount: 0,
    selectedObservationCount: 0, resolvedOutcomeCount: 0,
    outcomeCounts: { target: 0, stop: 0, expired: 0, cancelled: 0, unresolved: 0 },
  },
  versions: { methodVersion: "v1-bt", paramsVersion: "x", configVersion: "v1-engine" },
});

/**
 * Stub engine — emits the setup set registered for `config.version`, so two
 * strategies = two versions = two KNOWN scenario universes. Runs are counted
 * to prove strategy resolution happens before any run executes.
 */
function stubRun(byVersion: Record<string, Setup[]>) {
  const calls: { version: string | undefined }[] = [];
  const run: typeof import("@/lib/engines/backtest").runBacktest = (input) => {
    const version = input.config?.version;
    calls.push({ version });
    for (const s of byVersion[version ?? ""] ?? []) input.onMeasuredSetup?.(s);
    return { ok: true as const, data: fakeResult(), errors: [], meta: { stage: "x", paramsVersion: "", barsConsumed: { from: 0, to: 0 }, events: [] } };
  };
  return { run, calls };
}

const strategy = (id: string, version: string, selection?: ComparisonStrategy["selection"]): ComparisonStrategy => ({
  id,
  engineConfig: { ...defaultConfig(), version },
  ...(selection !== undefined ? { selection } : {}),
});

// Two known strategy universes on one 40-bar series:
//   A "v-a": two scenarios — tgt (cb=2, active=3, tgt=20 → netR=3) and
//            stop (cb=8, active=9, inv=12 → exits close[12]=106.5 → netR=(106.5-101)/3≈1.833)
//   B "v-b": three scenarios — the same tgt, the same stop, plus a censored
//            row (cb=10, active=11, no terminal → m2m at hEnd=35, close=117.5 → netR≈5.5)
const A: Setup[] = [
  mkSetup({ ...lv(2), activeBar: 3, targetReachedBar: 20, targetBars: "20" }, { id: "a1" }),
  mkSetup({ ...lv(8), activeBar: 9, invalidatedBar: 12 }, { id: "a2" }),
];
const B: Setup[] = [
  ...A.map((s) => ({ ...s, id: `b${s.id.slice(1)}` })),
  mkSetup({ ...lv(10), activeBar: 11 }, { id: "b3" }),
];
const strategies = (): ComparisonStrategy[] => [strategy("alpha", "v-a"), strategy("beta", "v-b")];
const byVersion = { "v-a": A, "v-b": B };

describe("comp-v1 protocol — happy path and frozen inputs", () => {
  it("two strategies on one protocol → two evaluated rows with known results", () => {
    const { run, calls } = stubRun(byVersion);
    const r = runStrategyComparison({ cells: [cell()], strategies: strategies(), shared: SHARED, run });
    expect(r.protocolVersion).toBe(COMPARISON_PROTOCOL_VERSION);
    // Acceptance #13: both strategies run through the SAME canonical seam —
    // the only difference reaching the engine is the config snapshot.
    expect(calls.map((c) => c.version)).toEqual(["v-a", "v-b"]);
    const [a, b] = r.strategies;
    expect(a.row.scenarioCount).toBe(2);
    expect(a.row.filledCount).toBe(2);
    expect(a.row.realizedCount).toBe(2);
    expect(a.row.realizedWinRate).toBe(1); // 3R and ~1.83R — both wins
    expect(a.row.realizedExpectancyR).toBeCloseTo((3 + (106.5 - 101) / 3) / 2, 3);
    expect(b.row.scenarioCount).toBe(3);
    expect(b.row.realizedCount).toBe(2); // censored excluded from realized
    expect(b.row.mtmCount).toBe(1);
    expect(b.row.counts.censored).toBe(1);
    // Different counts are disclosed, never reconciled.
    expect(r.fairness.some((f) => /different opportunity counts/.test(f))).toBe(true);
  });

  it("frozen snapshots are never mutated by the run", () => {
    const { run } = stubRun(byVersion);
    const strats = strategies();
    const before = JSON.parse(JSON.stringify(strats));
    runStrategyComparison({ cells: [cell()], strategies: strats, shared: SHARED, run });
    expect(strats).toEqual(before);
  });

  it("rejects: too few strategies, duplicate ids, identical snapshots, invalid selections", () => {
    const { run } = stubRun(byVersion);
    const base = { cells: [cell()], shared: SHARED, run };
    expect(() => runStrategyComparison({ ...base, strategies: [strategy("x", "v-a")] }))
      .toThrow(/2–6 strategies/);
    expect(() => runStrategyComparison({ ...base, strategies: [strategy("d", "v-a"), strategy("d", "v-b")] }))
      .toThrow(/duplicate strategy id/);
    // Identical frozen inputs — same config, different label — cannot compare.
    expect(() => runStrategyComparison({ ...base, strategies: [strategy("x", "v-a"), strategy("y", "v-a")] }))
      .toThrow(/identical frozen inputs/);
    expect(() => runStrategyComparison({
      ...base,
      strategies: [strategy("x", "v-a"), strategy("y", "v-b", { setupTypes: ["moon" as never] })],
    })).toThrow(/setupTypes/);
    expect(() => runStrategyComparison({
      ...base,
      strategies: [strategy("x", "v-a"), strategy("y", "v-b", { minScore: 150 })],
    })).toThrow(/minScore/);
    expect(() => runStrategyComparison({ cells: [], strategies: strategies(), shared: SHARED, run }))
      .toThrow(/dataset cell/);
  });

  it("selection reaches the run config — minScore/setupTypes are strategy axes, not shared", () => {
    const { run } = stubRun(byVersion);
    const r = runStrategyComparison({
      cells: [cell()],
      strategies: [
        strategy("all", "v-a"),
        strategy("filtered", "v-b", { minScore: 80 }), // all setups score 70 → none eligible
      ],
      shared: SHARED,
      run,
    });
    const filtered = r.strategies[1];
    expect(filtered.result.config.minScore).toBe(80);
    // Stub emits measured setups regardless — the canonical selection lives in
    // the run's filters; the RESULT config records it verbatim.
    expect(r.strategies[0].result.config.minScore).toBeUndefined();
  });
});

describe("shared protocol — identical conditions for every strategy", () => {
  it("costs, horizon, split, purge are the same object for every sub-run", () => {
    const { run } = stubRun(byVersion);
    const shared: ComparisonSharedConfig = {
      horizonBars: 25,
      costs: { feeBps: 2, slippageBps: 1 },
      split: { trainPct: 0.5, validationPct: 0.34 },
      purgeBoundaries: true,
    };
    const r = runStrategyComparison({ cells: [cell()], strategies: strategies(), shared, run });
    for (const c of r.strategies) {
      expect(c.result.config.horizonBars).toBe(25);
      expect(c.result.config.costs).toEqual({ feeBps: 2, slippageBps: 1 });
      expect(c.result.config.purgeBoundaries).toBe(true);
      expect(c.result.splits!.map((s) => s.name)).toEqual(["train", "validation", "test"]);
    }
    expect(r.shared).toBe(shared); // echoed verbatim, not reconstructed
  });

  it("raw and purged cohort results stay distinct under purging", () => {
    const { run } = stubRun(byVersion);
    // s1 (anchor 2, resolves 20) crosses into test cohort on AAA@1m.
    const r = runStrategyComparison({
      cells: [cell()],
      strategies: strategies(),
      shared: { ...SHARED, split: { trainPct: 0.5, validationPct: 0.34 }, purgeBoundaries: true },
      run,
    });
    const a = r.strategies[0].result;
    const train = a.splits![0];
    expect(train.purged).toBeDefined();
    expect(train.purged!.purgedCount).toBeGreaterThan(0);
    expect(train.aggregate.scenarioCount).toBe(1); // raw preserved
    expect(train.purged!.aggregate!.scenarioCount).toBe(0); // purged differs
  });
});

describe("per-instrument breakdown and denominators", () => {
  it("per-series aggregates never mix bar indices across instruments", () => {
    const bbb = mkSetup({ ...lv(5), activeBar: 6, invalidatedBar: 8 }, { id: "c1", symbol: "BBB" });
    const { run } = stubRun({ "v-a": A, "v-b": [...B, bbb] });
    const r = runStrategyComparison({
      cells: [cell("AAA"), cell("BBB")],
      strategies: strategies(),
      shared: SHARED,
      run,
    });
    const keys = r.perInstrument.map((p) => p.series);
    expect(keys).toEqual(["AAA@1m", "BBB@1m"]);
    const bbbRows = r.perInstrument.find((p) => p.series === "BBB@1m")!;
    expect(bbbRows.rows.find((x) => x.id === "alpha")!.aggregate.scenarioCount).toBe(0);
    expect(bbbRows.rows.find((x) => x.id === "beta")!.aggregate.scenarioCount).toBe(1);
  });

  it("realized vs censored denominators are exact and never mixed", () => {
    const { run } = stubRun(byVersion);
    const r = runStrategyComparison({ cells: [cell()], strategies: strategies(), shared: SHARED, run });
    const b = r.strategies[1].row;
    expect(b.realizedCount).toBe(2);
    expect(b.mtmCount).toBe(1);
    expect(b.realizedWinRate).toBe(1); // denominator = 2, not 3
    // mtm row contributes to mixed expectancyR, never to realizedWinRate.
    expect(b.filledCount).toBe(3);
  });
});

describe("test-cohort honesty (comp §3)", () => {
  it("states verbatim that an untouched test set cannot be enforced across runs", () => {
    const { run } = stubRun(byVersion);
    const r = runStrategyComparison({
      cells: [cell()],
      strategies: strategies(),
      shared: { ...SHARED, split: { trainPct: 0.5, validationPct: 0.34 } },
      run,
    });
    expect(r.testCohort.evaluated).toBe(true);
    expect(r.testCohort.enforceable).toBe(false);
    expect(r.testCohort.note).toMatch(/cannot.*(guarantee|track)/i);
  });

  it("strategy resolution completes before any engine run — no outcome can shape config", () => {
    const order: string[] = [];
    const run: typeof import("@/lib/engines/backtest").runBacktest = (input) => {
      order.push(`run:${input.config?.version}`);
      for (const s of A) input.onMeasuredSetup?.(s);
      return { ok: true as const, data: fakeResult(), errors: [], meta: { stage: "x", paramsVersion: "", barsConsumed: { from: 0, to: 0 }, events: [] } };
    };
    // Validation of all strategies precedes the first run call — an invalid
    // third strategy rejects the whole comparison with ZERO engine runs.
    expect(() => runStrategyComparison({
      cells: [cell()],
      strategies: [strategy("a", "v-a"), strategy("b", "v-b"), strategy("bad", "v-a")],
      shared: SHARED,
      run,
    })).toThrow(/identical frozen inputs/);
    expect(order).toEqual([]); // nothing ran — config failure precedes outcomes
  });
});

describe("determinism + fingerprint (comp §7)", () => {
  it("identical inputs → identical fingerprint and rows (minus evaluatedAt)", () => {
    const { run } = stubRun(byVersion);
    const args = { cells: [cell()], strategies: strategies(), shared: SHARED, run };
    const r1 = runStrategyComparison(args);
    const r2 = runStrategyComparison(args);
    expect(r2.fingerprint).toBe(r1.fingerprint);
    expect(r1.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r2.strategies.map((s) => s.row))).toBe(
      JSON.stringify(r1.strategies.map((s) => s.row)));
  });

  it("material input changes change the fingerprint", () => {
    const { run } = stubRun(byVersion);
    const base = { cells: [cell()], strategies: strategies(), shared: SHARED, run };
    const fp = runStrategyComparison(base).fingerprint;
    // Different shared horizon.
    expect(runStrategyComparison({ ...base, shared: { horizonBars: 10 } }).fingerprint).not.toBe(fp);
    // Different dataset content (same metadata — the CONTENT hash differs).
    const candles2 = series(40).map((c, i) => i === 10 ? { ...c, high: c.high + 5 } : c);
    expect(runStrategyComparison({ ...base, cells: [cell("AAA", candles2)] }).fingerprint).not.toBe(fp);
    // Different strategy snapshot.
    expect(runStrategyComparison({
      ...base,
      strategies: [strategy("alpha", "v-a"), strategy("beta", "v-c")],
    }).fingerprint).not.toBe(fp);
    // Different strategy selection.
    expect(runStrategyComparison({
      ...base,
      strategies: [strategy("alpha", "v-a"), strategy("beta", "v-b", { minScore: 50 })],
    }).fingerprint).not.toBe(fp);
  });

  it("key order in a snapshot does not change identity (stableStringify)", () => {
    const a = { x: 1, y: { b: 2, a: 1 } };
    const b = { y: { a: 1, b: 2 }, x: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    const { run } = stubRun({ "v-a": A, "v-b": B });
    const s1 = [strategy("alpha", "v-a"), strategy("beta", "v-b")];
    const s2 = [strategy("beta", "v-b"), strategy("alpha", "v-a")];
    // Different input ORDER is a different comparison (row order matters).
    const r1 = runStrategyComparison({ cells: [cell()], strategies: s1, shared: SHARED, run });
    const r2 = runStrategyComparison({ cells: [cell()], strategies: s2, shared: SHARED, run });
    expect(r1.fingerprint).not.toBe(r2.fingerprint);
  });

  it("refused uncertainty is surfaced per-strategy, never hidden", () => {
    // Only 2 realized rows each → bootstrap refused; intervals still emitted
    // (Wilson/t) but the fairness block flags missing estimates when any are.
    const { run } = stubRun({ "v-a": [A[0]], "v-b": B }); // alpha: 1 scenario
    const r = runStrategyComparison({
      cells: [cell()],
      strategies: [strategy("alpha", "v-a"), strategy("beta", "v-b")],
      shared: SHARED,
      run,
    });
    const alpha = r.strategies[0].row;
    expect(alpha.realizedCount).toBe(1);
    // n=1 → no Student-t expectancy interval → fairness must say so.
    expect(r.fairness.some((f) => f.includes("alpha") && /refus|unavailable|not statistically/i.test(f))).toBe(true);
  });
});

describe("unsupported strategy types", () => {
  it("a strategy without a valid EngineConfig snapshot is rejected, not approximated", () => {
    const { run } = stubRun(byVersion);
    expect(() => runStrategyComparison({
      cells: [cell()],
      strategies: [
        strategy("alpha", "v-a"),
        { id: "legacy", engineConfig: {} as never }, // rule-builder style — unsupported
      ],
      shared: SHARED,
      run,
    })).toThrow(/engineConfig snapshot/);
  });
});

describe("warnings and fairness plumbing", () => {
  it("per-strategy warnings are namespaced and unioned", () => {
    const { run } = stubRun(byVersion);
    const r = runStrategyComparison({ cells: [cell()], strategies: strategies(), shared: SHARED, run });
    expect(r.warnings.every((w) => /^(alpha|beta): /.test(w))).toBe(true);
  });

  it("export payload is JSON-serializable and contains the frozen inputs", () => {
    const { run } = stubRun(byVersion);
    const r = runStrategyComparison({ cells: [cell()], strategies: strategies(), shared: SHARED, run });
    const serialized = JSON.parse(JSON.stringify(r));
    expect(serialized.shared.horizonBars).toBe(25);
    expect(serialized.strategies).toHaveLength(2);
    expect(serialized.fingerprint).toBe(r.fingerprint);
    expect(serialized.protocolVersion).toBe(COMPARISON_PROTOCOL_VERSION);
    expect(serialized.methodology.uncertainty).toMatch(/bootstrap/);
  });
});

// Silence unused-import lint if vi ends up unused in this suite's final form.
void vi;
