/**
 * Experiment Registry (er1) — deterministic tests for the 15 acceptance
 * criteria. Records are built from hand-made StrategyComparisonResult-shaped
 * fixtures (no engine needed — the registry is additive bookkeeping over
 * result metadata), plus one end-to-end check that registry operations leave
 * a real comparison result and fingerprint untouched.
 */
import { describe, expect, it } from "vitest";
import type { Candle, Setup, SystemBacktestResult } from "@/lib/types";
import { defaultConfig } from "../engine-defaults";
import { runStrategyComparison, type ComparisonStrategy } from "../strategy-comparison";
import { sha256Hex } from "../sha256";
import {
  BROWSER_LOCAL_LIMITATION,
  buildRecord,
  classifyExposure,
  diffRecords,
  exportRecords,
  importRecords,
  memoryStore,
  register,
  REGISTRY_SCHEMA_VERSION,
  type ExperimentRecord,
  type PeriodRange,
} from "../experiment-registry";
import type { StrategyComparisonResult } from "../strategy-comparison";

// ---------------------------------------------------------------------------
// Fixtures — minimal result shapes; buildRecord reads metadata only.
// ---------------------------------------------------------------------------

const T0 = "2026-01-01T00:00:00.000Z";

const fakeResult = (over: Partial<StrategyComparisonResult> = {}): StrategyComparisonResult => ({
  protocolVersion: "comp-v1",
  contractVersion: "hv1",
  fingerprint: "f".repeat(64),
  datasetFingerprint: "d".repeat(64),
  datasets: [{ symbol: "AAA", timeframe: "1m", bars: 40, firstBar: T0, lastBar: "2026-01-01T00:39:00.000Z" }],
  shared: { horizonBars: 25, split: { trainPct: 0.5, validationPct: 0.34 } },
  strategies: [
    {
      id: "alpha", label: "alpha", configVersion: "v1-engine",
      engineConfig: { ...defaultConfig(), version: "v-a" },
      row: {
        id: "alpha", label: "alpha", configVersion: "v1-engine", fingerprint: "a".repeat(64),
        scenarioCount: 2, filledCount: 2, counts: {} as never,
        realizedCount: 2, realizedWins: 2, realizedLosses: 0, realizedBreakevens: 0,
        mtmCount: 0, realizedWinRate: 1, realizedExpectancyR: 2.4,
      },
      result: {
        fingerprint: "a".repeat(64),
        splits: [
          { name: "train", anchorFrom: T0, anchorTo: "2026-01-01T00:08:00.000Z", aggregate: { scenarioCount: 1 } },
          { name: "test", anchorFrom: "2026-01-01T00:10:00.000Z", anchorTo: "2026-01-01T00:20:00.000Z", aggregate: { scenarioCount: 1 } },
        ],
        methodology: { uncertaintyMethod: "moving-block bootstrap (2000 resamples, seed 42)" },
      } as never,
    },
    {
      id: "beta", label: "beta", configVersion: "v1-engine",
      engineConfig: { ...defaultConfig(), version: "v-b" },
      row: {
        id: "beta", label: "beta", configVersion: "v1-engine", fingerprint: "b".repeat(64),
        scenarioCount: 3, filledCount: 3, counts: {} as never,
        realizedCount: 2, realizedWins: 2, realizedLosses: 0, realizedBreakevens: 0,
        mtmCount: 1, realizedWinRate: 1, realizedExpectancyR: 2.4,
      },
      result: {
        fingerprint: "b".repeat(64),
        splits: [
          { name: "test", anchorFrom: "2026-01-01T00:10:00.000Z", anchorTo: "2026-01-01T00:21:00.000Z", aggregate: { scenarioCount: 1 } },
        ],
      } as never,
    },
  ],
  perInstrument: [],
  testCohort: { evaluated: true, enforceable: false, note: "n" },
  fairness: [], warnings: [],
  methodology: { comparison: "c", ranking: "r", uncertainty: "u" },
  evaluatedAt: T0,
  ...over,
});

