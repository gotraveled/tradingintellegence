/**
 * Phase 8 — Scanner: opportunity discovery & ranking (docs/engine/25).
 *
 * A discovery/ranking engine, NOT the pipeline orchestrator: it receives no candles and never
 * detects, scores, estimates, or measures. Its only inputs are caller-produced point-in-time
 * `ScanCandidate` artifacts plus a declared universe and `asOf`. Its whole job:
 *
 *   validate → canonicalize → dedup → eligibility → filters → rank → topK
 *
 * Causality: the engine is temporally inert — it cannot look ahead because it sees no market
 * data. It *preserves* causality by validating declared provenance (`evaluatedAt ≤ asOf`,
 * evidence `decisionTime ≤ asOf`); it never verifies provenance against candles — that is
 * upstream's guarantee.
 *
 * Ranking is Opportunity Score only (spec 15) with a strict total order — statistical evidence
 * (spec 24, caller-attached) is orthogonal and never reorders the list.
 */
import type {
  ScanCandidate,
  ScanFilters,
  ScanResult,
  ScanUniverse,
  ScannedOpportunity,
  ScannerConfig,
  SetupRef,
  SetupStatus,
  Timeframe,
  UnixMs,
} from "@/lib/types";
import type { EngineError, EngineResult, ScannerEngine } from "@/lib/services/engine";

/** Canonical `Timeframe` declaration order — ascending granularity (spec 25 tie-break). */
const TF_ORDER: Record<Timeframe, number> = {
  "1m": 0, "3m": 1, "5m": 2, "15m": 3, "30m": 4, "1h": 5, "2h": 6, "4h": 7,
  "6h": 8, "12h": 9, "1D": 10, "1W": 11, "1M": 12,
};

const TERMINAL: ReadonlySet<SetupStatus> = new Set([
  "target_reached", "invalidated", "expired", "cancelled",
]);
const RANKABLE: ReadonlySet<SetupStatus> = new Set(["confirmed", "active", "partial_target"]);

/**
 * Stable, locale-independent serialization: JSON.stringify with every object key emitted in
 * sorted order (recursive) — deterministic tie-breaker, never object identity or input order.
 */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.keys(x).sort().reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (x as Record<string, unknown>)[k];
          return acc;
        }, {})
      : x);

const scoreOf = (c: ScanCandidate): number =>
  c.score.score !== undefined ? c.score.score : -Infinity;

/**
 * The scan — pure over `{asOf, universe, candidates, filters, config}`: identical inputs
 * produce a bit-identical `ScanResult` under any candidate-array permutation.
 */
