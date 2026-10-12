# 24 — Statistical Validation & Probability

Every `SetupOutcome` row (17) is not only a label — it is a member of a comparable historical
population. This spec defines the layer that turns that population into **empirical probability
estimates**: given a decision-time view of an opportunity, how often did historically comparable
opportunities produce each defined outcome?

The estimates are **descriptive statistics over the Phase 6 dataset** — frequencies, not model
outputs, not scores, not calibrated confidences. They are the statistical foundation the dataset
exists for (17: "the entire reason the deterministic engine exists"), and the boundary before
any future ML/AI work.

```
CandleSeries → … → SetupDetection → OpportunityScoring → SetupOutcome (17)
                                                              ↓
                                          StatisticalValidationEngine (this spec)
                                                              ↓
                                          future ML / AI (not this spec)
```

## The core question

> Given an opportunity's decision-time evidence, what fraction of **eligible, resolved,
> historically comparable** opportunities produced each labelled outcome?

- Not "win probability", "success score", or "AI confidence" — the outputs are
  **empirical conditional frequencies** with an exact population, numerator, and denominator.
- **Score ≠ probability** (spec 15 is reaffirmed contractually): the Opportunity Score measures
  deterministic evidence quality; probability measures outcome frequency in a comparable
  population. `score = 80` never means `P = 0.80` unless a future calibration spec establishes
  that mapping. Whether score predicts outcome frequency is exactly what this layer measures —
  it must never assume it.

## Definitions

| Term                  | Meaning                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `decision point`      | The setup's **`confirmBar`** — the bar the setup becomes `confirmed`, when score/plan exist (15/16). |
| `decision time`       | `candles[confirmBar].time` — the wall-clock instant of the decision point.                          |
| observation           | One `SetupOutcome` row (keyed `setupId + confirmedAt`) — the statistical unit.                       |
| resolved observation  | A row whose setup reached a terminal state: `target_reached`, `invalidated`, `expired`, `cancelled`. |
| cohort                | The comparable population: resolved observations matching the decision's cohort key (below).         |
| label                 | A boolean outcome derived deterministically from `SetupOutcome` fields (below).                      |

**Why `confirmBar` is the decision point:** it is the first bar where the setup is scoreable and
a trade plan exists (specs 15/16 gate output to confirmed/active). `developing` predates the
score; `active` depends on the post-confirmation price path — both violate "known at decision
time". It is also where spec 17 anchors the observation window (`confirmBar + 1`), so feature
time, score time, and outcome time form one consistent causal seam.

## Labels (derived from `SetupOutcome` — Phase 6 is authoritative)

Labels are computed field-extracts, never re-measured; there is no second outcome engine.

| Label          | Definition on `SetupOutcome`                     | Semantics                                            |
| -------------- | ------------------------------------------------ | ---------------------------------------------------- |
| `hitTarget[k]` | `targetsReached >= k` for `k ∈ {1, 2, 3}`        | Threshold events — cumulative by construction.        |
| `stopped`      | `stopReached === true`                           | Invalidated at/through the stop (close-basis, 17).    |
| `expiredFlag`  | `expired === true`                               | Lifecycle expiry (terminal, unresolved direction).    |
| `cancelledFlag`| terminal state was `cancelled` (via stamps/diag) | Evidence basis died post-confirmation (11).           |
| `rMultiple`    | the row's `rMultiple`                            | Continuous outcome — feeds expectancy, not a label.   |

- `hitTarget[k]` are **threshold probabilities**: `P(T≥1) ≥ P(T≥2) ≥ P(T≥3)` holds
  mathematically; they must **not** be forced to sum to 1.
- Labels are **not mutually exclusive**: a setup may hit T1 then invalidate (`hitTarget[1]` ∧
  `stopped` both true — spec 11 allows `partial_target → invalidated`). `pStop + Σ pTarget` is
  not constrained to 1.
