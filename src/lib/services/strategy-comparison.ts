/**
 * Strategy Comparison Lab — comp-v1 protocol.
 *
 * One evaluation contract, N frozen strategy snapshots, one dataset. A
 * "strategy" here is exactly what the canonical engine accepts as its defining
 * inputs: an `EngineConfig` parameter snapshot plus an optional scenario
 * selection (`setupTypes`/`minScore` — spec-25 analytical marking). There is
 * no second strategy grammar and no parallel backtesting path: every strategy
 * is evaluated by `runHistoricalValidation` (specs 00–35 + hv1) on the SAME
 * cells under the SAME shared protocol. Anything that cannot be expressed as
 * such a snapshot is unsupported — never approximated.
 *
 * Fairness contract:
 *  - The shared protocol (horizon, entry deadline, costs, split, purging,
 *    sensitivity grids) is identical for every strategy — the runner takes it
 *    once, structurally, so divergence is impossible.
 *  - Strategy snapshots are frozen before any run executes; resolved inputs
 *    are hashed into the comparison fingerprint alongside the dataset and the
 *    engine versions. Identical material inputs ⇒ identical fingerprint.
 *  - Identical frozen snapshots are rejected — they produce identical results
 *    and are not a comparison.
 *  - Per-strategy scenario counts differ legitimately; they are reported
 *    verbatim, never force-matched into artificial one-to-one trades.
 *  - Ranking rows are descriptive ordering only — samples, dependence, and
 *    refused intervals decide whether any ordering is even meaningful.
 *  - The final test cohort is whatever the shared chronological split leaves
 *    last. The system CANNOT enforce an untouched test set across independent
 *    runs — selection history is not tracked between comparisons. This limit
 *    is stated verbatim on every result.
 */
import { createHash } from "crypto";
import type { BacktestCell, EngineConfig, SetupType } from "@/lib/types";
import type { runBacktest } from "@/lib/engines/backtest";
import { defaultConfig } from "@/lib/services/engine-defaults";
import {
  aggregateScenarios,
  runHistoricalValidation,
  VALIDATION_CONTRACT_VERSION,
  type HistoricalValidationResult,
  type ValidationAggregate,
  type ValidationCostConfig,
  type ValidationRunConfig,
  type ValidationStatus,
} from "@/lib/services/historical-validation";

export const COMPARISON_PROTOCOL_VERSION = "comp-v1";

export const COMPARISON_STRATEGY_MIN = 2;
export const COMPARISON_STRATEGY_MAX = 6;

const SETUP_TYPES: SetupType[] = ["reversal", "breakout", "continuation"];

// ---------------------------------------------------------------------------
// Protocol + strategy definitions
// ---------------------------------------------------------------------------

/** Optional scenario selection — spec-25 analytical marking only. */
export interface ComparisonSelection {
  setupTypes?: SetupType[];
  minScore?: number;
}

/** One frozen strategy snapshot evaluated under the shared protocol. */
export interface ComparisonStrategy {
  /** Stable caller-supplied identifier — appears in rows, export, fingerprint. */
  id: string;
  /** Display name; falls back to `id`. */
  label?: string;
  /** Complete engine parameter snapshot — frozen, never mutated by the run. */
  engineConfig: EngineConfig;
  selection?: ComparisonSelection;
}

/**
 * The shared evaluation protocol — a ValidationRunConfig minus the
 * per-strategy selection fields. Identical for every strategy by construction.
 */
export interface ComparisonSharedConfig {
  horizonBars: number;
  entryDeadlineBars?: number;
  costs?: ValidationCostConfig;
  split?: { trainPct: number; validationPct: number };
  purgeBoundaries?: boolean;
  costSensitivity?: ValidationCostConfig[];
  horizonSensitivity?: number[];
}

/** Built-in, definitional presets — structural variants of the canonical V1
 *  config, never tuned against outcomes. Custom snapshots go through
 *  `engineConfig` instead. */
