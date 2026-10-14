# Spec 29 — Pipeline Composition

## Status

Composition phase. Wires the Spec 27 Market Regime Engine and Spec 28 Trade Plan Engine
producers into the existing `runBacktest` pipeline (`src/lib/engines/backtest.ts`) and the
causal `at(t)` join. This document specifies the wiring contract; the per-engine specs
(19/27 for regime, 16/28 for plans, 15 for scoring, 17 for outcomes, 25/26 for scan/backtest
records) remain the behavioral authorities.

## Purpose

The pipeline now composes **all** point-in-time producers at every evaluation bar:

- `at(t)` carries `regime` — `regimeStateAt(structure, momentum.features, config.regime)`
  computed on the same t-snapshots already in the join. It flows into
  `ScoringSnapshot.regime` via the `...at(t)` spread, so spec-15 `regimeMatrix`
  modulation activates only when configured.
- Every scored `ScanCandidate` carries `plan` — `planStateAt(setupAtT, scoreResult, t,
  config.lifecycle)` projected through `toScanPlan`. The scanner consumes it as a
  pass-through artifact (spec-25 `ScanPlan` fields).
- Outcome rows anchor `regime` at `confirmBar` and `scoreAtDetection` at `candidateBar` —
  the spec-17 caller-supplied fields, computed on the causal scoring path.

Nothing is recomputed: the regime label comes from the spec-27 producer, the plan from the
spec-28 producer, the scores from the spec-15 scorer. Composition, not new contracts.

## Scope

In scope: `toScanPlan` projection (`trade-plan.ts`), `at(t)` regime field, `ScanCandidate.plan`
population, `SetupOutcome.regime` / `SetupOutcome.scoreAtDetection` wiring.

Out of scope: statistical-evidence cohort wiring (`statisticalEvidence` remains unpopulated —
spec 30), MTF alignment slices, UI/services/persistence surfaces, any producer-contract change.

## Wiring Points

### 1. `toScanPlan(plan: TradePlan): ScanPlan` — `src/lib/engines/trade-plan.ts`

Canonical projection into the scanner's flat view:

| `ScanPlan` field | Source |
|---|---|
| `entry` | `(entryZone.low + entryZone.high) / 2` — zone midpoint; the same anchor `riskReward` is measured from |
| `stopLoss` | `invalidation.price` |
| `targets` | `plan.targets` pass-through (same reference; includes `reached` flags at `t`) |
| `riskReward` | `plan.riskReward` pass-through (absent stays absent) |

Pure projection — never recomputes, never mutates the `TradePlan`.

### 2. `at(t)` regime — `src/lib/engines/backtest.ts`

```ts
const at = (t: number) => {
  const structure = structureStateAt(..., t);
  const momentum  = momentumStateAt(..., t);
  return { structure, pools, zones, imbalances, momentum,
           regime: regimeStateAt(structure, momentum.features, config.regime),
           events: … };
};
```

- `momentum.features` may be `undefined` (early bars without ATR history) — `regimeStateAt`
  degrades to `"transition"` rather than throwing.
- `regime` propagates into `ScoringSnapshot.regime` through the existing `{ provenance:
  "at_bar", ...at(t) }` spread at every scoring call site — evaluation, confirmation, and
  detection anchors all observe the same regime the join produced at that bar.
- `ScoringSnapshot.regime` is optional; absent `regimeMatrix` (or `transition`/unconfigured
  regimes) leaves scoring byte-identical — the wiring is transparent.

### 3. `ScanCandidate.plan` — evaluation pass

```ts
if (SCOREABLE.has(st)) {
  const r = scoreOpportunity({ …snap: { provenance: "at_bar", ...at(t) }… });
  if (r.ok && r.data !== undefined) {
    score = r.data;
    const tp = planStateAt(setupAtT, r.data, t, config.lifecycle);
    if (tp !== undefined) plan = toScanPlan(tp);
  } else scoreFailures++;
}
candidates.push({ setup: setupAtT, score, plan, cell, provenance });
```

- `plan` is computed **only** on the scoreable path (`confirmed | active | partial_target`)
  and only when the score produced data — a gated or empty score degrades to absent, never
  fabricated (spec-28 contract).