- `+1R/+2R/+3R` shorthand maps to `hitTarget[1..3]` — the lifecycle's ordered targets, not
  `rMultiple ≥ k` (a gapped exit can make `rMultiple ≥ 1` without a target touch, and T1 banking
  alone may yield `rMultiple < 1`; the targets are the stable referent).

## Sample eligibility

An observation contributes to a cohort denominator iff **all** hold:

| #  | Rule                                                                                          | Why                                                              |
| -- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| E1 | Resolved: terminal stamp present (`targetReachedBar`/`invalidatedBar`/`expiredBar`/`cancelledBar`); `meta.diagnostics.unresolved` false | Unresolved rows are right-censored — their future is unknown. Including them biases frequencies toward "nothing happened". |
| E2 | `resolvedAt < decisionTime` of the requesting opportunity (strict)                              | An outcome is only usable once it is actually known (§walk-forward). |
| E3 | Same `paramsVersion` comparability domain as the requesting pipeline                            | Specs 20/23: results are comparable only within a version.        |
| E4 | Row is not a superseded correction (`supersedes` chains resolve to the latest row only)         | Corrected rows must not double-count (17: corrections re-issue).  |

- **Unactivated rows are eligible** (expired/invalidated/cancelled without a fill): spec 17
  records them deliberately ("no survivorship filter — score quality without fills"). They
  contribute `hitTarget[k] = false`, `rMultiple = 0`, and `stopped` as stamped.
- **Cancelled rows are eligible** — `cancelled` is a terminal lifecycle state with defined
  semantics (11), observable as a genuine outcome class.
- **Developing-never-confirmed setups produce no row** (17) and can never be observations.
- Exclusions are **listed, not silent**: every eligible set reports which rule removed what
  (diagnostics counters per E-rule).

## Cohorts — comparability

The cohort key is `(setupType, direction, regime, scoreBand)` — the axes that change the
population's mechanics (setup type + direction) and its conditions (regime, 19) plus the
score-conditioning this layer exists to measure (15).

- `scoreBand` derives from `scoreAtConfirmation` via `StatsConfig.scoreBands` — ascending edges
  in `[0, 100]`; a row's band is the first edge its score is `>=` (top edge inclusive). The
  shipped default is `[0, 50, 70, 85]` → bands `[0–49, 50–69, 70–84, 85–100]`. It is a named,
  versioned parameter (21) — a **contested-definition knob** (23), not a magic constant; the
  empirical claim "score predicts outcome" is what the bands test, so edges must be declared,
  not tuned silently.
- **`regime` is the decision-time regime** — the `RegimeLabel` causally computed by the
  `MarketRegimeEngine` at the opportunity's `confirmBar` (specs 19 + 18's per-bar state). It is
  the same snapshot Phase 5's `at_bar` scoring consumes and the same value Phase 6 stamps as
  `SetupOutcome.regime` — never the regime at target/invalidation/resolution, never an
  end-of-series value, never recomputed with future bars. Observations join cohorts by their
  own decision-time regime; the decision's axis likewise comes from its own `confirmBar`.

### Fallback ladder (deterministic, fixed order)

An axis membership table — `✓` constrains the axis, `—` drops it. Axes are dropped in exactly
this order: `regime` first, then `direction`, then `setupType`, then `scoreBand` — the score
axis is kept longest because score-conditioning is the question this layer exists to answer.

| Level | setupType | direction | regime | scoreBand |
| ----- | --------- | --------- | ------ | --------- |
| L0    | ✓         | ✓         | ✓      | ✓         |
| L1    | ✓         | ✓         | —      | ✓         |
| L2    | ✓         | —         | —      | ✓         |
| L3    | —         | —         | —      | ✓         |
| L4    | —         | —         | —      | —         |

- **Selection rule:** when estimating an opportunity, select the **first** level (L0 → L4 in
  order) whose eligible observation count satisfies `minSamples`. No judgment, no search.