export function scanUniverse(input: {
  asOf: UnixMs;
  universe: ScanUniverse;
  candidates: ScanCandidate[];
  filters?: ScanFilters;
  config: ScannerConfig;
}): EngineResult<ScanResult> {
  const { asOf, universe, candidates, filters, config } = input;
  const methodVersion = config.methodVersion;
  /** Spec 25 grammar — scanner-owned params only; upstream versions stay on their artifacts. */
  const paramsVersion = `tk${config.topK === 0 ? "*" : config.topK}|dev${config.includeDeveloping ? 1 : 0}`;

  const meta = (extra?: Record<string, string | number | boolean>) => ({
    stage: "scanner",
    paramsVersion,
    barsConsumed: { from: -1, to: -1 }, // consumes artifacts, never bars
    events: [],
    diagnostics: extra,
  });
  const fail = (code: EngineError["code"], message: string) =>
    ({ ok: false as const, errors: [{ code, message }], meta: meta() });

  // ---- 1. Validate: config + provenance (declared, not reconstructed). ----
  if (!(config.topK >= 0) || !Number.isInteger(config.topK) || !methodVersion) {
    return fail("invalid_config",
      "scanner config: topK must be an integer ≥ 0 (0 = unbounded), methodVersion required");
  }
  const excluded = {
    missingProvenance: 0, futureCandidate: 0, futureEvidence: 0,
    terminal: 0, gated: 0, unrankable: 0,
  };
  interface Valid extends ScanCandidate { provenance: NonNullable<ScanCandidate["provenance"]> }
  const valid: Valid[] = [];
  for (const c of candidates) {
    // Provenance: missing → out; future-evaluated → out; future evidence → strip only.
    const p = c.provenance;
    if (p === undefined || typeof p.evaluatedAt !== "number") { excluded.missingProvenance++; continue; }
    if (p.evaluatedAt > asOf) { excluded.futureCandidate++; continue; }
    let evidence = c.statisticalEvidence;
    if (evidence !== undefined && evidence.decisionTime > asOf) {
      excluded.futureEvidence++;
      evidence = undefined;
    }
    valid.push({ ...c, provenance: p, statisticalEvidence: evidence });
  }

  // ---- 2. Canonicalize: setupId asc → evaluatedAt desc → score desc → serial asc. ----
  const canonical = [...valid].sort((a, b) =>
    a.setup.id.localeCompare(b.setup.id) ||
    b.provenance.evaluatedAt - a.provenance.evaluatedAt ||
    scoreOf(b) - scoreOf(a) ||
    stable(a).localeCompare(stable(b)));

  // ---- 3. Deduplicate: first-per-setupId in canonical order = freshest, then best score. ----
  const seen = new Set<string>();
  const duplicateSetupIds: string[] = [];
  const unique: typeof canonical = [];
  for (const c of canonical) {
    if (seen.has(c.setup.id)) { duplicateSetupIds.push(c.setup.id); continue; }
    seen.add(c.setup.id);
    unique.push(c);
  }

  // ---- 4. Eligibility: existing lifecycle + scoring semantics only. ----
  const developing: Valid[] = [];
  const rankable: Valid[] = [];
  for (const c of unique) {
    const st = c.setup.status;
    if (TERMINAL.has(st)) { excluded.terminal++; continue; }
    if (st === "developing") {
      if (config.includeDeveloping) developing.push(c); else excluded.unrankable++;
      continue;
    }
    if (!RANKABLE.has(st)) { excluded.unrankable++; continue; } // unreachable today — defensive
    if (c.score.gate !== undefined) { excluded.gated++; continue; }
    if (c.score.score === undefined) { excluded.unrankable++; continue; }
    rankable.push(c);
  }

  // ---- 5. Request filters: membership only — never order. ----
  const f = filters ?? {};
  const allow = <T>(dims: T[] | undefined, v: T) => dims === undefined || dims.includes(v);
  let filteredOut = 0;
  const kept = rankable.filter((c) => {
    const ok =
      allow(f.symbols, c.cell.symbol) &&
      allow(f.timeframes, c.cell.timeframe) &&
      allow(f.setupTypes, c.setup.type) &&
      allow(f.directions, c.setup.direction) &&
      allow(f.statuses, c.setup.status) &&
      (f.minScore === undefined || scoreOf(c) >= f.minScore);
    if (!ok) filteredOut++;
    return ok;
  });

  // ---- 6. Rank: score desc → symbol asc → timeframe canonical → setupId asc. ----
  kept.sort((a, b) =>
    scoreOf(b) - scoreOf(a) ||
    a.cell.symbol.localeCompare(b.cell.symbol) ||
    TF_ORDER[a.cell.timeframe] - TF_ORDER[b.cell.timeframe] ||
    a.setup.id.localeCompare(b.setup.id));

  // ---- 7. topK: slice AFTER ranking; 0 = unbounded, still fully ranked. ----
  const sliced = config.topK > 0 ? kept.slice(0, config.topK) : kept;
  const ranked: ScannedOpportunity[] = sliced.map((c, i) => ({
    rank: i + 1,
    setupId: c.setup.id,
    symbol: c.cell.symbol,
    timeframe: c.cell.timeframe,
    setupType: c.setup.type,
    direction: c.setup.direction,
    status: c.setup.status,
    score: c.score.score as number,
    scoreContributions: c.score.contributions,
    entry: c.plan?.entry,
    stopLoss: c.plan?.stopLoss,
    targets: c.plan?.targets,
    riskReward: c.plan?.riskReward,
    reasons: c.setup.reasons,
    statisticalEvidence: c.statisticalEvidence,
  }));

  const developingRefs: SetupRef[] = developing
    .map((c): SetupRef => ({
      setupId: c.setup.id,
      symbol: c.cell.symbol,
      timeframe: c.cell.timeframe,
      setupType: c.setup.type,
      direction: c.setup.direction,
      reasons: c.setup.reasons.filter((r) => !r.met), // "what's missing" — spec 11
      evaluatedAt: c.provenance.evaluatedAt,
    }))
    .sort((a, b) =>
      a.symbol.localeCompare(b.symbol) ||
      TF_ORDER[a.timeframe] - TF_ORDER[b.timeframe] ||
      a.setupId.localeCompare(b.setupId));

  const result: ScanResult = {
    asOf,
    universe,
    filters,
    ranked,
    developing: developingRefs,
    methodVersion,
    paramsVersion,
  };
  return {
    ok: true,
    data: result,
    errors: [],
    meta: meta({
      cellsEvaluated: universe.symbols.length * universe.timeframes.length,
      candidatesIn: candidates.length,
      ...excluded,
      filtered: filteredOut,
      duplicatesDropped: duplicateSetupIds.length,
      duplicateSetupIds: duplicateSetupIds.join(","),
      ranked: ranked.length,
      developing: developingRefs.length,
    }),
  };
}

/** Contract adapter (spec 20 `ScannerEngine`). */
export function createScannerEngine(): ScannerEngine {
  return { scan: (input) => scanUniverse(input) };
}