export interface StrategyPreset {
  id: string;
  label: string;
  description: string;
  resolve: () => { engineConfig: EngineConfig; selection?: ComparisonSelection };
}

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: "baseline",
    label: "Baseline (canonical V1)",
    description: "The unmodified canonical V1 engine configuration over all setup types.",
    resolve: () => ({ engineConfig: defaultConfig() }),
  },
  {
    id: "reversal-only",
    label: "Reversal setups only",
    description: "Canonical V1 engine; scenario universe restricted to reversal setups.",
    resolve: () => ({ engineConfig: defaultConfig(), selection: { setupTypes: ["reversal"] } }),
  },
  {
    id: "breakout-only",
    label: "Breakout setups only",
    description: "Canonical V1 engine; scenario universe restricted to breakout setups.",
    resolve: () => ({ engineConfig: defaultConfig(), selection: { setupTypes: ["breakout"] } }),
  },
  {
    id: "continuation-only",
    label: "Continuation setups only",
    description: "Canonical V1 engine; scenario universe restricted to continuation setups.",
    resolve: () => ({ engineConfig: defaultConfig(), selection: { setupTypes: ["continuation"] } }),
  },
  {
    id: "high-conviction",
    label: "High-conviction (score ≥ 70)",
    description: "Canonical V1 engine; only scenarios scoring at least 70 are evaluated.",
    resolve: () => ({ engineConfig: defaultConfig(), selection: { minScore: 70 } }),
  },
];

export const strategyPreset = (id: string): StrategyPreset | undefined =>
  STRATEGY_PRESETS.find((p) => p.id === id);

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface StrategyComparisonRow {
  id: string;
  label: string;
  /** `engineConfig.version` verbatim — spec-21 stamp, not a comparison rank. */
  configVersion: string;
  selection?: ComparisonSelection;
  /** Per-strategy sub-run fingerprint (hv1) — binds data+config+versions. */
  fingerprint: string;
  scenarioCount: number;
  filledCount: number;
  counts: Record<ValidationStatus, number>;
  realizedCount: number;
  realizedWins: number;
  realizedLosses: number;
  realizedBreakevens: number;
  mtmCount: number;
  realizedWinRate?: number;
  realizedExpectancyR?: number;
  /** Mixed-population metrics — labelled as such wherever surfaced. */
  expectancyR?: number;
  totalR?: number;
  medianR?: number;
  maxDrawdownR?: number;
  uncertainty?: ValidationAggregate["uncertainty"];
  dependence?: ValidationAggregate["dependence"];
}

export interface ComparedStrategy {
  id: string;
  label: string;
  configVersion: string;
  selection?: ComparisonSelection;
  /** Resolved snapshot exactly as evaluated (upload MTF roles already bound) —
   *  echoed verbatim so exports and registry records capture what ran. */
  engineConfig: EngineConfig;
  row: StrategyComparisonRow;
  /** Complete hv1 result — raw/purged cohorts, boundaries, sensitivity,
   *  scenarios, methodology all drillable from here. */
  result: HistoricalValidationResult;
}