- **Absent-axis rule:** if the decision or an observation lacks a value for a constrained axis
  (e.g. `regime` absent — `SetupOutcome.regime` is optional), that axis cannot be matched —
  the row/decision skips every level containing it. A regime-less decision therefore starts
  effectively at L1; a regime-less observation only joins levels `≥ L1`.
- **`cohortKey` grammar** (deterministic, parseable): present axes rendered in fixed order
  `st=<type>|dir=<direction>|reg=<regime>|sb=<scoreBand>`, e.g. L0 →
  `st=reversal|dir=bullish|reg=trending_bullish|sb=70-84`; L2 → `st=reversal|sb=70-84`;
  L4 → `*`.
- Fallback is **one-way down the ladder** — never sideways, never re-merge.
- The estimate always reports `cohortLevel` + `cohortKey` so a coarse estimate can never
  masquerade as a specific one.
- L4 below `minSamples` → `insufficient_data`; no probability is fabricated.

## History window — expanding, resolution-gated (walk-forward safe)

V1 uses an **expanding window**: at decision time `τ`, the eligible history is every resolved
observation with `resolvedAt < τ`.

```
eligible history(τ) = { rows : resolved(row) ∧ resolvedAt(row) < τ }
```

- **Why expanding:** deterministic, monotone, no window-length parameter to tune or overfit;
  rolling/fixed-lookback windows discard data and add a tunable `N` the spec has no basis to
  choose yet. If regime drift later makes old observations misleading, a `window` parameter is
  a documented contested-definition change (23), not a silent constant.
- **Resolution-gated, not confirmation-gated:** an observation enters history when its outcome
  is *known* (`resolvedAt`), not when it was decided (`confirmedAt`).
- **Right-censoring consequence (intentional, kept on purpose):** an opportunity confirmed
  *before* the prediction point is still unavailable to history while its outcome is open.
  Example — Setup A confirmed Jan 10, resolves Jan 25; at a Jan 20 decision A contributes
  **nothing** (`resolvedAt = Jan 25 ≮ Jan 20`), even though its confirmation predates the
  decision. The historical label stream is therefore delayed/right-censored by construction.
  This is the anti-look-ahead property, not a bug: V1 must not substitute `confirmedAt < τ`,
  must not admit unresolved outcomes, and adds **no** survival-analysis/censoring correction —
  any such change is a future `methodVersion` decision (23).
- Strictly `< τ`: an outcome resolving at the same instant as the decision is excluded — at
  decision time its resolution could not yet be acted on.

## Estimator

**Raw empirical frequency** (V1 — auditable, explainable, no parameters):

```
P(label | cohort, τ) = |{ eligible rows in cohort with label true }|
                       / |{ eligible rows in cohort }|
```

- No smoothing in V1. Laplace/Beta/Wilson adjustments change estimates on small samples exactly
  where honesty matters most; if adopted they arrive as a `methodVersion` bump (23), never a
  silent tweak.
