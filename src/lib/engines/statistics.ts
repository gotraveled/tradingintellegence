/**
 * Phase 7 — Statistical validation & probability (docs/engine/24).
 *
 * Turns the Phase-6 `SetupOutcome` dataset into empirical outcome frequencies for a
 * decision-time view of an opportunity. Pure counting over rows — the engine never
 * re-measures outcomes, never touches candles, and never sees the requesting setup's own
 * lifecycle. Score ≠ probability (spec 15 reaffirmed): `scoreAtConfirmation` is only a
 * cohort axis; nothing here feeds back into scoring or detection.
 *
 * Causality contract (spec 24 §history window):
 * - Eligible history is **resolution-gated**: a row joins only when `resolvedAt < τ`
 *   (strict). Confirmed-but-unresolved peers contribute nothing — right-censoring by
 *   construction, the anti-look-ahead property.
 * - Cohort axes are the decision-time fields: setupType, direction, regime (spec-19 label at
 *   the observation's own confirmBar — the value Phase 6 stamps on the row), scoreBand.
 * - Everything else on the row (targetsReached, stopReached, expired, rMultiple) is outcome
 *   information — legitimate only because the row entered history after its own resolution.
 */
import type {
  ProbabilityEstimate,
  SetupOutcome,
  StatisticalDecision,
  StatsConfig,
} from "@/lib/types";
import type { EngineError, EngineResult, StatisticalValidationEngine } from "@/lib/services/engine";

/** Cohort ladder (spec 24): axes dropped regime → direction → setupType → scoreBand last. */
type Axis = "st" | "dir" | "reg" | "sb";
const LADDER: Axis[][] = [
  ["st", "dir", "reg", "sb"], // L0 exact
  ["st", "dir", "sb"],       // L1 drop regime
  ["st", "sb"],              // L2 drop direction
  ["sb"],                    // L3 keep score band only
  [],                        // L4 global
];

const ms = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

/** score → band index: count of edges the score clears, minus 1 (spec 24 worked example). */
const bandOf = (score: number, edges: number[]): number => {
  let i = -1;
  for (const e of edges) if (score >= e) i++;
  return i;
};

/** Band label per spec grammar: "low-(nextEdge-1)", top band "low-100". */
const bandLabel = (i: number, edges: number[]): string =>
  i < 0 ? "?" : `${edges[i]}-${i + 1 < edges.length ? edges[i + 1] - 1 : 100}`;

interface CohortValues { st: string; dir: string; reg?: string; sb: string }

const axisValues = (d: StatisticalDecision, edges: number[]): CohortValues => ({
  st: d.setupType,
  dir: d.direction,
  reg: d.regime,
  sb: bandLabel(bandOf(d.scoreAtConfirmation, edges), edges),
});

const rowValues = (r: SetupOutcome, edges: number[]): CohortValues => ({
  st: r.setupType,
  dir: r.direction,
  reg: r.regime,
  sb: bandLabel(bandOf(r.scoreAtConfirmation, edges), edges),
});

const cohortKey = (axes: Axis[], v: CohortValues): string =>
  axes.length === 0 ? "*" : axes.map((a) => `${a}=${v[a]}`).join("|");

/**
 * Estimate empirical outcome frequencies for one decision view over the outcome dataset.
 * Pure: identical (decision, outcomes, config) → identical estimate, always.
 */
