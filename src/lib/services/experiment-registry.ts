/**
 * Experiment Registry & Test-Set Exposure Tracking — er1 schema (V1).
 *
 * A lightweight research ledger for Strategy Comparison Lab runs. It records
 * frozen comparison inputs + result summaries and tracks whether an
 * evaluation's dataset/test period was previously recorded — so repeated
 * evaluation of the same historical period is never silently presented as
 * independent out-of-sample evidence.
 *
 * Scope and honesty contract:
 *  - ADDITIVE ONLY. Registering a run mutates no inputs, no fingerprints, no
 *    results. The registry never blocks a valid comparison — it classifies
 *    and discloses.
 *  - The experiment fingerprint (comp-v1) identifies WHAT was evaluated. The
 *    registry recordId identifies the registry RECORD (the event of storing
 *    it). Same fingerprint ≠ same record — a repeat is recorded and labelled.
 *  - "No prior exposure recorded in this registry" is the strongest claim
 *    available — registry history is local, per-browser, and lossy; it never
 *    proves a period unseen elsewhere.
 *  - Imported records are user-supplied claims, never presented as verified
 *    engine output.
 *  - One comparison = ONE experiment. Its constituent strategies are rows,
 *    not independent experiments.
 */
import { sha256Hex } from "@/lib/services/sha256";
import {
  stableStringify,
  type ComparisonSharedConfig,
  type ComparisonStrategy,
  type StrategyComparisonResult,
} from "@/lib/services/strategy-comparison";
import type { StrategyComparisonRow } from "@/lib/services/strategy-comparison";

export const REGISTRY_SCHEMA_VERSION = "er1";
export const REGISTRY_STORAGE_KEY = "ti:experiment-registry:er1";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** A materialized period in wall-clock-free market time (ISO strings). */
export interface PeriodRange {
  from: string;
  to: string;
}

/** Cohort bookkeeping retained per strategy — raw vs purged is never merged. */
export interface RecordedCohort {
  name: string;
  scenarioCount: number;
  purgedCount?: number;
  retainedCount?: number;
}

export interface RecordedStrategy {
  id: string;
  label: string;
  /** Frozen snapshot verbatim — enough to reconstruct what was evaluated. */
  engineConfig: ComparisonStrategy["engineConfig"];
  selection?: ComparisonStrategy["selection"];
  /** hv1 fingerprint of this strategy's sub-run — deterministic reference. */
  resultFingerprint: string;
  row: StrategyComparisonRow;
  cohorts: RecordedCohort[];
  boundaryStatus?: string;
}

/** Exposure classification — set at registration; recomputed on view.
 *  Deterministic precedence: repeat > exposed > consumed-window-overlap >
 *  overlap > no-prior-exposure. unknown short-circuits whenever dataset or
 *  period identity is unavailable. */
export type ExposureStatus =
  | "repeat"                    // identical experiment fingerprint already registered
  | "exposed"                   // different experiment, same dataset + same test period
  | "consumed-window-overlap"   // verifiable same-series consumed intervals intersect
  | "overlap"                   // same dataset, test periods overlap but differ
  | "no-prior-exposure"         // nothing matched — NOT "unseen"/"independent"
  | "unknown";                  // dataset or period identity unavailable

/** A merged same-series consumed interval in BOTH representations:
 *  bar indices (comparable only when datasetFingerprint matches) and ISO times
 *  (comparable across datasets on the same series identity). Canonical window
 *  semantics: consumed = (anchorBar, resolvedBar] → stored as [fromBar, toBar]
 *  with fromBar = anchorBar + 1, toBar = resolvedBar. */
export interface ConsumedWindow {
  series: string;              // canonical `${symbol}@${timeframe}`
  fromBar: number;
  toBar: number;
  fromTime: string;
  toTime: string;
  /** Test-cohort scenarios merged into this interval. */
  scenarioCount: number;
  /** Scenarios purged by boundary rules — disclosed, still consumed. */
  purgedCount: number;
}