export interface StrategyComparisonResult {
  protocolVersion: typeof COMPARISON_PROTOCOL_VERSION;
  contractVersion: string;
  /** sha256 over protocol + strategy snapshots + dataset content + versions. */
  fingerprint: string;
  /** sha256 over uploaded cell OHLCV content only — stable dataset identity for
   *  the experiment registry's exposure ledger. Derived metadata; changing it
   *  is impossible without changing the fingerprint. */
  datasetFingerprint: string;
  datasets: HistoricalValidationResult["datasets"];
  /** The frozen shared protocol — echoed verbatim for export/inspection. */
  shared: ComparisonSharedConfig;
  strategies: ComparedStrategy[];
  /** Per-instrument aggregates — pooled rows are never presented as
   *  instrument-specific; multi-series comparisons inspect these. */
  perInstrument: {
    series: string;
    rows: { id: string; aggregate: ValidationAggregate }[];
  }[];
  /** Honesty block — what the final test cohort is and what this tool cannot
   *  guarantee about it. */
  testCohort: {
    evaluated: boolean;
    enforceable: boolean;
    note: string;
  };
  /** Cross-strategy fairness disclosures — always populated, never silent. */
  fairness: string[];
  warnings: string[];
  methodology: {
    comparison: string;
    ranking: string;
    uncertainty: string;
  };
  evaluatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic JSON — object keys sorted recursively so semantically equal
 *  snapshots hash identically regardless of key order. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

const snapshotKey = (s: Pick<ComparisonStrategy, "engineConfig" | "selection">): string =>
  stableStringify({ engineConfig: s.engineConfig, selection: s.selection ?? null });

function summarizeRow(s: ComparisonStrategy, r: HistoricalValidationResult): StrategyComparisonRow {
  const a = r.aggregate;
  return {
    id: s.id,
    label: s.label ?? s.id,
    configVersion: r.configVersion,
    ...(s.selection !== undefined ? { selection: s.selection } : {}),
    fingerprint: r.fingerprint,
    scenarioCount: a.scenarioCount,
    filledCount: a.filledCount,
    counts: a.counts,
    realizedCount: a.realizedCount,
    realizedWins: a.realizedWins,
    realizedLosses: a.realizedLosses,
    realizedBreakevens: a.realizedBreakevens,
    mtmCount: a.mtmCount,
    ...(a.realizedWinRate !== undefined ? { realizedWinRate: a.realizedWinRate } : {}),
    ...(a.realizedExpectancyR !== undefined ? { realizedExpectancyR: a.realizedExpectancyR } : {}),
    ...(a.expectancyR !== undefined ? { expectancyR: a.expectancyR } : {}),
    ...(a.totalR !== undefined ? { totalR: a.totalR } : {}),
    ...(a.medianR !== undefined ? { medianR: a.medianR } : {}),
    ...(a.maxDrawdownR !== undefined ? { maxDrawdownR: a.maxDrawdownR } : {}),
    ...(a.uncertainty !== undefined ? { uncertainty: a.uncertainty } : {}),
    ...(a.dependence !== undefined ? { dependence: a.dependence } : {}),
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Canonical dataset identity — sha256 digest over OHLCV tuples of every
 *  cell's anchor series and role-bound frames, in cell order. Extracted so the
 *  replay-bundle verifier recomputes the SAME identity the fingerprint binds —
 *  never a parallel hash definition. */
export function datasetFingerprintDigest(cells: BacktestCell[]): Buffer {
  const dataHash = createHash("sha256");
  for (const c of cells) {
    dataHash.update(`${c.symbol}@${c.timeframe}|`);
    for (const k of c.series.candles) {
      dataHash.update(`${k.time},${k.open},${k.high},${k.low},${k.close},${k.volume ?? ""};`);
    }
    for (const [role, f] of Object.entries(c.frames ?? {})) {
      for (const k of f.candles) {
        dataHash.update(`${role}:${k.time},${k.open},${k.high},${k.low},${k.close},${k.volume ?? ""};`);
      }
    }
  }
  return dataHash.digest();
}

export function runStrategyComparison(input: {
  cells: BacktestCell[];
  strategies: ComparisonStrategy[];
  shared: ComparisonSharedConfig;
  /** Engine run seam — tests inject a stub; production uses the canonical
   *  backtest. Each strategy supplies its own EngineConfig snapshot. */
  run?: typeof runBacktest;
}): StrategyComparisonResult {
  const { cells, strategies, shared, run } = input;

  // ---- Compatibility validation — reject, never fabricate a comparison. ----
  if (!Array.isArray(cells) || cells.length === 0) {
    throw new Error("at least one dataset cell is required.");
  }
  if (!Array.isArray(strategies) ||
      strategies.length < COMPARISON_STRATEGY_MIN ||
      strategies.length > COMPARISON_STRATEGY_MAX) {
    throw new Error(`supply ${COMPARISON_STRATEGY_MIN}–${COMPARISON_STRATEGY_MAX} strategies (got ${strategies?.length ?? 0}).`);
  }
  const ids = new Set<string>();
  for (const s of strategies) {
    if (typeof s?.id !== "string" || s.id.trim() === "") {
      throw new Error("every strategy needs a non-empty string id.");
    }
    if (ids.has(s.id)) {
      throw new Error(`duplicate strategy id '${s.id}' — rows must be distinguishable.`);
    }
    ids.add(s.id);
    if (s.engineConfig === null || typeof s.engineConfig !== "object" || typeof s.engineConfig.version !== "string") {
      throw new Error(`strategy '${s.id}' has no valid engineConfig snapshot (an EngineConfig object with a version string).`);
    }
    const sel = s.selection;
    if (sel !== undefined) {
      if (sel.setupTypes !== undefined &&
          (!Array.isArray(sel.setupTypes) || !sel.setupTypes.every((t) => SETUP_TYPES.includes(t)))) {
        throw new Error(`strategy '${s.id}' selection.setupTypes must be a subset of {reversal, breakout, continuation}.`);
      }
      if (sel.minScore !== undefined && (!Number.isFinite(sel.minScore) || sel.minScore < 0 || sel.minScore > 100)) {
        throw new Error(`strategy '${s.id}' selection.minScore must be between 0 and 100.`);
      }
    }
  }
  // Identical frozen inputs produce identical results — refuse the no-op.
  for (let i = 0; i < strategies.length; i += 1) {
    for (let j = i + 1; j < strategies.length; j += 1) {
      if (snapshotKey(strategies[i]) === snapshotKey(strategies[j])) {
        throw new Error(
          `strategies '${strategies[i].id}' and '${strategies[j].id}' have identical frozen inputs ` +
          "(same engineConfig snapshot and selection) — they cannot produce different results. " +
          "Change a parameter, selection, or remove the duplicate.",
        );
      }
    }
  }

  // ---- One canonical validation run per strategy — shared protocol verbatim,
  //      per-strategy engineConfig + selection. Config is resolved BEFORE any
  //      run executes; strategy construction can observe no outcomes. ----
  const compared: ComparedStrategy[] = strategies.map((s) => {
    const runConfig: ValidationRunConfig = {
      ...shared,
      ...(s.selection?.setupTypes !== undefined ? { setupTypes: s.selection.setupTypes } : {}),
      ...(s.selection?.minScore !== undefined ? { minScore: s.selection.minScore } : {}),
    };
    const result = runHistoricalValidation({
      cells,
      config: runConfig,
      deps: { config: s.engineConfig, ...(run !== undefined ? { run } : {}) },
    });
    return {
      id: s.id,
      engineConfig: s.engineConfig,
      label: s.label ?? s.id,
      configVersion: result.configVersion,
      ...(s.selection !== undefined ? { selection: s.selection } : {}),
      row: summarizeRow(s, result),
      result,
    };
  });

  const first = compared[0].result;

  // ---- Per-instrument aggregates — the pooled rows above are never presented
  //      as instrument-specific; mixed-series comparisons drill down here. ----
  const seriesKeys = [...new Set(
    compared.flatMap((c) => c.result.scenarios.map((s) => `${s.symbol}@${s.timeframe}`)),
  )];
  const perInstrument = seriesKeys.map((key) => ({
    series: key,
    rows: compared.map((c) => ({
      id: c.id,
      aggregate: aggregateScenarios(
        c.result.scenarios.filter((s) => `${s.symbol}@${s.timeframe}` === key),
      ),
    })),
  }));

  // ---- Fairness disclosures. ----
  const fairness: string[] = [];
  const counts = compared.map((c) => `${c.id}: ${c.row.scenarioCount}`);
  if (new Set(compared.map((c) => c.row.scenarioCount)).size > 1) {
    fairness.push(
      `strategies produced different opportunity counts (${counts.join(", ")}) — ` +
      "scenario sets are not matched trade-for-trade and counts are not independent observations.",
    );
  }
  const identical = compared.filter((c, i) =>
    compared.some((o, j) => j > i && o.row.fingerprint === c.row.fingerprint));
  if (identical.length > 0) {
    fairness.push(
      `strategies [${[...new Set(identical.map((c) => c.id))].join(", ")}] produced identical ` +
      "evaluation output on this dataset — their distinct snapshots are equivalent here; " +
      "identical results are not independent confirmation.",
    );
  }
  const symbols = new Set(first.datasets.map((d) => d.symbol));
  if (symbols.size > 1) {
    fairness.push(
      `${symbols.size} instruments are pooled in the comparison rows — pooled aggregates are ` +
      "not instrument-specific results; inspect the per-instrument breakdown.",
    );
  }
  for (const c of compared) {
    const refused = c.row.uncertainty?.notes.filter((n) => /refus/i.test(n)) ?? [];
    if (c.row.uncertainty?.winRate === undefined || c.row.uncertainty?.expectancyR === undefined) {
      fairness.push(
        `'${c.id}': at least one interval was refused or unavailable` +
        (refused.length > 0 ? ` — ${refused.join(" ")}` : "") +
        " — ranking this strategy is descriptive, not statistically supported.",
      );
    }
  }
  fairness.push(
    "Rows are ordered by input order, not by a decisive ranking — realized samples, dependence " +
    "clusters, and censored shares determine whether any ordering is meaningful.",
  );

  const testCohort = {
    evaluated: first.splits !== undefined && first.splits.length > 0 &&
      (first.splits[first.splits.length - 1]?.aggregate.scenarioCount ?? 0) > 0,
    enforceable: false,
    note:
      "Strategy selection history cannot be tracked across independent comparisons — this tool " +
      "cannot guarantee the final test cohort was never inspected during earlier configuration " +
      "work. Treat test-cohort results as descriptive evidence about THIS sample, not as " +
      "independent out-of-sample confirmation.",
  };

  // ---- Comparison fingerprint — binds protocol, strategy snapshots, dataset
  //      content (same OHLCV tuples hv1 hashes), engine + contract versions. ----
  const datasetDigest = datasetFingerprintDigest(cells);
  const fingerprint = createHash("sha256")
    .update(stableStringify({
      v: COMPARISON_PROTOCOL_VERSION,
      contract: VALIDATION_CONTRACT_VERSION,
      shared,
      strategies: strategies.map((s) => ({
        id: s.id,
        label: s.label ?? null,
        engineConfig: s.engineConfig,
        selection: s.selection ?? null,
      })),
      datasets: first.datasets,
      engineVersions: first.engineDiagnostics?.engineVersions ?? null,
    }))
    .update(datasetDigest)
  .digest("hex");

  const warnings = [...new Set(compared.flatMap((c) => c.result.warnings.map((w) => `${c.id}: ${w}`)))];

  return {
    protocolVersion: COMPARISON_PROTOCOL_VERSION,
    contractVersion: VALIDATION_CONTRACT_VERSION,
    fingerprint,
    datasetFingerprint: datasetDigest.toString("hex"),
    datasets: first.datasets,
    shared,
    strategies: compared,
    perInstrument,
    testCohort,
    fairness,
    warnings,
    methodology: {
      comparison:
        "Every strategy is evaluated by the canonical hv1 contract on identical cells and an " +
        "identical shared protocol (horizon, costs, split, purge, sensitivity). Strategies differ " +
        "only in their frozen EngineConfig snapshot and optional setup-type/minScore selection. " +
        "The evaluation range is the full supplied dataset.",
      ranking:
        "Comparison rows are descriptive. Realized win rate and expectancy use realized " +
        "denominators only; censored mark-to-market rows are never mixed in. Different scenario " +
        "counts are reported, not reconciled. No ranking presented here is statistically decisive.",
      uncertainty: first.methodology.uncertaintyMethod,
    },
    evaluatedAt: new Date().toISOString(),
  };
}