export function estimateProbability(input: {
  decision: StatisticalDecision;
  outcomes: SetupOutcome[];
  config: StatsConfig;
}): EngineResult<ProbabilityEstimate> {
  const { decision, outcomes, config } = input;
  const edges = config.scoreBands;
  const methodVersion = config.methodVersion;
  /** paramsVersion = outcome-domain version + versioned stats params (spec 24 §versioning). */
  const paramsVersion = `${decision.paramsVersion}|ms${config.minSamples}|sb${edges.join("-")}`;

  const meta = (extra?: Record<string, string | number | boolean>) => ({
    stage: "statistics",
    paramsVersion,
    barsConsumed: { from: -1, to: -1 }, // consumes rows, not bars
    events: [],
    diagnostics: extra,
  });
  const fail = (code: EngineError["code"], message: string, diag?: Record<string, string | number | boolean>) =>
    ({ ok: false as const, errors: [{ code, message }], meta: meta(diag) });

  // ---- Config + input validation (spec 21: config bugs are loud). ----
  if (
    !(config.minSamples >= 1) ||
    edges.length === 0 || edges[0] !== 0 ||
    !edges.every((e, i) => e >= 0 && e <= 100 && (i === 0 || e > edges[i - 1])) ||
    !methodVersion
  ) {
    return fail("invalid_config",
      "stats config: minSamples ≥ 1, scoreBands ascending in [0,100] starting at 0, methodVersion required");
  }
  if (!(decision.scoreAtConfirmation >= 0 && decision.scoreAtConfirmation <= 100)) {
    return fail("invalid_input", "scoreAtConfirmation outside [0,100]");
  }

  const decisionV = axisValues(decision, edges);
  if (bandOf(decision.scoreAtConfirmation, edges) < 0) {
    return fail("invalid_input", "decision score has no scoreBand (below first edge)");
  }

  // ---- Eligibility E1–E4 (spec 24) — exclusions counted, never silent. ----
  const superseded = new Set(
    outcomes.map((r) => r.supersedes).filter((x): x is string => typeof x === "string"),
  );
  const excluded = { e1Unresolved: 0, e2NotYetResolved: 0, e3Version: 0, e4Superseded: 0 };
  const diag = (lv: number[]) => ({ ...excluded, eligiblePerLevel: lv.join(",") });
  const eligible: SetupOutcome[] = [];
  for (const r of outcomes) {
    if (r.unresolved === true) { excluded.e1Unresolved++; continue; }                    // E1
    const res = ms(r.resolvedAt);
    if (res === undefined || !(res < decision.decisionTime)) { excluded.e2NotYetResolved++; continue; } // E2 (strict)
    if (r.paramsVersion !== decision.paramsVersion) { excluded.e3Version++; continue; }  // E3
    if (superseded.has(r.setupId)) { excluded.e4Superseded++; continue; }                 // E4
    eligible.push(r);
  }

  // ---- Cohort selection: first level L0→L4 whose eligible count ≥ minSamples. ----
  const eligiblePerLevel: number[] = [];
  let chosen = -1;
  let cohort: SetupOutcome[] = [];
  for (let lv = 0; lv < LADDER.length; lv++) {
    const axes = LADDER[lv];
    if (axes.includes("reg") && decisionV.reg === undefined) { eligiblePerLevel.push(-1); continue; } // absent-axis
    cohort = eligible.filter((r) => {
      const v = rowValues(r, edges);
      return axes.every((a) => v[a] !== undefined && v[a] === decisionV[a]);
    });
    eligiblePerLevel.push(cohort.length);
    if (cohort.length >= config.minSamples) { chosen = lv; break; }
  }
  if (chosen < 0) {
    return fail("insufficient_data",
      `no cohort level reaches minSamples=${config.minSamples} (L4 eligible=${eligiblePerLevel[4] ?? 0})`,
      diag(eligiblePerLevel));
  }

  // ---- Raw empirical frequencies + expectancy (no smoothing — spec 24 V1). ----
  const n = cohort.length;
  const hit = (k: number) => cohort.filter((r) => r.targetsReached >= k).length;
  const pTarget: [number, number, number] = [hit(1) / n, hit(2) / n, hit(3) / n];
  const estimate: ProbabilityEstimate = {
    cohortKey: cohortKey(LADDER[chosen], decisionV),
    cohortLevel: chosen as ProbabilityEstimate["cohortLevel"],
    sampleSize: n,
    pTarget,
    pStop: cohort.filter((r) => r.stopReached).length / n,
    pExpired: cohort.filter((r) => r.expired).length / n,
    expectancyR: cohort.reduce((acc, r) => acc + (r.rMultiple ?? 0), 0) / n,
    methodVersion,
    paramsVersion,
  };
  return { ok: true, data: estimate, errors: [], meta: meta(diag(eligiblePerLevel)) };
}

/** Contract adapter (spec 20 `StatisticalValidationEngine`). */
export function createStatisticalValidationEngine(): StatisticalValidationEngine {
  return { estimate: (input) => estimateProbability(input) };
}