const TEST_PERIOD: PeriodRange = { from: "2026-01-01T00:10:00.000Z", to: "2026-01-01T00:21:00.000Z" };

const strategies = (): ComparisonStrategy[] => [
  { id: "alpha", engineConfig: { ...defaultConfig(), version: "v-a" } },
  { id: "beta", engineConfig: { ...defaultConfig(), version: "v-b" } },
];

const rec = (over: {
  fingerprint?: string; datasetFingerprint?: string;
  testPeriod?: PeriodRange; createdAt?: string;
  strategies?: ComparisonStrategy[];
} = {}): ExperimentRecord => {
  const result = fakeResult({
    ...(over.fingerprint !== undefined ? { fingerprint: over.fingerprint } : {}),
    ...(over.datasetFingerprint !== undefined ? { datasetFingerprint: over.datasetFingerprint } : {}),
    ...(over.testPeriod === undefined ? {} : {}),
  });
  const r = buildRecord({
    result,
    strategies: over.strategies ?? strategies(),
    createdAt: over.createdAt ?? "2026-02-01T00:00:00.000Z",
  });
  if (over.testPeriod !== undefined) r.testPeriod = over.testPeriod;
  return r;
};

describe("er1 record construction and round trips (criteria 1, 2)", () => {
  it("builds a record that reconstructs what was evaluated", () => {
    const r = rec();
    expect(r.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION);
    expect(r.fingerprint).toBe("f".repeat(64));
    expect(r.testPeriod).toEqual(TEST_PERIOD); // union of test-cohort anchor ranges
    expect(r.evaluationRange).toEqual({ from: T0, to: "2026-01-01T00:39:00.000Z" });
    expect(r.strategies.map((s) => s.id)).toEqual(["alpha", "beta"]);
    expect(r.strategies[0].engineConfig.version).toBe("v-a"); // snapshot verbatim
    expect(r.strategies[0].resultFingerprint).toBe("a".repeat(64));
    expect(r.createdAt).not.toBe(T0); // wall-clock, distinct from market data
    expect(r.recordId).not.toBe(r.fingerprint); // registry id ≠ experiment fp
  });

  it("save + reopen through a store preserves records verbatim", () => {
    const store = memoryStore();
    const { history } = register(store.load(), rec());
    store.save(history);
    expect(store.load()).toEqual(history);
  });

  it("export → import is a deterministic round trip", () => {
    const h = register(register([], rec({ fingerprint: "1".repeat(64) })).history, rec({ fingerprint: "2".repeat(64) })).history;
    const json = exportRecords(h);
    expect(exportRecords(h)).toBe(json); // byte-identical on repeat
    const back = importRecords(json, []);
    expect(back.ok).toBe(true);
    expect(back.history).toHaveLength(2);
    // Imported copies carry import provenance but identical fingerprints.
    expect(back.history.map((r) => r.fingerprint)).toEqual(h.map((r) => r.fingerprint));
    expect(back.history.every((r) => r.provenance === "imported")).toBe(true);
  });
});