- `scanUniverse` flattens `c.plan?.entry/stopLoss/targets/riskReward` onto
  `ScannedOpportunity`; `runBacktest` reassembles them into `BacktestPlan` — records
  therefore expose `plan` exactly when the causal evidence at `t` produced one.
- Developing and pre-confirmation evaluations carry no plan — boundary preserved.

### 4. `SetupOutcome.regime` + `scoreAtDetection` — outcome pass

```ts
const cb = num(s.metadata?.confirmBar);
const db = num(s.metadata?.candidateBar);
// …existing scoreAtConfirmation block at cb…
confirmedRegime = at(cb).regime;
// scoreAtDetection at candidateBar — same causal path / scoreable-status convention:
const r = scoreOpportunity({ setup: { ...s, status: "confirmed" }, atBar: db,
  snap: { provenance: "at_bar", ...at(db) }, config: config.scoring });
if (r.ok && r.data !== undefined) scoreAtDetection = r.data.score;
measureOutcome({ setup: s, candles, scoreAtConfirmation, scoreAtDetection,
                 contributions, regime: confirmedRegime, paramsVersion });
```

Temporal anchors are authoritative:

- **`regime`** — the join's regime at `confirmBar`, i.e. the regime under which the
  outcome is *measured* (spec-17 outcome context), not the detection or resolution bar.
- **`scoreAtDetection`** — the score on the causal path at `candidateBar`, when the setup
  first appeared. The `{...s, status: "confirmed"}` convention mirrors
  `scoreAtConfirmation`: spec-15's `developing → unconfirmed` gate is a scan-time
  eligibility gate, not an evidence measure — lifting it yields the honest
  evidence-quality score at detection. Evidence gates (`insufficient_data`, `rr_below_min`,
  …) still apply at `candidateBar` and degrade to absent.

Both follow the existing handling: non-ok/non-data results leave the field `undefined` —
no fallback scores are invented.

## Invariants

- **Causality** — every wired value derives from `at(t)`/`at(cb)`/`at(db)` joins or
  stamp-filtered artifacts (`stamp <= atIndex` inside `planStateAt`); no terminal artifact
  leaks into per-bar records. `targets[].reached` flags are per-bar: once reached, never
  reverted; never reached before the causal bar.
- **Transparency** — with `regimeMatrix: {}` the pipeline is byte-identical to pre-29
  behavior (the entire spec-26 suite passes unmodified).
- **Graceful degradation** — invalid `RegimeConfig` → `regimeStateAt` returns `"transition"`
  → no modulation, no failure; the run proceeds.
- **Determinism** — identical inputs produce identical `opportunities`/`developing`/
  `outcomes`, including all newly wired fields.
- **Deferred surfaces** — `statisticalEvidence` stays `undefined` on all records.

## Verification

`src/lib/engines/__tests__/composition.test.ts` — 17 additive tests over the real pipeline
(the spec-26 crafted series: bullish reversal develops 47 / confirms 49 / resolves in the
phase-D rally):

- `toScanPlan` projection (midpoint, stop, pass-through, no mutation).
- `plan` populated on every ranked record; absent before `confirmBar`.
- `reached`-flag monotonicity — per-bar evaluation, not terminal leakage.
- `regimeMatrix` + forced `high_volatility` modulates scores; absent matrix is a no-op;
  invalid regime config degrades to transition.
- `outcome.regime`/`scoreAtDetection` populated and prefix/full identical at anchors.
- Prefix (cut=50) vs full evaluation records identical — including `plan`.
- Determinism; `statisticalEvidence` untouched.

## Dependencies

| Dependency | Status |
|---|---|
| `regimeStateAt` (spec 27) | implemented |
| `planStateAt` / `TradePlan` (spec 28/16) | implemented |
| `ScoringSnapshot.regime`, `scoreOpportunity` gating (spec 15/19) | implemented |
| `ScanCandidate.plan`, `ScannedOpportunity` flatten, `BacktestPlan` (spec 25/26) | implemented |
| `SetupOutcome.regime`/`scoreAtDetection` params, `candidateBar`/`confirmBar` stamps (spec 17/11–14) | implemented |
| Statistical cohort evidence (spec 30+) | deferred |