- **`expectancyR` — exact definition:**

  ```
  expectancyR = ( Σ over the N eligible cohort rows of row.rMultiple ) / N
  ```

  where `N = sampleSize` of the *selected* cohort. `SetupOutcome.rMultiple` remains the
  authoritative Phase 6 value — `expectancyR` is a read-only statistical aggregate of it, not
  a new outcome field, never written back, and never a substitute for `rMultiple` on the row.
  It is a companion statistic, not a probability; opportunity-level, so unactivated rows
  legitimately count as `0` (17's own convention).
- **Uncertainty is surfaced via `sampleSize` + `cohortLevel`, not a fabricated interval.** No
  confidence-interval method is specified for V1 — deferred deliberately; consumers must not
  treat a small-sample estimate as precise. (A future spec may add Wilson/Beta intervals under
  a new `methodVersion`.)
- `minSamples` (default `30`, versioned config): an explicit *policy floor*, not a statistical
  claim — below it the estimate is withheld as `insufficient_data` rather than emitted with a
  caveat. `30` is the documented V1 choice: large enough that raw frequencies are not single-row
  noise, small enough that the narrowest L0 cohorts can still resolve on real datasets.

## Engine contract (sketch — spec 20 shape)

```ts
interface StatisticalValidationEngine {
  /** Estimate decision-time outcome frequencies from the resolved outcome history. */
  estimate(input: {
    /** The decision view: what was knowable at confirmBar. */
    decision: {
      setupType: SetupType;
      direction: Direction;
      regime?: RegimeLabel;                 // regime at confirmBar (19)
      scoreAtConfirmation: number;          // spec 15 score at the decision point
      decisionTime: UnixMs;                 // candles[confirmBar].time
      paramsVersion: string;                // outcome-row comparability domain (E3)
    };
    /** The Phase 6 dataset — authoritative rows only; the engine never re-measures. */
    outcomes: SetupOutcome[];
    config: StatsConfig;
  }): EngineResult<ProbabilityEstimate>;
}

interface ProbabilityEstimate {
  cohortKey: string;                        // resolved cohort, e.g. "st=reversal|dir=bullish|reg=trending_bullish|sb=70-84"
  cohortLevel: 0 | 1 | 2 | 3 | 4;           // ladder level actually used — honesty marker
  sampleSize: number;                       // eligible observations in the cohort
  /** Empirical frequencies, [0,1] — threshold labels, not mutually exclusive, never forced to 1. */
  pTarget: [number, number, number];        // P(targetsReached ≥ 1 | 2 | 3)
  pStop: number;                            // P(stopReached)
  pExpired: number;                         // P(expired)
  expectancyR: number;                      // mean rMultiple over the cohort
  methodVersion: string;                    // estimator + eligibility + ladder version
  paramsVersion: string;                    // the domain the estimate was computed in
}

interface StatsConfig {
  minSamples: number;                       // eligibility floor per cohort level (default 30)
  scoreBands: number[];                     // ascending edges in [0,100] (default [0,50,70,85])
  methodVersion: string;                    // e.g. "v1-empirical"
}
```

- Below `minSamples` at every level → `ok: false`, `insufficient_data`, `data` absent — never a
  zero-sample `0` or a fabricated value.
- `meta.diagnostics` reports per-level eligible counts (the fallback path is auditable) and
  per-E-rule exclusion counters.
- Probabilities live in `[0, 1]` — percentages are a presentation-layer transform only.

## Look-ahead rules (extends spec 18)

- **Features:** the decision view contains only what specs 11–17 stamp by `confirmBar` —
  `setupType`, `direction`, `regime(at confirmBar)`, `scoreAtConfirmation`. No outcome field of
  the requesting setup may ever enter its own cohort: its `resolvedAt ≥ confirmTime` excludes it
  by E2 automatically.
- **History:** observations contribute only after `resolvedAt` — future outcomes cannot alter
  earlier estimates.
- **Row fields are whole-record:** a row's labels derive from its full lifecycle — that is
  legitimate *because the row only joins history after its own resolution*. The leak would be
  letting an unresolved row in; E1 forbids it.
- **Forbidden as features:** final lifecycle state, target results, invalidation state, final
  zone/pool/FVG/momentum/MTF values, end-of-series anything — spec 18's rules apply unchanged;
  the only new temporal rule is the `resolvedAt < τ` gate.

## Determinism & versioning

- Same `{outcomes, decision, config}` → identical `ProbabilityEstimate`. No clocks, no
  randomness, no I/O — the estimator is `O(n)` counting over rows in input order.
- **`methodVersion`** — methodology: the estimator (raw frequency), the eligibility rules
  E1–E4, the cohort axis set, and the ladder order. Any change to *how* an estimate is derived
  bumps it (e.g. `v1-empirical`).
- **`paramsVersion`** — versioned parameter values (spec 21): `StatsConfig.minSamples`,
  `StatsConfig.scoreBands`, plus the outcome-domain version the rows were measured in
  (E3's comparability domain). A threshold change re-cohorts/re-floors every estimate — a
  params bump, deliberately.
- Estimates are comparable only within `(methodVersion, paramsVersion)` — same rule as every
  other engine output (20).

## Worked example

Decision: `reversal | bullish | trending_bullish | score 78` at `τ` — all four decision fields
taken **at the setup's own `confirmBar`** (regime = the spec-19 label causally computed there;
score = the spec-15 `at_bar` score there). `minSamples = 4` (fixture scale — shipped default 30).
Outcome rows known before `τ`; L0 cohort key `st=reversal|dir=bullish|reg=trending_bullish|sb=70-84`:

| row | resolvedAt | regime     | targetsReached | stopReached | expired | rMultiple | status                     |
| --- | ---------- | ---------- | -------------- | ----------- | ------- | --------- | -------------------------- |
| A   | τ−9h       | trending_b | 3              | false       | false   | +1.00     | eligible                   |
| B   | τ−7h       | trending_b | 1              | true        | false   | −0.78     | eligible                   |
| C   | τ−5h       | trending_b | 0              | true        | false   | −1.00     | eligible                   |
| D   | τ−3h       | trending_b | 0              | false       | true    | 0.00      | eligible                   |
| E   | τ−1h       | trending_b | 0              | false       | false   | 0.00      | eligible (cancelled)       |
| F   | τ−2h       | trending_b | —              | —           | —       | —         | excluded — unresolved (E1) |
| G   | τ−4h       | ranging    | 2              | false       | false   | +0.44     | excluded — cohort (regime) |
| H   | τ+6h       | trending_b | 3              | false       | false   | +1.00     | excluded — resolved AFTER τ (E2: right-censored even though confirmed long before τ) |

- L0 eligible = {A,B,C,D,E}, n=5 ≥ 4 → estimate at L0.
  `cohortKey = "st=reversal|dir=bullish|reg=trending_bullish|sb=70-84"`, `cohortLevel = 0`.
- `pTarget = [2/5, 1/5, 1/5] = [0.40, 0.20, 0.20]` (A,B hit ≥1; A hits ≥2,≥3) — monotone ✓
- `pStop = 2/5 = 0.40` (B,C) — coexists with pTarget[1] (B hit T1 then stopped: not exclusive)
- `pExpired = 1/5 = 0.20` (D)
- `expectancyR = (1.00 − 0.78 − 1.00 + 0.00 + 0.00)/5 = −0.156`
- H demonstrates the resolution gate: its setup *confirmed* before τ and eventually reached all
  targets — but at τ that future was unknowable, so it cannot lift the estimate.
- If n had been 3 < 4: drop `regime` → L1 `st=reversal|dir=bullish|sb=70-84` picks up G → n=6,
  `cohortLevel = 1` reported.
- Score 78 stays a score; `pTarget[1] = 0.40` is a frequency — the two are reported side by side
  and never merged.

## Test requirements (implementation contract — extends spec 22)

- **Math:** every probability ∈ [0,1]; `pTarget` monotone non-increasing; denominators exact;
  `expectancyR` = pinned arithmetic mean.
- **Causality:** a row added with `resolvedAt ≥ τ` never changes the estimate at `τ`; prefix-vs-
  full dataset replay gives identical estimates for every decision before the cut.
- **Determinism:** identical inputs → bit-identical output; row input order permuted → identical
  output (no order dependence).
- **Eligibility:** unresolved/cancelled/superseded rows handled exactly per E1–E4; exclusion
  counters correct; zero-eligible → `insufficient_data`.
- **Boundaries:** n = minSamples−1 → insufficient at that level, fallback resolves correctly;
  n = minSamples → emitted; all-success / all-failure / mixed cohorts pin exact fractions.
- **Independence:** the Opportunity Score is never mutated by estimation; nothing in this layer
  feeds back into detection or scoring.

## Implementation notes (Phase 7)

- **Entry points.** `estimateProbability({decision, outcomes, config})` is the pure function in
  `src/lib/engines/statistics.ts`; `createStatisticalValidationEngine()` is the spec-20 contract
  adapter. O(n) counting, input-order independent.
- **Upstream addition (additive only):** `SetupOutcome.unresolved?: boolean` — E1 needs a
  resolved/unresolved marker on the row itself: `resolvedAt` is emitted for unresolved rows too
  (last window close), and cancelled rows carry no flag of their own. `unresolved === true`
  marks the right-censored rows; absent/false = resolved. Set inside `measureOutcome`; no
  Phase-6 field changed semantics.
- **E4 basis (spec 17, reconciled):** rows are append-only — "corrections create new rows with
  `supersedes` links" (17); the field is typed `ID` and "links to the row it replaces", i.e. the
  superseded row's `setupId`. E4's "chains resolve to the latest row only" is implemented as:
  exclude every row whose `setupId` is referenced by another row's `supersedes` — in a chain
  a→b→c, a and b drop, c (latest) remains. Spec 17 does not forbid forked corrections (two rows
  superseding one setupId); both referrers would remain — there is no ordering information in
  the row to pick a winner, and inventing one is out of scope.
- **E3 basis (specs 17/24, reconciled):** `SetupOutcome.paramsVersion` is the *outcome-generation*
  domain — the parameter set the row was measured under (17: "outcomes are only comparable
  within a version"). E3 compares it against `decision.paramsVersion` — the requesting
  pipeline's generation domain — and nothing else. `StatsConfig.minSamples`/`scoreBands` are
  *estimation* parameters, not generation parameters: they never enter eligibility; they only
  stamp the estimate's composite `paramsVersion` (§versioning) so estimates across a stats-param
  bump are not compared. Changing `minSamples` 30→50 re-cohorts/re-floors every estimate and
  bumps the stamp, but every historical row remains exactly as eligible as before.
- **`paramsVersion` stamp** is the composite `decision.paramsVersion | ms<minSamples> | sb<edges>`
  so the outcome-domain version and the versioned stats values are both pinned on the estimate
  and on `meta.paramsVersion`.
- **`barsConsumed`** is `{-1,-1}` — the engine consumes rows, not bars; the diagnostic still
  reports per-E-rule exclusion counters and per-level eligible counts (audit trail for the
  ladder path actually taken).
- **Absent-axis detail:** a level containing `reg` is skipped entirely when the decision lacks
  a regime (`eligiblePerLevel` records `-1`); a row lacking a constrained axis value simply
  never matches that level. Levels past the selected one are not evaluated — the diagnostics
  string lists only evaluated levels.
- **scoreBand edges** must start at 0 and be strictly ascending within [0,100] — `invalid_config`
  otherwise (banding is total over the score domain by construction). Band index = count of
  edges `<=` score, minus 1; labels follow the spec's `low-(nextEdge−1)` grammar.
- **`expectancyR`** sums `rMultiple ?? 0` — rows legitimately missing the field count as 0,
  matching spec 17's unactivated-row convention.
- **Not implemented (spec non-goals):** smoothing, confidence intervals, rolling/decay windows,
  calibration, ML, persistence, live data, execution, UI.

## Explicit non-goals

This spec does **not** implement or design: ML/AI models of any kind, probability calibration
(Platt/isotonic/reliability), confidence intervals (deferred, see estimator), persistence or
warehouse schema for estimates, live data, broker/execution/paper trading, portfolio logic, UI
or alerts, and any feedback of probabilities into scoring or detection. The dataset this layer
validates is the same one future phases consume — it stays clean because this layer only reads
it.