describe("exposure classification (criteria 3, 4, 5, 6, 15)", () => {
  it("identical fingerprint → repeat, never independent confirmation", () => {
    const first = rec({ fingerprint: "e".repeat(64) });
    const { history } = register([], first);
    const again = rec({ fingerprint: "e".repeat(64), createdAt: "2026-02-02T00:00:00.000Z" });
    const out = register(history, again);
    expect(out.record.exposure.status).toBe("repeat");
    expect(out.record.exposure.note).toMatch(/not independent confirmation/);
    expect(out.record.exposure.matched).toHaveLength(1);
    // The repeat is still recorded — registry warns, never blocks.
    expect(out.history).toHaveLength(2);
  });

  it("different config on same dataset + test period → exposed", () => {
    const { history } = register([], rec({ fingerprint: "1".repeat(64) }));
    const next = rec({ fingerprint: "2".repeat(64) }); // same datasetFingerprint + testPeriod
    const out = register(history, next);
    expect(out.record.exposure.status).toBe("exposed");
    expect(out.record.exposure.note).toMatch(/reused period/);
  });

  it("overlapping (not identical) test period → overlap", () => {
    const { history } = register([], rec({ fingerprint: "1".repeat(64) }));
    const shifted = rec({
      fingerprint: "3".repeat(64),
      testPeriod: { from: "2026-01-01T00:15:00.000Z", to: "2026-01-01T00:30:00.000Z" },
    });
    expect(register(history, shifted).record.exposure.status).toBe("overlap");
  });

  it("missing dataset identity or period → unknown, never assumed independent", () => {
    const noPeriod = rec({ fingerprint: "4".repeat(64) });
    noPeriod.testPeriod = undefined;
    expect(classifyExposure(noPeriod, [])).toMatchObject({ status: "unknown" });
    const noData = rec({ fingerprint: "5".repeat(64) });
    noData.datasetFingerprint = undefined;
    expect(classifyExposure(noData, [])).toMatchObject({ status: "unknown" });
  });

  it("unmatched period → 'no prior exposure recorded', never 'unseen'/'untouched'", () => {
    const r = rec({ datasetFingerprint: "9".repeat(64) });
    const report = classifyExposure(r, []);
    expect(report.status).toBe("no-prior-exposure");
    expect(report.note).toMatch(/no prior exposure recorded in this registry/);
    expect(report.note).not.toMatch(/untouched|independent out-of-sample/);
  });
});

describe("imports — provenance, versions, corruption (criteria 7, 8, 9, 10)", () => {
  it("browser-local limitation is disclosed verbatim", () => {
    expect(BROWSER_LOCAL_LIMITATION).toMatch(/browser only/);
    expect(BROWSER_LOCAL_LIMITATION).toMatch(/lost/);
  });

  it("imported records carry provenance + a not-verified notice", () => {
    const json = exportRecords(register([], rec()).history);
    const out = importRecords(json, []);
    expect(out.ok).toBe(true);
    expect(out.history[0].provenance).toBe("imported");
    expect(out.notices.some((n) => /does not prove.*executed/i.test(n))).toBe(true);
  });

  it("unsupported schema versions are kept flagged, never reinterpreted", () => {
    const bad = rec();
    const foreign = { ...bad, schemaVersion: "er9" as never };
    const json = JSON.stringify({ format: "ti-experiment-registry", schemaVersion: "er1", records: [foreign] });
    const out = importRecords(json, []);
    expect(out.ok).toBe(true);
    expect(out.history[0].unsupported).toBe(true);
    expect(out.notices.some((n) => /not supported/.test(n))).toBe(true);
  });

  it("corrupt JSON and wrong format produce actionable errors, history untouched", () => {
    const h = register([], rec()).history;
    expect(importRecords("{broken", h).ok).toBe(false);
    expect(importRecords('{"format":"other","records":[]}', h).error).toMatch(/unrecognized/);
    expect(importRecords("{broken", h).history).toBe(h);
  });

  it("duplicate imports skip; same recordId + different content is flagged a conflict", () => {
    const r = rec();
    const h = register([], r).history;
    // Exact duplicate → skipped.
    const dup = importRecords(exportRecords(h), h);
    expect(dup.history).toHaveLength(1);
    expect(dup.notices.some((n) => /duplicate skipped/.test(n))).toBe(true);
    // Same recordId, different fingerprint → conflict flagged, still recorded.
    const forged = { ...r, fingerprint: "c".repeat(64) };
    const json = JSON.stringify({ format: "ti-experiment-registry", schemaVersion: "er1", records: [forged] });
    const out = importRecords(json, h);
    expect(out.history).toHaveLength(2);
    expect(out.history[1].identityConflict).toBe(true);
    expect(out.notices.some((n) => /identity conflict/.test(n))).toBe(true);
  });
});

