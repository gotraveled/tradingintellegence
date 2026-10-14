# 35 — Outcome Feature-Vector Completion

> Status: **Draft** — closes the spec-17 `featureVector` breadth gap. Depends on 17
> (the row contract), 29 (the `at(cb)` join convention), 31/34 (frozen alignment at
> `confirmBar`).

## Purpose

Spec 17 declares the outcome row's ML schema: `featureVector` = flattened engine inputs
at `confirmedAt` — "every normalized feature the spec defines (swing params context,
zone strength components, displacement fᵢ, momentum features, MTF votes, regime, score
contributions)". The V1 implementation (`outcomes.ts`, phase 6) flattened only the
`score.*` class — a documented narrowing, never a named deferral.

Spec 35 completes the vector. Every input named by the schema is already computed at the
causal `confirmBar` join the outcome pass has always used (`at(cb)` supplies structure,
pools, zones, imbalances, momentum, regime — plus `alignment` on framed cells since
spec 31/34). This is composition-only: no producer, detector, scorer, or outcome
semantics change.

## Canonical feature inventory

Spec 17's enumeration reconciled against the contract-visible producers:

| Schema line | Emitted keys | Source at `confirmBar` |
| ----------- | ------------ | ---------------------- |
| swing params context | `swing.leftBars`, `swing.rightBars`, `swing.atrLength`, `swing.minSignificanceAtr`, `swing.equalToleranceAtr`, `swing.mergeEqual` | `EngineConfig.swing` — the versioned numeric params under which the row's swings were detected |
| zone strength components | `zone.strength`, `zone.remainingStrength`, `zone.retestCount`, `zone.penetrationDepthPct`, `zone.htfAligned` | anchor zone via `zoneIds[0]` → `metadata.zoneId` (scoring convention) resolved through `zoneStateAt(cb)` |
| displacement fᵢ | `disp.score` | `momentum.displacementScore` at cb |
| momentum features | `momentum.directionalMove`, `momentum.rateOfChange`, `momentum.atrTrend`, `momentum.bodyStrength`, `momentum.consecDirection`, `momentum.volumeRatio`, `momentum.rsi14` | `momentumStateAt(cb).features` |
| MTF votes | `mtf.votes.htf`, `mtf.votes.itf`, `mtf.votes.etf`, `mtf.score` | `at(cb).alignment` — framed cells only |
| regime | `regime.<label>` indicators over all six spec-19 labels | `regimeStateAt(cb)` — same value as the row's `regime` field |
| score contributions | `score.<dimension>`, `score.total` | existing V1 behavior, unchanged |

### Reconciliation decisions

- **"swing params context"** is read literally: the `SwingConfig` numerics in force.
  Runtime swing *state* is not a "params context"; config echo keeps the row
  self-describing for the paramsVersion comparisons spec-23 mandates.
- **"zone strength components"**: the zone `f_i` sub-scores (departure/base/freshness
  inputs to the spec-05 strength formula) are not surfaced on `Zone` — exposing them
  would require producer changes, which spec 35 forbids. The contract-visible zone
  numerics are emitted instead; this narrowing is recorded, not hidden.
- **"displacement fᵢ"**: same — `momentum.ts` exposes only the composite
  `displacementScore` (`disp.score`). The per-input `f_*` values are internal.
- **`regime` encoding**: `RegimeLabel` is an unordered categorical with no canonical
  ordinal. Indicator keys (`regime.trending_bullish` … `regime.transition`, all six
  emitted as 0/1 when the label is present) are the non-arbitrary numeric encoding —
  no invented ordering, no free-form strings in the numeric vector. Emitted only when
  `input.regime` is defined.
- **Excluded classes** — spec-17 does not name them: `structure.*` (trend/bias are
  categorical, no canonical ordinal — omitted rather than arbitrarily encoded),
  `liquidity.*`, `imbalance.*`, events, runtime swing counts. `SetupOutcome`'s typed
  fields (`direction`, `setupType`, `regime`) remain fields, not vector keys.
- `rsi14` is included: spec-09 earmarks secondary features "for display and later ML
  features" — the featureVector is exactly that consumer.

