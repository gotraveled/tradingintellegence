# Spec 30 — Statistical Evidence Composition

## 1. Purpose

Composition phase — same class as Spec 29. Wires the already-implemented Spec-24 producer
(`estimateProbability`, `src/lib/engines/statistics.ts`) into `runBacktest` so that scoreable
`ScanCandidate`s and the `BacktestOpportunity` records they produce carry
`statisticalEvidence` — the empirical outcome-frequency estimate over the spec-24 cohort.

No new engine contract, no estimator change, no outcome/scoring/regime/plan recomputation.

## 2. Canonical source / spec references

| Source | Role |
|---|---|
| `docs/engine/24-statistical-validation.md` | **Canonical behavioral spec** — labels, eligibility E1–E4, cohort axes + L0–L4 ladder, expanding resolution-gated history, raw-frequency estimator, `insufficient_data` semantics, determinism/versioning |
| `docs/engine/17-outcomes.md` | `SetupOutcome` rows are the dataset; `scoreAtDetection`/`scoreAtConfirmation`/`regime` are caller-supplied at `candidateBar`/`confirmBar` |
| `docs/engine/25-scanner-opportunity-discovery.md` | `ScanCandidate.statisticalEvidence` is caller-produced pass-through; `decisionTime > asOf` → strip evidence only (`excluded.futureEvidence`); evidence never reorders ranking |
| `docs/engine/26-system-backtesting.md` | Records frozen at emit — `statisticalEvidence` is listed among the frozen fields; `outcomeRef` is the ONLY post-emit field |
| `docs/engine/29-pipeline-composition.md` | `at(t).regime` join; outcome `regime`@`confirmBar`, `scoreAtDetection`@`candidateBar` anchors |
| `docs/engine/19-regime.md` + `27-market-regime-engine.md` | `RegimeLabel` — the `reg` cohort axis source |
| `docs/engine/15` (scoring) | `scoreAtConfirmation` — the `sb` (scoreBand) axis source; score ≠ probability reaffirmed |

No pre-existing Spec-30 document or stub exists. Specs 1–29 are all drafted in
`docs/engine/`; this document is the Spec-30 definition.

## 3. Existing implementation audit

**Already shipped and unit-tested** — nothing below changes:

- `src/lib/engines/statistics.ts` — `estimateProbability({decision, outcomes, config})` fully
  implements spec 24: config/input validation (`invalid_config`, `invalid_input`), E1–E4
  eligibility with per-rule exclusion counters, L0→L4 cohort ladder with absent-axis skip,
  raw frequencies (`pTarget` monotone by construction, `pStop`, `pExpired`, `expectancyR`),
  composite `paramsVersion` (`<domain>|ms<n>|sb<edges>`), `insufficient_data` when L4 <
  `minSamples`. `createStatisticalValidationEngine()` adapts it to the spec-20 contract
  (`StatisticalValidationEngine.estimate` in `src/lib/services/engine.ts` — registered).
- `src/lib/engines/__tests__/statistics.test.ts` — 34+ tests covering the ladder, label math,
  E1–E4, prefix/full dataset causality, determinism/order-independence, versioning, invalid
  config/input.
- Domain types (`src/lib/types/domain/statistics.ts`): `StatisticalDecision`, `ProbabilityEstimate`.
- Carrier types (`src/lib/types/domain/scanner.ts`): `StatisticalEvidence =
  { decisionTime; estimate?; unavailable?: "insufficient_data" }`; `ScanCandidate.statisticalEvidence`;
  `ScannedOpportunity.statisticalEvidence`.
- `BacktestOpportunity.statisticalEvidence` (`backtest-system.ts`) — *"Caller-attached, passes
  through verbatim; `decisionTime <= evaluatedAt` enforced."*
- `scanUniverse` (`scanner.ts`): strips evidence with `decisionTime > asOf` (candidate kept),
  emits `statisticalEvidence: c.statisticalEvidence` verbatim onto ranked records.
- `runBacktest` record construction already maps `statisticalEvidence: o.statisticalEvidence`
  onto `BacktestOpportunity` — the entire downstream path exists.
- `SetupOutcome` carries every field the estimator reads: `setupType`, `direction`, `regime`
  (spec-29 wired, `confirmBar` anchor), `scoreAtConfirmation`, `resolvedAt`, `unresolved`,
  `supersedes`, `paramsVersion`, `targetsReached`, `stopReached`, `expired`, `rMultiple`.