export interface ExposureReport {
  status: ExposureStatus;
  /** "full" when every test-cohort scenario yielded a verifiable interval;
   *  "partial" when some lacked series/resolved metadata or consumed windows
   *  were unavailable — partial coverage is disclosed, never upgraded to
   *  proof of an untouched set. */
  coverage: "full" | "partial";
  /** Registry recordIds that determined the classification. */
  matched: { recordId: string; fingerprint: string; relation: string }[];
  /** Verbatim disclosure text — rendered in the UI, never paraphrased. */
  note: string;
}

export interface ExperimentRecord {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  /** Registry identity: sha256(fingerprint + createdAt + provenance).
   *  NOT the experiment fingerprint — it identifies this ledger entry. */
  recordId: string;
  /** Wall-clock creation time — explicitly distinct from market-data times. */
  createdAt: string;
  provenance: "local" | "imported";
  fingerprint: string;
  protocolVersion: string;
  contractVersion: string;
  datasetFingerprint?: string;
  datasets: StrategyComparisonResult["datasets"];
  /** min/max bar times across datasets — the evaluated range. */
  evaluationRange?: PeriodRange;
  /** Union of per-strategy test-cohort anchor ranges; undefined when no split
   *  ran — exposure then reports unknown rather than guessing. */
  testPeriod?: PeriodRange;
  /** ADDITIVE er1 field — merged same-series consumed intervals of the TEST
   *  cohort across all strategies, per canonical (anchorBar, resolvedBar].
   *  Absent on legacy records and when no split ran. */
  consumedWindows?: ConsumedWindow[];
  /** Test-cohort scenarios whose consumed interval could not be established —
   *  the coverage gap that keeps classification honest. */
  unverifiableWindows?: number;
  shared: ComparisonSharedConfig;
  strategies: RecordedStrategy[];
  uncertaintyMethod?: string;
  exposure: ExposureReport;
  /** Set on import when this record's schemaVersion is not er1 — the record
   *  lists in history but cannot be opened, diffed, or trusted. */
  unsupported?: boolean;
  /** Same recordId, different content — surfaced, never silently merged. */
  identityConflict?: boolean;
}

// ---------------------------------------------------------------------------
// Record construction — pure; `now` injected for deterministic tests.
// ---------------------------------------------------------------------------