describe("comparison integrity (criteria 11, 12, 13, 14)", () => {
  it("registry operations never mutate the result or its fingerprint", () => {
    const result = fakeResult();
    const before = JSON.stringify(result);
    const r = buildRecord({ result, strategies: strategies(), createdAt: "2026-02-01T00:00:00.000Z" });
    register([], r);
    exportRecords([r]);
    diffRecords(r, r);
    expect(JSON.stringify(result)).toBe(before); // frozen result untouched
  });

  it("diff of two records is deterministic and field-level", () => {
    const a = rec({ fingerprint: "1".repeat(64) });
    const b = rec({ fingerprint: "2".repeat(64) });
    b.shared = { ...b.shared, horizonBars: 10 };
    const d1 = diffRecords(a, b);
    const d2 = diffRecords(a, b);
    expect(d1).toEqual(d2); // reproducible report
    expect(d1.some((x) => x.path === "shared.horizonBars" && x.a === 25 && x.b === 10)).toBe(true);
    expect(diffRecords(a, a)).toEqual([]);
  });

  it("exposure metadata and timestamps cannot change the experiment fingerprint", () => {
    const a = rec({ createdAt: "2026-02-01T00:00:00.000Z" });
    const b = rec({ createdAt: "2026-02-09T12:00:00.000Z" });
    expect(a.fingerprint).toBe(b.fingerprint); // same experiment, different records
    expect(a.recordId).not.toBe(b.recordId);   // distinct ledger entries
  });
});