- `EngineConfig.stats` (`StatsConfig`) already exists; `config.version` (`pv`) is already
  threaded into `measureOutcome` — matching `decision.paramsVersion`.

**Missing**: `runBacktest` never calls `estimateProbability`; `ScanCandidate.statisticalEvidence`
is never populated anywhere.

## 4. Current pipeline insertion point

Post-29 flow per cell: upstream `*StateAt` + `at(t)` join → detection (3 families) →
evaluation pass `[t0..t1]` → scan per bar → frozen records → outcome pass (Model B) →
aggregation.

**Evidence is not an evaluation-time compute — it is a per-setup decision-time fact.** The
authoritative temporal anchor is `confirmBar`: `StatisticalDecision.decisionTime =
candles[confirmBar].time`, `regime`/`scoreAtConfirmation` are the spec-29 outcome-pass
anchors at `confirmBar`. The estimate never changes across a setup's scoreable lifetime —
computed once per confirmed setup, memoized, attached verbatim to every scoreable candidate
(`t ≥ confirmBar`).

**Insertion = eval pass, on the candidate**:

```ts
candidates.push({ setup: setupAtT, score, plan,
  statisticalEvidence: evidenceFor(s),   // spec 30
  cell, provenance });
```

`evidenceFor` reads a per-`setupId` memoized `StatisticalEvidence` built once — either
`{ decisionTime, estimate }` or `{ decisionTime, unavailable: "insufficient_data" }`.
`decisionTime = candles[cb].time ≤ evaluatedAt` for every scoreable candidate, so the
scanner's strip rule can never fire — the check is preserved as a safety net, not relied on.

## 5. Contracts and data flow

```
outcome pass (per setup s, confirmed):
  cb = confirmBar; dec = { setupType: s.type, direction: s.direction,
        regime: row.regime /* = at(cb).regime — same value Phase 6 stamps */,
        scoreAtConfirmation: row.scoreAtConfirmation /* = at(cb) causal score */,
        decisionTime: candles[cb].time, paramsVersion: pv }

evaluation pass (per scoreable candidate):
  statisticalEvidence = memo(setupId) ??=
    dec === undefined ? undefined                     // no decision view → absent
    : ({ decisionTime: dec.decisionTime, ...(estimate-or-unavailable) })
      where estimate = estimateProbability({ decision: dec, outcomes: GLOBAL outcomes[], config.stats })

ScanCandidate → scanUniverse (passthrough + futureEvidence strip)
  → ScannedOpportunity → BacktestOpportunity.statisticalEvidence (frozen at emit)
```

- Evidence attaches only to scoreable candidates (`confirmed|active|partial_target`,
  `t ≥ confirmBar`). Developing candidates/`SetupRef`/`BacktestDeveloping` have no such
  field — spec-25 "developing: never scored, never given probabilities".
- `decision.regime`/`scoreAtConfirmation` are sourced from the outcome row / outcome-pass
  computation at `confirmBar` — identical anchors spec-29 already established; nothing is
  recomputed.
- Aggregation is untouched — evidence is informational, never counted, never ranks.

## 6. Cohort / evidence semantics

Delegated entirely to `estimateProbability` (spec 24 §cohorts): axes
`setupType|direction|regime|scoreBand`, deterministic L0→L4 fallback (drop regime →
direction → setupType → scoreBand), `minSamples` floor, `insufficient_data` below L4.
The composition layer supplies `decision` + `outcomes[]` + `config.stats` verbatim — it
invents no cohort key and no axis.

## 7. Temporal / PIT model

| Timestamp | Represents | Leak risk |
|---|---|---|
| `candidateBar` (`db`) | detection anchor — `scoreAtDetection` only (spec 29; not evidence) | none — stamped |
| `confirmBar` (`cb`) | **the decision point τ**: `decisionTime`, `regime`, `scoreAtConfirmation` | none — stamped + join at `cb` |
| `resolvedAt` (per row) | E2 history gate: `resolvedAt < τ` strictly | **impossible** — a row resolving at/after τ is excluded; future bars cannot enter the cohort |
| `evaluatedAt` (`asOf`) | scan anchor; evidence `decisionTime ≤ asOf` enforced by scanner | none — `decisionTime = candles[cb].time` and scoreable ⟹ `cb ≤ t` |
| eval bar `t` | NOT an evidence anchor — evidence is identical ∀ t ≥ cb | none |