export function buildRecord(input: {
  result: StrategyComparisonResult;
  strategies: ComparisonStrategy[];
  createdAt: string;
  provenance?: "local" | "imported";
}): ExperimentRecord {
  const { result, strategies, createdAt } = input;
  const provenance = input.provenance ?? "local";
  const byId = new Map(strategies.map((s) => [s.id, s]));

  // Test period = union of test-cohort anchor ranges across strategies —
  // actual anchor times from hv1 splits, not derived fractions.
  const testRanges = result.strategies
    .map((c) => c.result.splits?.[c.result.splits.length - 1])
    .filter((s): s is NonNullable<typeof s> =>
      s !== undefined && s.anchorFrom !== undefined && s.anchorTo !== undefined);
  const testPeriod: PeriodRange | undefined =
    testRanges.length > 0 && result.testCohort.evaluated
      ? {
          from: testRanges.map((s) => s.anchorFrom!).sort()[0],
          to: testRanges.map((s) => s.anchorTo!).sort().reverse()[0],
        }
      : undefined;

  const times = result.datasets.flatMap((d) => [d.firstBar, d.lastBar].filter(Boolean));
  const evaluationRange: PeriodRange | undefined = times.length > 0
    ? { from: times.slice().sort()[0], to: times.slice().sort().reverse()[0] }
    : undefined;

  // ---- Consumed windows — canonical (anchorBar, resolvedBar] intervals of
  //      TEST-cohort scenarios, merged per series. unevaluable scenarios
  //      consumed no outcome bars (existing contract) and contribute nothing;
  //      anything else missing series/resolved metadata is counted
  //      unverifiable — partial coverage is disclosed, never hidden. ----
  const intervals: (ConsumedWindow & { strategyId: string })[] = [];
  let unverifiable = 0;
  for (const c of result.strategies) {
    const splits = c.result.splits ?? [];
    const test = splits[splits.length - 1];
    if (test === undefined || !result.testCohort.evaluated ||
        !Number.isInteger(test.fromScenario) || !Number.isInteger(test.toScenario)) continue;
    const purgedIds = new Set(test.purged?.purgedSetupIds ?? []);
    const slice = (c.result.scenarios ?? []).slice(test.fromScenario, test.toScenario);
    for (const s of slice) {
      if (s.status === "unevaluable") continue; // consumed no outcome bars
      const series = s.symbol !== undefined && s.timeframe !== undefined
        ? `${s.symbol}@${s.timeframe}` : undefined;
      if (series === undefined || s.resolvedBar === undefined ||
          s.anchorTime === undefined || s.resolvedAt === undefined) {
        unverifiable += 1;
        continue;
      }
      intervals.push({
        strategyId: c.id, series,
        fromBar: s.anchorBar + 1, toBar: s.resolvedBar,
        fromTime: s.anchorTime, toTime: s.resolvedAt,
        scenarioCount: 1,
        purgedCount: purgedIds.has(s.setupId) ? 1 : 0,
      });
    }
  }
  // Merge overlapping consumed intervals per series (bar semantics — same
  // dataset within a record, so indices are comparable here).
  const bySeries = new Map<string, ConsumedWindow[]>();
  for (const iv of [...intervals].sort((a, b) => a.fromBar - b.fromBar || a.toBar - b.toBar)) {
    const list = bySeries.get(iv.series) ?? [];
    const last = list[list.length - 1];
    if (last !== undefined && iv.fromBar <= last.toBar) {
      last.toBar = Math.max(last.toBar, iv.toBar);
      last.fromTime = last.fromTime < iv.fromTime ? last.fromTime : iv.fromTime;
      last.toTime = last.toTime > iv.toTime ? last.toTime : iv.toTime;
      last.scenarioCount += iv.scenarioCount;
      last.purgedCount += iv.purgedCount;
    } else {
      list.push({
        series: iv.series, fromBar: iv.fromBar, toBar: iv.toBar,
        fromTime: iv.fromTime, toTime: iv.toTime,
        scenarioCount: iv.scenarioCount, purgedCount: iv.purgedCount,
      });
    }
    bySeries.set(iv.series, list);
  }
  const consumedWindows = [...bySeries.values()].flat();

  const record: ExperimentRecord = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    recordId: sha256Hex(`${result.fingerprint}|${createdAt}|${provenance}`),
    createdAt,
    provenance,
    fingerprint: result.fingerprint,
    protocolVersion: result.protocolVersion,
    contractVersion: result.contractVersion,
    ...(result.datasetFingerprint !== undefined
      ? { datasetFingerprint: result.datasetFingerprint } : {}),
    datasets: result.datasets,
    ...(evaluationRange !== undefined ? { evaluationRange } : {}),
    ...(testPeriod !== undefined ? { testPeriod } : {}),
    ...(consumedWindows.length > 0 ? { consumedWindows } : {}),
    ...(unverifiable > 0 ? { unverifiableWindows: unverifiable } : {}),
    shared: result.shared,
    strategies: result.strategies.map((c) => {
      const s = byId.get(c.id);
      return {
        id: c.id,
        label: c.label,
        engineConfig: s?.engineConfig ?? ({} as ComparisonStrategy["engineConfig"]),
        ...(s?.selection !== undefined ? { selection: s.selection } : c.selection !== undefined ? { selection: c.selection } : {}),
        resultFingerprint: c.row.fingerprint,
        row: c.row,
        cohorts: (c.result.splits ?? []).map((split) => ({
          name: split.name,
          scenarioCount: split.aggregate.scenarioCount,
          ...(split.purged !== undefined ? {
            purgedCount: split.purged.purgedCount,
            retainedCount: split.purged.retainedCount,
          } : {}),
        })),
        ...(c.result.walkForward !== undefined ? { boundaryStatus: c.result.walkForward.status } : {}),
      };
    }),
    ...(result.strategies[0]?.result.methodology?.uncertaintyMethod !== undefined
      ? { uncertaintyMethod: result.strategies[0].result.methodology.uncertaintyMethod }
      : {}),
    // Placeholder — filled by register() after classification; buildRecord is
    // pure so callers can fingerprint the record before ledger state applies.
    exposure: { status: "unknown", coverage: "partial", matched: [], note: "not yet classified" },
  };
  return record;
}