describe("end-to-end: a real comparison result stays bit-identical (criterion 13)", () => {
  const BASE = Date.UTC(2026, 0, 1);
  const candles = (n: number): Candle[] =>
    Array.from({ length: n }, (_, i) => ({
      time: BASE + i * 60_000, open: 100 + i, high: 100.4 + i, low: 99.8 + i, close: 100.2 + i,
    }));
  const setup: Setup = {
    id: "s1", symbol: "AAA", timeframe: "1m", type: "reversal", direction: "bullish",
    score: 70, status: "confirmed", reasons: [], createdAt: new Date(BASE).toISOString(),
    metadata: { confirmBar: 2, activeBar: 3, entryBandLow: 100, entryBandHigh: 101, invalidation: 98, targets: "110", targetReachedBar: 20, targetBars: "20" },
  };
  const stub = {
    "v-a": [setup],
    "v-b": [{ ...setup, id: "s2", metadata: { ...setup.metadata, confirmBar: 5, activeBar: 6, invalidatedBar: 10 } }],
  };
  const fakeBt = (): SystemBacktestResult => ({
    runId: "x", cells: [], opportunities: [], developing: [], outcomes: [],
    aggregate: { observationCount: 0, developingObservationCount: 0, uniqueSetupCount: 0, selectedObservationCount: 0, resolvedOutcomeCount: 0, outcomeCounts: { target: 0, stop: 0, expired: 0, cancelled: 0, unresolved: 0 } },
    versions: { methodVersion: "v1-bt", paramsVersion: "x", configVersion: "v1-engine" },
  });
  const run: typeof import("@/lib/engines/backtest").runBacktest = (input) => {
    for (const s of stub[input.config?.version as keyof typeof stub] ?? []) input.onMeasuredSetup?.(s);
    return { ok: true as const, data: fakeBt(), errors: [], meta: { stage: "x", paramsVersion: "", barsConsumed: { from: 0, to: 0 }, events: [] } };
  };

  it("registering a real result adds fields but changes no existing value", () => {
    const result = runStrategyComparison({
      cells: [{ symbol: "AAA", timeframe: "1m", series: { symbol: "AAA", timeframe: "1m", candles: candles(40) } }],
      strategies: strategies(),
      shared: { horizonBars: 25 },
      run,
    });
    const snapshot = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    const r = buildRecord({ result, strategies: strategies(), createdAt: "2026-02-01T00:00:00.000Z" });
    register([], r);
    // Every pre-existing field is byte-identical; only additive fields appear.
    for (const [k, v] of Object.entries(result as unknown as Record<string, unknown>)) {
      if (k === "datasetFingerprint") continue; // new additive field
      expect(JSON.stringify(v)).toBe(JSON.stringify(snapshot[k]));
    }
    expect(result.datasetFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Consumed-window-aware exposure (er1.1) — canonical (anchorBar, resolvedBar]
// intervals of TEST-cohort scenarios, compared per series.
// ---------------------------------------------------------------------------

const T1 = (minute: number) => new Date(Date.UTC(2026, 0, 1) + minute * 60_000).toISOString();

interface FakeScenario {
  setupId: string; symbol?: string; timeframe?: string;
  anchorBar: number; anchorTime: string;
  resolvedBar?: number; resolvedAt?: string; status: string;
}
const scen = (o: Partial<FakeScenario> & { setupId: string }): FakeScenario => ({
  symbol: "AAA", timeframe: "1m", anchorBar: 10, anchorTime: T1(10),
  resolvedBar: 20, resolvedAt: T1(20), status: "target", ...o,
});

/** Result whose alpha strategy carries a real scenario array + integer-bounded
 *  test split (beta shares the period bounds but no scenarios — merged windows
 *  then reflect the provided array exactly). `period` controls the test-cohort
 *  bounds so tests can reach a specific exposure tier. */
const scenResult = (
  scenarios: FakeScenario[],
  over: Partial<StrategyComparisonResult> = {},
  period: PeriodRange = { from: T1(5), to: T1(30) },
): StrategyComparisonResult => {
  const base = fakeResult(over);
  const split = {
    name: "test" as const, fromScenario: 0, toScenario: scenarios.length,
    anchorFrom: period.from, anchorTo: period.to, aggregate: { scenarioCount: scenarios.length },
  };
  return {
    ...base,
    strategies: base.strategies.map((s, i) => ({
      ...s,
      result: { ...s.result, splits: [split], ...(i === 0 ? { scenarios } : {}) } as never,
    })),
  };
};

const recScen = (
  scenarios: FakeScenario[],
  over: { fingerprint?: string; datasetFingerprint?: string; createdAt?: string } = {},
  period?: PeriodRange,
): ExperimentRecord =>
  buildRecord({
    result: scenResult(scenarios, {
      ...(over.fingerprint !== undefined ? { fingerprint: over.fingerprint } : {}),
      ...(over.datasetFingerprint !== undefined ? { datasetFingerprint: over.datasetFingerprint } : {}),
    }, period),
    strategies: strategies(),
    createdAt: over.createdAt ?? "2026-02-01T00:00:00.000Z",
  });

describe("consumed-window extraction (canonical (anchorBar, resolvedBar])", () => {
  it("merges overlapping test-cohort windows per series; disjoint stay separate", () => {
    const r = recScen([
      scen({ setupId: "a", anchorBar: 10, anchorTime: T1(10), resolvedBar: 20, resolvedAt: T1(20) }),
      scen({ setupId: "b", anchorBar: 15, anchorTime: T1(15), resolvedBar: 30, resolvedAt: T1(30) }),
      scen({ setupId: "c", anchorBar: 35, anchorTime: T1(35), resolvedBar: 38, resolvedAt: T1(38) }),
    ]);
    expect(r.consumedWindows).toHaveLength(2);
    // (10,20] ∪ (15,30] → [11,30]
    expect(r.consumedWindows![0]).toMatchObject({ series: "AAA@1m", fromBar: 11, toBar: 30, scenarioCount: 2 });
    expect(r.consumedWindows![1]).toMatchObject({ fromBar: 36, toBar: 38, scenarioCount: 1 });
    expect(r.unverifiableWindows).toBeUndefined();
  });

  it("canonical consumption rules: censored/not_filled consume the window; unevaluable consumes nothing", () => {
    const r = recScen([
      scen({ setupId: "c1", status: "censored" }),
      scen({ setupId: "n1", status: "not_filled" }),
      scen({ setupId: "u1", status: "unevaluable", resolvedBar: undefined, resolvedAt: undefined }),
    ]);
    expect(r.consumedWindows).toHaveLength(1);
    expect(r.consumedWindows![0].scenarioCount).toBe(2); // censored + not_filled merged
    expect(r.unverifiableWindows).toBeUndefined();       // unevaluable is not "unverifiable" — it consumed nothing
  });

  it("missing resolved metadata counts unverifiable, not silent", () => {
    const r = recScen([
      scen({ setupId: "a" }),
      scen({ setupId: "b", resolvedBar: undefined, resolvedAt: undefined }),
      scen({ setupId: "c", symbol: undefined }),          // no series identity
    ]);
    expect(r.unverifiableWindows).toBe(2);
  });

  it("boundary-purged scenarios are counted inside the merged window", () => {
    const result = scenResult([scen({ setupId: "a" }), scen({ setupId: "b" })]);
    (result.strategies[0].result as { splits: { purged?: { purgedSetupIds: string[] } }[] })
      .splits[0].purged = { purgedSetupIds: ["b"] } as never;
    const r = buildRecord({ result, strategies: strategies(), createdAt: "2026-02-01T00:00:00.000Z" });
    expect(r.consumedWindows![0].purgedCount).toBeGreaterThanOrEqual(1);
  });
});

describe("consumed-window overlap classification", () => {
  it("different anchors, overlapping windows → consumed-window-overlap", () => {
    const prior = recScen([scen({ setupId: "a", anchorBar: 10, resolvedBar: 20 })], { fingerprint: "1".repeat(64) });
    const next = recScen([scen({ setupId: "b", anchorBar: 15, resolvedBar: 30 })],
      { fingerprint: "2".repeat(64) }, { from: T1(15), to: T1(40) });
    // Shifted period → not "exposed"; same dataset → bars [16,20] intersect.
    const report = classifyExposure(next, [prior]);
    expect(report.status).toBe("consumed-window-overlap");
    expect(report.matched[0].relation).toContain("AAA@1m");
    expect(report.matched[0].relation).toContain("16");
  });

  it("non-overlapping windows → not consumed-window-overlap", () => {
    const prior = recScen([scen({ setupId: "a", anchorBar: 10, resolvedBar: 20 })], { fingerprint: "1".repeat(64) });
    const next = recScen([scen({ setupId: "b", anchorBar: 25, resolvedBar: 30 })],
      { fingerprint: "2".repeat(64) }, { from: T1(20), to: T1(45) });
    // Period bounds overlap; consumed windows [11–20] vs [26–30] do not → overlap tier.
    const report = classifyExposure(next, [prior]);
    expect(report.status).toBe("overlap");
  });

  it("overlap on one series only — other series' windows never cross-match", () => {
    const prior = recScen([scen({ setupId: "a" })], { fingerprint: "1".repeat(64) });
    const next = recScen(
      [scen({ setupId: "b", symbol: "BBB" }), scen({ setupId: "c" })],
      { fingerprint: "2".repeat(64) }, { from: T1(15), to: T1(40) },
    );
    const report = classifyExposure(next, [prior]);
    expect(report.status).toBe("consumed-window-overlap");
    expect(report.matched).toHaveLength(1);
    expect(report.matched[0].relation).toContain("AAA@1m");
    expect(report.matched[0].relation).not.toContain("BBB");
  });

  it("identical bar indices on different symbols never match", () => {
    const prior = recScen([scen({ setupId: "a" })], { fingerprint: "1".repeat(64) });
    const next = recScen([scen({ setupId: "b", symbol: "ZZZ" })],
      { fingerprint: "2".repeat(64) }, { from: T1(15), to: T1(40) });
    expect(classifyExposure(next, [prior]).status).not.toBe("consumed-window-overlap");
  });

  it("identical timestamps on different timeframes never match", () => {
    const prior = recScen([scen({ setupId: "a" })], { fingerprint: "1".repeat(64) });
    const next = recScen([scen({ setupId: "b", timeframe: "5m" })],
      { fingerprint: "2".repeat(64) }, { from: T1(15), to: T1(40) });
    expect(classifyExposure(next, [prior]).status).not.toBe("consumed-window-overlap");
  });

  it("different dataset version → time-based comparison on same series", () => {
    const prior = recScen([scen({ setupId: "a" })], {
      fingerprint: "1".repeat(64), datasetFingerprint: "0".repeat(64),
    });
    const next = recScen([scen({
      setupId: "b", anchorBar: 900, anchorTime: T1(900), resolvedBar: 950, resolvedAt: T1(950),
    })], {
      fingerprint: "2".repeat(64), datasetFingerprint: "9".repeat(64), // different upload
    });
    // Bar indices incomparable across uploads — but times (T1(900)..T1(950))
    // don't overlap (10..20) either → no match.
    const report = classifyExposure(next, [prior]);
    expect(report.status).not.toBe("consumed-window-overlap");
    // Overlapping TIME window on a different dataset version DOES match.
    const timed = recScen([scen({ setupId: "c", anchorBar: 500, anchorTime: T1(12), resolvedBar: 510, resolvedAt: T1(25) })], {
      fingerprint: "3".repeat(64), datasetFingerprint: "9".repeat(64),
    });
    const report2 = classifyExposure(timed, [prior]);
    expect(report2.status).toBe("consumed-window-overlap");
    expect(report2.matched[0].relation).toContain("time-based");
  });

  it("missing consumed windows on the candidate → partial coverage disclosed", () => {
    const prior = recScen([scen({ setupId: "a" })], { fingerprint: "1".repeat(64) });
    const legacy = rec({ fingerprint: "2".repeat(64) }); // er1 fixture — no consumedWindows
    legacy.testPeriod = { from: "2026-02-01T00:00:00.000Z", to: "2026-02-02T00:00:00.000Z" }; // no period overlap
    const report = classifyExposure(legacy, [prior]);
    expect(report.coverage).toBe("partial");
  });
});

describe("precedence and determinism", () => {
  it("precedence: repeat > exposed > consumed-window-overlap > overlap", () => {
    const prior = recScen([scen({ setupId: "a" })], { fingerprint: "1".repeat(64) });
    const h = register([], prior).history;
    // repeat wins over everything
    const dup = recScen([scen({ setupId: "a" })], { fingerprint: "1".repeat(64), createdAt: "2026-02-02T00:00:00.000Z" });
    expect(classifyExposure(dup, h).status).toBe("repeat");
    // identical test period → exposed (beats consumed-window-overlap)
    const samePeriod = recScen([scen({ setupId: "b" })], { fingerprint: "2".repeat(64) });
    expect(classifyExposure(samePeriod, h).status).toBe("exposed");
    // shifted period + overlapping windows → consumed-window-overlap (beats period overlap)
    const shifted = recScen([scen({ setupId: "c", anchorBar: 15, resolvedBar: 30 })], { fingerprint: "3".repeat(64) });
    shifted.testPeriod = { from: T1(12), to: T1(35) };
    expect(classifyExposure(shifted, h).status).toBe("consumed-window-overlap");
  });

  it("classification is deterministic — same inputs, identical reports", () => {
    const prior = recScen([scen({ setupId: "a" })], { fingerprint: "1".repeat(64) });
    const next = recScen([scen({ setupId: "b", anchorBar: 15, resolvedBar: 30 })], { fingerprint: "2".repeat(64) });
    expect(classifyExposure(next, [prior])).toEqual(classifyExposure(next, [prior]));
  });
});

describe("legacy er1 records (no consumedWindows)", () => {
  it("er1 export/import still round-trips; consumed windows are optional", () => {
    const old = rec(); // fixture without scenarios → no consumedWindows
    expect(old.consumedWindows).toBeUndefined();
    const json = exportRecords(register([], old).history);
    const out = importRecords(json, []);
    expect(out.ok).toBe(true);
    expect(out.history[0].consumedWindows).toBeUndefined();
    // An old record in history makes a new candidate's coverage partial —
    // prior exposure CANNOT be ruled out where windows are unknown.
    const fresh = recScen([scen({ setupId: "x" })], { fingerprint: "9".repeat(64) });
    const report = classifyExposure(fresh, out.history);
    expect(report.coverage).toBe("partial");
  });
});

describe("sha256 helper", () => {
  it("matches known vectors (FIPS 180-4)", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