**Contamination analysis:**
- *Self-inclusion*: the requesting setup's own row has `resolvedAt ≥ τ` → E2 auto-excludes.
- *Peer censoring*: rows confirmed before τ but unresolved at τ contribute nothing (E2).
- *Unresolved rows*: E1 (`unresolved === true`) excludes; `resolvedAt` on unresolved rows is
  the last-window close — emitted but unreachable through E1.
- *Version drift*: E3 requires `row.paramsVersion === pv`.
- *Corrections*: E4 drops superseded `setupId`s.
- *Frozen records*: `statisticalEvidence` must exist at emit time (spec-26 freeze rule).

## 8. Error / degradation semantics

| Condition | Canonical behavior (statistics.ts) | Composition handling |
|---|---|---|
| L4 cohort < `minSamples` | `insufficient_data`, `data` absent | `evidence = { decisionTime, unavailable: "insufficient_data" }` — the `StatisticalEvidence` type encodes exactly this |
| Invalid `StatsConfig` | `invalid_config` (loud) | counted in run diagnostics (`statsFailures`-style counter), evidence absent — same convention as `scoreFailures`/`evaluationsSkipped`; never throws |
| `scoreAtConfirmation` out of `[0,100]` / no band | `invalid_input` | evidence absent + diagnostic count — never mapped to `unavailable` (that value is reserved for insufficient sample) |
| Confirmed but gated score at `confirmBar` (no `scoreAtConfirmation`) | — | no decision view constructible → evidence absent; honest gap, no fabricated score |
| Never-confirmed setup | spec-17 produces no row | no decision point; no evidence possible (also never scoreable → never ranked) |

Zero-success / 100%-success cohorts are **not errors** — raw frequencies (`pStop=0`/`pTarget=[1,1,1]`)
are valid estimates. No confidence intervals in V1 (spec 24 defers them deliberately;
uncertainty is `sampleSize` + `cohortLevel`).

## 9. Regime boundary

`regime` **is** a canonical cohort axis (spec 24 §cohorts — `reg`, dropped first in the
ladder). The decision's regime is `at(confirmBar).regime` — the spec-27 producer over the
spec-29 join, identical to what `SetupOutcome.regime` stamps. The absent-axis rule (decision
or row missing `regime` → levels containing `reg` skipped) handles `undefined` — no
fabrication. This is **not** eval-time regime: `at(t).regime` at `t > cb` is never consulted.

## 10. MTF boundary

MTF is **not** a spec-24 cohort axis (`st|dir|reg|sb` only) and is named under spec 24's
"forbidden as features" (final values). Spec 30 does not consume MTF alignment; it remains
deferred to a later spec. No MTF wiring.

## 11. Reconciliation decisions

- **R1 — outcome measurement is hoisted ahead of the evaluation pass (two-phase
  restructure).** Spec 26 freezes records at emit *including* `statisticalEvidence`, so the
  estimate must exist when the candidate is constructed; the estimate needs resolved-outcome
  history; Model B measures outcomes over the full series. Since E2 eligibility keys on
  `resolvedAt < τ` — not on when measurement ran — hoisting measurement changes **no
  observable output**: emitted rows, `outcomeRef` stamps, and the `existsAt(endIndex)`
  observed-gating are all window-anchored, not order-anchored. Spec-26's "outcome pass runs
  strictly after evaluation" constrains *semantics* (post-window measurement, never feeds
  records); the restructure preserves every semantic while satisfying the freeze rule.
  - Phase A (per cell): upstream + detection + `observedSetupIds`/`measuredSetupById` +
    outcome pass → `outcomes[]` (global, appended per cell) + per-setup decision views.
  - Phase B (per cell): the existing eval pass unchanged + `statisticalEvidence` on
    candidates.
- **R2 — global outcome dataset.** `outcomes[]` spans all cells for every estimate: spec-24
  history/E3 are symbol/timeframe-agnostic, and spec-26's cell-order determinism requires
  each estimate to see the complete history.
- **R3 — decision fields sourced from the outcome pass.** `regime`/`scoreAtConfirmation`/
  `decisionTime` are the same `at(cb)` values already computed there; no second scoring call.
- **R4 — `invalid_config` degrades to diagnostics-count, not run failure.** Consistent with
  `scoreFailures`/`evaluationsSkipped`; engine-level `invalid_config` stays loud in the
  error detail.