// ---------------------------------------------------------------------------
// Exposure ledger — classification against registered history.
// ---------------------------------------------------------------------------

const overlaps = (a: PeriodRange, b: PeriodRange): boolean =>
  a.from <= b.to && b.from <= a.to;

const samePeriod = (a: PeriodRange, b: PeriodRange): boolean =>
  a.from === b.from && a.to === b.to;

/** Same-series consumed-window intersection. Bar indices are authoritative
 *  when both records share a datasetFingerprint (same upload — indices are
 *  identical coordinates). Across different uploads of the same series the
 *  canonical (anchorTime, resolvedAt] interval is used — open-left,
 *  closed-right, matching the engine's window semantics. Series keys must
 *  match exactly, so identical bar indices or identical timestamps on
 *  different series/timeframes can never produce a false match. */
function consumedOverlap(
  cw: ConsumedWindow, hw: ConsumedWindow, sameDataset: boolean,
): string | undefined {
  if (cw.series !== hw.series) return undefined;
  if (sameDataset) {
    if (cw.fromBar <= hw.toBar && hw.fromBar <= cw.toBar) {
      return `${cw.series} bars [${Math.max(cw.fromBar, hw.fromBar)}–${Math.min(cw.toBar, hw.toBar)}]`;
    }
    return undefined;
  }
  // Open-left, closed-right (anchor, resolved] time overlap.
  if (cw.fromTime < hw.toTime && hw.fromTime < cw.toTime) {
    return `${cw.series} times ${(cw.fromTime > hw.fromTime ? cw.fromTime : hw.fromTime).slice(0, 10)}…` +
      `${(cw.toTime < hw.toTime ? cw.toTime : hw.toTime).slice(0, 10)}`;
  }
  return undefined;
}

/**
 * Deterministic precedence (every class documented):
 *  1. repeat                 — identical experiment fingerprint
 *  2. exposed                — same dataset + identical test period
 *  3. consumed-window-overlap — verifiable same-series consumed intervals
 *                              intersect (stronger evidence than coarse
 *                              period-bounds overlap → ranked above it)
 *  4. overlap                — same dataset + test-period bounds overlap,
 *                              no verifiable consumed intersection
 *  5. no-prior-exposure      — nothing matched
 *  unknown short-circuits when dataset or period identity is unavailable.
 */
