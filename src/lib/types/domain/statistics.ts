import type { Direction, Score, UnixMs } from "./common";
import type { RegimeLabel } from "./structure";
import type { SetupType } from "./setup";

/**
 * Spec 24 — Statistical validation & probability. The decision-time view of an opportunity:
 * every field is information knowable at the setup's `confirmBar` (the decision point).
 * The caller supplies it from the causal `at_bar` path — the engine never derives it.
 */
export interface StatisticalDecision {
  setupType: SetupType;
  direction: Direction;
  /** RegimeLabel (19) causally computed at `confirmBar` — absent means the regime axis is
   *  unconstrainable (absent-axis rule: levels requiring it are skipped). */
  regime?: RegimeLabel;
  /** Spec-15 score at confirmation — drives the scoreBand cohort axis. */
  scoreAtConfirmation: Score;
  /** `candles[confirmBar].time` — the prediction point τ for history gating. */
  decisionTime: UnixMs;
  /** Outcome-domain comparability version (E3) — rows measured under another version are ineligible. */
  paramsVersion: string;
}

/**
 * Empirical outcome-frequency estimate over a cohort (spec 24). Probabilities are raw
 * empirical frequencies in [0,1] — not scores, not calibrated, not mutually exclusive.
 */
export interface ProbabilityEstimate {
  /** Resolved cohort, grammar `st=…|dir=…|reg=…|sb=…` (present axes only, fixed order); `*` at L4. */
  cohortKey: string;
  /** Ladder level actually used — 0 = exact cohort, 4 = global. */
  cohortLevel: 0 | 1 | 2 | 3 | 4;
  /** Eligible observations in the selected cohort (the denominator). */
  sampleSize: number;
  /** Threshold probabilities P(targetsReached ≥ 1 | 2 | 3) — monotone non-increasing by
   *  construction; never forced to sum to 1. */
  pTarget: [number, number, number];
  /** P(stopReached) — coexists with pTarget entries (labels are not exclusive). */
  pStop: number;
  /** P(expired). */
  pExpired: number;
  /** Mean of `SetupOutcome.rMultiple` over the cohort — a statistical aggregate, not a
   *  probability and never a replacement for the row's own rMultiple (unactivated rows = 0). */
  expectancyR: number;
  /** Methodology stamp: estimator + eligibility rules + cohort axes + ladder order. */
  methodVersion: string;
  /** Versioned-parameter stamp: minSamples + scoreBands + outcome-domain version. */
  paramsVersion: string;
}