- **R5 — unchanged spec-29 anchors**: eval-time `regime` at `t`, `scoreAtDetection` at
  `candidateBar`, outcome `regime` at `confirmBar`, plan from setup+score at `t`, Model B,
  frozen records, honest degradation.

## 12. Implementation plan

`src/lib/engines/backtest.ts` only:

1. Restructure per-cell body into two phases (§R1): extract `observedSetupIds`/
   `measuredSetupById`/outcome-pass block into phase A; keep eval loop as phase B reading
   cell-local closure state (candles, setups, `at`, `transById`, `existsAt`, `statusAt`,
   `t0`, `t1`, `pv`, …). Requires holding per-cell context across phases (small struct/map).
2. In the outcome pass, per confirmed setup collect `StatisticalDecision` into
   `decisionById` (fields per §5).
3. Lazy memo `evidenceById`: on first scoreable candidate of a confirmed setup, call
   `estimateProbability({decision, outcomes, config: config.stats})`; map
   `insufficient_data` → `unavailable`; other non-ok → absent + `statsFailures` diagnostic.
4. Attach `statisticalEvidence: evidenceById.get(s.id)` in `candidates.push`.
5. `statsFailures` counter → `meta.diagnostics` (additive).

## 13. Test plan (additive only — `statistics.test.ts` already covers the estimator)

New `__tests__/statistical-evidence.test.ts` over the real pipeline:

- **Anchor**: every record carrying evidence has `decisionTime === candles[confirmBar].time`;
  `decisionTime <= evaluatedAt` on all records; developing records carry none.
- **Insufficient history**: `mk()` fixture (one resolving setup, self-excluded by E2 →
  zero eligible) → `unavailable: "insufficient_data"`, estimate absent.
- **Populated estimate**: two temporally-separated cells (cell A resolves before cell B's
  `confirmBar`; `minSamples: 1` or 2) → cell B's records carry `estimate` with `sampleSize ≥ 1`,
  valid `cohortKey`/`cohortLevel`, monotone `pTarget`.
- **No contamination**: requesting setup's row never counted; a third cell resolving *after*
  B's τ but *before* its eval records proves E2 exclusion (`sampleSize` unchanged).
- **Prefix/full causality**: prefix `[0..cut]` vs full — records ≤ cut carry identical
  `statisticalEvidence` (incl. `sampleSize`, `cohortKey`), even though the full run contains
  additional resolved rows.
- **Determinism**: two identical runs identical; permuted `cells[]` identical (global dataset).
- **Regression**: `evidence.decisionTime > asOf` never fires in-pipeline (`futureEvidence`
  stays 0); all existing suites unmodified.

## 14. Scope

**WILL**
- Wire `estimateProbability` into `runBacktest` (two-phase restructure + candidate attach).
- Populate `ScanCandidate.statisticalEvidence` → flows verbatim to `BacktestOpportunity`.
- `docs/engine/30-statistical-evidence-composition.md` (this doc) + index rows.
- Additive tests per §13.

**WILL NOT**
- Modify `statistics.ts`, scanners, outcomes, regime, trade-plan, scoring producers.
- Change any contract/type (`StatisticalEvidence`, `ProbabilityEstimate`, engine interfaces
  already exist).
- Add MTF, new cohort axes, smoothing/intervals/calibration, ML, persistence, UI, services,
  realtime, broker/alerts.
- Retro-modify specs 26–29 semantics; reorder for order's sake.

## 15. Open questions

- **Q1**: `invalid_stats_config` handling — diagnostics-count (chosen, R4) vs loud
  run-failure? Recommendation: diagnostics-count; revisit only if spec-21 mandates hard fail.
- **Q2**: Multi-timeframe cohort cross-pollination is canonical (no `timeframe` axis in
  spec 24) — noted, not a defect.

## 16. Expected files to change

- `src/lib/engines/backtest.ts` — restructure + wiring (~+60/−20 lines).
- `src/lib/engines/__tests__/statistical-evidence.test.ts` — new additive suite (~8–10 tests).
- `docs/engine/30-statistical-evidence-composition.md` — this document.
- `docs/engine/README.md`, `docs/architecture/market-intelligence-engine.md` — index rows.

## 17. Baseline

733 tests passing (716 pre-29 + 17 spec-29 additive). `tsc --noEmit` clean; eslint clean.