export function classifyExposure(
  candidate: Pick<ExperimentRecord,
    "fingerprint" | "datasetFingerprint" | "testPeriod" | "consumedWindows" | "unverifiableWindows">,
  history: ExperimentRecord[],
): ExposureReport {
  // Exact repeat — same experiment fingerprint anywhere in history.
  const repeats = history.filter((r) => r.fingerprint === candidate.fingerprint);
  if (repeats.length > 0) {
    return {
      status: "repeat",
      coverage: "full",
      matched: repeats.map((r) => ({ recordId: r.recordId, fingerprint: r.fingerprint, relation: "identical fingerprint" })),
      note:
        `this exact experiment was already recorded ${repeats.length} time(s) — ` +
        "a repeated fingerprint is the same evaluation, not independent confirmation.",
    };
  }
  if (candidate.datasetFingerprint === undefined || candidate.testPeriod === undefined) {
    return {
      status: "unknown",
      coverage: "partial",
      matched: [],
      note:
        "dataset identity or test-period range is unavailable (no split, or a legacy " +
        "record) — exposure cannot be established; do not treat this period as untouched.",
    };
  }
  const candidatePeriod = candidate.testPeriod;
  const sameData = history.filter((r) => r.datasetFingerprint === candidate.datasetFingerprint);
  const withPeriods = sameData.filter(
    (r): r is ExperimentRecord & { testPeriod: PeriodRange } => r.testPeriod !== undefined);
  const exposed = withPeriods.filter((r) => samePeriod(r.testPeriod, candidatePeriod));
  if (exposed.length > 0) {
    return {
      status: "exposed",
      coverage: "full",
      matched: exposed.map((r) => ({ recordId: r.recordId, fingerprint: r.fingerprint, relation: "same dataset + same test period" })),
      note:
        `the test period ${candidatePeriod.from}…${candidatePeriod.to} was previously ` +
        `exposed by ${exposed.length} recorded comparison(s) — results on it are a reused ` +
        "period, not untouched out-of-sample evidence.",
    };
  }

  // Consumed-window overlap — checked against ALL history (same-series time
  // comparison reaches records on different uploads of the same series), not
  // just same-dataset records.
  const cWins = candidate.consumedWindows ?? [];
  const partialCoverage =
    cWins.length === 0 || (candidate.unverifiableWindows ?? 0) > 0 ||
    history.some((r) => r.testPeriod !== undefined && r.consumedWindows === undefined);
  const consumedMatched: { recordId: string; fingerprint: string; relation: string }[] = [];
  for (const r of history) {
    const sameDataset = r.datasetFingerprint === candidate.datasetFingerprint;
    for (const hw of r.consumedWindows ?? []) {
      for (const cw of cWins) {
        const hit = consumedOverlap(cw, hw, sameDataset);
        if (hit !== undefined) {
          consumedMatched.push({
            recordId: r.recordId, fingerprint: r.fingerprint,
            relation: `consumed-window overlap on ${hit}${sameDataset ? "" : " (time-based, different dataset version)"}`,
          });
        }
      }
    }
  }
  if (consumedMatched.length > 0) {
    return {
      status: "consumed-window-overlap",
      coverage: partialCoverage ? "partial" : "full",
      matched: consumedMatched,
      note:
        `verifiable consumed windows (anchorBar, resolvedBar] intersect prior records on ` +
        `${consumedMatched.length} record(s) — individual scenario windows share bars with ` +
        `recorded evaluations.${partialCoverage
          ? " Coverage is partial: some scenarios lacked verifiable intervals, so undetected overlap remains possible."
          : ""} Detected overlap is evidence of reuse — its absence is never proof of an untouched set.`,
    };
  }

  const overlapped = withPeriods.filter((r) => overlaps(r.testPeriod, candidatePeriod));
  if (overlapped.length > 0) {
    return {
      status: "overlap",
      coverage: partialCoverage ? "partial" : "full",
      matched: overlapped.map((r) => ({ recordId: r.recordId, fingerprint: r.fingerprint, relation: "overlapping test period" })),
      note:
        `the test period ${candidatePeriod.from}…${candidatePeriod.to} overlaps a ` +
        `previously recorded evaluation window${cWins.length > 0
          ? ", though no verifiable consumed-window intersection was found"
          : " (consumed-window verification unavailable)"} — partial prior exposure is possible.`,
    };
  }
  return {
    status: "no-prior-exposure",
    coverage: partialCoverage ? "partial" : "full",
    matched: [],
    note:
      "no prior exposure recorded in this registry for this dataset/test period — " +
      "registry history is browser-local and may be incomplete; this is NOT a " +
      "guarantee the period was never evaluated elsewhere.",
  };
}

/** Register a record: classify exposure against history, append, return both.
 *  Never refuses a valid record — exposure is disclosed, not blocked. */