## Point-in-time / causality

- **Anchor:** `confirmBar` exclusively — the same anchor the row's `regime` and
  `scoreAtConfirmation` already use (spec-29 convention).
- Every key derives from the single `at(cb)` join inside the Phase-A outcome pass;
  nothing is recomputed, nothing post-confirmation is read. Terminal stamps
  (`resolvedBar`, target hits) never enter the vector — measurement output cannot
  feed its own features.
- The row is **frozen at construction** inside `measureOutcome`; no post-emit
  mutation is possible or permitted.

## Missing-data semantics

- **Unframed cell** → zero `mtf.*` keys (spec-34 parity rule — never 0, never
  "no_context").
- **Absent slice** (no anchor zone — breakout family; warm-up `MomentumFeatures`
  fields; gated score → no contributions) → the key is omitted. Absence is
  information; fabricating a neutral value would lie.
- **Framed but degraded** (a role's frame empty) → `mtf.*` still emitted with the
  producer's honest vote-0 — that IS the legal observation at cb.
- No `features` input (contract path, other callers) → the V1 score-only vector, or
  `undefined` when no contributions exist. Fully additive — every prior caller's
  output is unchanged.

## Data flow

```text
at(cb) join { structure, zones, momentum, regime, alignment? }
      + EngineConfig.swing + scoreOpportunity(cb).contributions
      ↓
OutcomeFeatureBundle { swing, zone, momentum, alignment }
      ↓
measureOutcome flattens → SetupOutcome.featureVector (frozen)
```

`runBacktest` resolves the anchor zone id via the spec-15 scoring convention
(`zoneIds[0]` → `metadata.zoneId`) against the cb-visible zone list; a zone no longer
visible at cb omits the class honestly.

## Files changed

- `src/lib/engines/outcomes.ts` — `OutcomeFeatureBundle` input + canonical
  flattening (`flattenFeatures`), `featureVector` now merges bundle keys with the
  existing `score.*` keys.
- `src/lib/engines/backtest.ts` — the Phase-A outcome pass hoists `at(cb)` once
  (scoring + regime + features share it) and passes the bundle.
- `src/lib/engines/__tests__/feature-vector-composition.test.ts` — additive suite.

No domain-type changes: `FeatureVector` stays `Record<string, number>`; the grammar
is documented here and pinned by tests.

## Tests

| ID | Requirement |
| -- | ----------- |
| A | canonical key set + grammar — every key is a named namespaced class; swing params echoed verbatim; zone/momentum/disp/score present |
| B | regime indicator encoding — exactly one hot label, consistent with the row's `regime` field |
| C | unit flattening — synthetic bundle → exact keys, exact values, exact key count; absent optional fields omit keys |
| D | framed run emits `mtf.votes.*` + `mtf.score` = 0.5·h + 0.3·i + 0.2·e |
| E | unframed run has zero `mtf.*` keys |
| F | confirmBar anchoring — truncated series: rows confirmed inside the shared region carry identical vectors |
| G | no outcome feedback — a different post-cb tail (different resolution) leaves the vector untouched |
| H | `mtf.*` cb-anchored — post-cb frame truncation cannot alter the keys |
| I | determinism — identical runs identical; cell permutation identical; per-cell vectors equal single-cell vectors |
| J | backward compatibility — `measureOutcome` without `features` preserves the V1 shape (`score.*` only / `undefined`) |

## Non-goals

MTF cohort axis (spec-24 extension — needs row-level axis values + consumer pull),
confidence intervals (`methodVersion`-bumped estimator extension), `regime.minBars`
hysteresis, `MarketRegimeSnapshot.strength`, `SetupOutcome.alignment`/`mtfState`
fields, `FrameSnapshot.events` → detector events routing, score weight calibration,
new scoring dimensions/detectors/MTF states, UI/service/persistence. Specs 27–34 are
not reopened — a missing feature class is not a defect in a closed spec.

## Baseline

800 tests pre-change; 811 after (+11 additive). `tsc --noEmit`, eslint, and
`next build` clean.