export function register(
  history: ExperimentRecord[],
  record: ExperimentRecord,
): { record: ExperimentRecord; history: ExperimentRecord[] } {
  const stamped: ExperimentRecord = {
    ...record,
    exposure: classifyExposure(record, history),
  };
  return { record: stamped, history: [...history, stamped] };
}

// ---------------------------------------------------------------------------
// Deterministic run-vs-run difference report.
// ---------------------------------------------------------------------------

export interface RecordDiff {
  path: string;
  a: unknown;
  b: unknown;
}

const leaf = (v: unknown): unknown => {
  if (v === null || typeof v !== "object") return v;
  return JSON.parse(JSON.stringify(v));
};

/** Deterministic leaf-diff recursion — shared by diffRecords and the
 *  reproducibility-manifest diff so both reports use identical semantics. */
export function diffValue(path: string, a: unknown, b: unknown, out: RecordDiff[]): void {
  if (stableStringify(a ?? null) === stableStringify(b ?? null)) return;
  const ao = a !== null && typeof a === "object" && !Array.isArray(a) ? a as Record<string, unknown> : undefined;
  const bo = b !== null && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : undefined;
  if (ao !== undefined && bo !== undefined) {
    for (const k of [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort()) {
      diffValue(path === "" ? k : `${path}.${k}`, ao[k], bo[k], out);
    }
    return;
  }
  out.push({ path, a: leaf(a), b: leaf(b) });
}

/** Reproducible configuration-difference report between two records — sorted
 *  paths, leaf values only. Identical inputs ⇒ empty diff. */
export function diffRecords(a: ExperimentRecord, b: ExperimentRecord): RecordDiff[] {
  const out: RecordDiff[] = [];
  diffValue("shared", a.shared, b.shared, out);
  const aStrat = Object.fromEntries(a.strategies.map((s) => [s.id, s]));
  const bStrat = Object.fromEntries(b.strategies.map((s) => [s.id, s]));
  for (const id of [...new Set([...Object.keys(aStrat), ...Object.keys(bStrat)])].sort()) {
    diffValue(`strategy.${id}`, aStrat[id] ?? null, bStrat[id] ?? null, out);
  }
  diffValue("datasets", a.datasets, b.datasets, out);
  return out;
}

// ---------------------------------------------------------------------------
// Versioned export / import.
// ---------------------------------------------------------------------------

export const REGISTRY_EXPORT_FORMAT = "ti-experiment-registry";

export interface RegistryExport {
  format: typeof REGISTRY_EXPORT_FORMAT;
  schemaVersion: string;
  records: ExperimentRecord[];
}

/** Deterministic export — no wall-clock fields; identical records ⇒ identical
 *  bytes (stableStringify). */
export function exportRecords(records: ExperimentRecord[]): string {
  const payload: RegistryExport = {
    format: REGISTRY_EXPORT_FORMAT,
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    records,
  };
  return stableStringify(payload);
}

export interface ImportOutcome {
  ok: boolean;
  error?: string;
  imported: ExperimentRecord[];
  /** Human-readable notices: duplicates skipped, conflicts flagged,
   *  unsupported versions, provenance disclaimers. */
  notices: string[];
  history: ExperimentRecord[];
}

const isRecordShape = (r: unknown): r is ExperimentRecord => {
  const o = r as Record<string, unknown>;
  return o !== null && typeof o === "object" &&
    typeof o.recordId === "string" && typeof o.fingerprint === "string" &&
    typeof o.schemaVersion === "string" && Array.isArray(o.strategies);
};

/**
 * Parse + merge an import file. Rules:
 *  - Wrong format / malformed JSON → actionable error, history untouched.
 *  - Unsupported schemaVersion → record is kept flagged `unsupported` (listed,
 *  not opened/diffed) — never silently reinterpreted.
 *  - Exact duplicate (same recordId + fingerprint) → skipped with a notice.
 *  - Same recordId, different content → imported flagged `identityConflict`.
 *  - Imported records are marked provenance "imported" — user-supplied claims.
 */
export function importRecords(json: string, history: ExperimentRecord[]): ImportOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "file is not valid JSON.", imported: [], notices: [], history };
  }
  const env = parsed as Partial<RegistryExport>;
  if (env.format !== REGISTRY_EXPORT_FORMAT || !Array.isArray(env.records)) {
    return {
      ok: false,
      error: `unrecognized file — expected format "${REGISTRY_EXPORT_FORMAT}" with a records array.`,
      imported: [], notices: [], history,
    };
  }
  const notices: string[] = [
    "imported records are user-supplied claims — this file does not prove any run " +
    "was executed by this engine.",
  ];
  const imported: ExperimentRecord[] = [];
  const merged = [...history];
  const byId = new Map(merged.map((r, i) => [r.recordId, i]));

  env.records.forEach((raw, i) => {
    if (!isRecordShape(raw)) {
      notices.push(`record ${i + 1}: malformed — missing recordId/fingerprint/strategies; skipped.`);
      return;
    }
    const rec: ExperimentRecord = JSON.parse(JSON.stringify(raw));
    if (rec.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
      rec.unsupported = true;
      notices.push(
        `record ${i + 1} (${rec.fingerprint.slice(0, 8)}…): schemaVersion "${rec.schemaVersion}" ` +
        `is not supported by registry ${REGISTRY_SCHEMA_VERSION} — stored as unsupported, not reinterpreted.`,
      );
    }
    const prior = byId.get(rec.recordId);
    if (prior !== undefined) {
      if (merged[prior].fingerprint === rec.fingerprint &&
          stableStringify(merged[prior]) === stableStringify(rec)) {
        notices.push(`record ${i + 1}: identical to an existing entry — duplicate skipped.`);
        return;
      }
      rec.identityConflict = true;
      notices.push(
        `record ${i + 1}: recordId already exists with different content — imported ` +
        "flagged as an identity conflict; treat one or both as untrusted.",
      );
    }
    rec.provenance = "imported";
    imported.push(rec);
    byId.set(rec.recordId, merged.length);
    merged.push(rec);
  });
  return { ok: true, imported, notices, history: merged };
}

// ---------------------------------------------------------------------------
// Storage adapters — the service is pure; persistence is injected.
// ---------------------------------------------------------------------------

export interface RegistryStore {
  load(): ExperimentRecord[];
  save(records: ExperimentRecord[]): void;
  /** True when writes survive — false for the memory fallback. */
  persistent: boolean;
  /** Why persistence is limited — rendered verbatim in the UI. */
  limitation: string;
}

export const BROWSER_LOCAL_LIMITATION =
  "Research history is stored in this browser only (localStorage). Records are " +
  "not shared across browsers, devices, or users, and are lost if local data " +
  "is cleared. Export JSON to preserve or transfer history.";

/** Browser localStorage adapter — guarded so SSR/tests never touch window. */
export function browserStore(): RegistryStore {
  const memory = memoryStore();
  if (typeof window === "undefined" || window.localStorage === undefined) return memory;
  return {
    persistent: true,
    limitation: BROWSER_LOCAL_LIMITATION,
    load: () => {
      try {
        const raw = window.localStorage.getItem(REGISTRY_STORAGE_KEY);
        if (raw === null) return [];
        const parsed = JSON.parse(raw) as { records?: ExperimentRecord[] };
        return Array.isArray(parsed.records) ? parsed.records : [];
      } catch {
        return memory.load(); // corrupt store → empty rather than crash
      }
    },
    save: (records) => {
      try {
        window.localStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify({ records }));
      } catch {
        // Quota/permission failure — surface via limitation text; the record
        // still exists in component state for this session.
      }
    },
  };
}

export function memoryStore(): RegistryStore {
  let records: ExperimentRecord[] = [];
  return {
    persistent: false,
    limitation: "in-memory history — records are lost when the page reloads.",
    load: () => records,
    save: (next) => { records = next; },
  };
}
