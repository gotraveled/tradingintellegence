# 31 — Multi-Timeframe Alignment Composition

Status: Draft (implemented — `runBacktest` composes `causalAlignAt` via `BacktestCell.frames`; 12 additive tests in `__tests__/mtf-composition.test.ts`)

Composition-only phase: wire the existing spec-10 MTF producer (`causalAlignAt`,
`src/lib/engines/mtf.ts`) into `runBacktest` (`src/lib/engines/backtest.ts`) so the per-bar
causal join `at(t)` populates `alignment` on the shared snapshot — feeding the four declared
but never-populated consumption slots (`ReversalInput`, `BreakoutInput`,
`ContinuationInput`, `ScoringSnapshot`). Spec 10 remains the behavioral authority for
votes/states; this spec adds no new MTF logic and changes no producer.

## 1. Context — why now

- Spec-29 §out-of-scope: "MTF alignment slices" — explicitly deferred.
- Spec-30 §10: "MTF alignment … remains deferred to a later spec. No MTF wiring."
- The producer exists and is tested: `causalAlignAt` + `causalFramesAt` +
  `closedIndexAt`/`barCloseTime` implement spec 10's point-in-time join canonically
  (`mtf.test.ts` in the 745-test baseline).
- The consumers exist and are tested: `scoreCandidate` reads `snap.alignment` for gate 3
  (countertrend → `developing` cap) and the `htfAlignment` dimension (weight 10); the three
  detectors declare `alignment?: MultiTimeframeAlignment` on their input interfaces and
  consume it (reversal `mtf_veto_*` cancellation + C8 reason; breakout HTF-fight check;
  continuation context stamps).
- The join never populates the field: `at(t)` in `runBacktest` returns
  structure/pools/zones/imbalances/momentum/regime/events — no `alignment`. Every
  `at_bar`-provenance score today reads `alignment === undefined` → `fHtf = 0.2`
  (`no_context` bucket). The `htfAlignment` dimension is unreachable through the causal
  path; only the non-authoritative `"snapshot"` provenance can exercise it.
- `BacktestCell` carries a single `CandleSeries` — there is no caller contract to supply
  auxiliary timeframe candles. That contract is this spec's only new surface.

This is the last declared-and-deferred composition surface in the pipeline; it follows the
same closure pattern as spec 29 (regime + plan wiring) and spec 30 (statistical evidence).

## 2. Canonical contract

`runBacktest` gains an additive, optional input surface:

```ts
interface BacktestCell {
  symbol: string;
  timeframe: Timeframe;
  series: CandleSeries;
  /** Spec-31 auxiliary frame series, keyed by role. Roles whose configured timeframe
   *  equals this cell's own timeframe are served by `series` — never by `frames`. */
  frames?: Partial<Record<FrameRole, CandleSeries>>;
}
```

- Role assignment comes from `config.mtf.set` (`{htf, itf, etf}`): the cell's `series`
  serves whichever role's configured timeframe equals `cell.timeframe` (typically `itf`);
  remaining roles are taken from `frames`.
- When `frames` is absent (or empty after validation), `at(t)` behaves exactly as today:
  `alignment` is `undefined` everywhere. Zero regression by construction.

When at least one frame role is supplied, `at(t)` computes:

```ts
alignment = causalAlignAt(symbol, roles, config.mtf.weights, asOf).alignment
// asOf = barCloseTime(candles[t], cell.timeframe)
// roles: cell's series for its own role + FrameSource per supplied frame
```

and the returned `MultiTimeframeAlignment` rides the existing `...at(t)` spread into
`ScoringSnapshot.alignment` and into each detector's `input.alignment` — the declared,
today-unpopulated slots. No type changes to `ReversalInput`/`BreakoutInput`/
`ContinuationInput`/`ScoringSnapshot`; no record-shape changes.

## 3. Producer reuse — no new MTF logic

`causalAlignAt` already implements the full spec-10 contract:

- `closedIndexAt(candles, tf, asOf)` — binary search over `barCloseTime`; only bars whose
  close ≤ `asOf` are visible. The MTF no-look-ahead rule is enforced inside the join and
  cannot be miswired by composition.
- `causalFramesAt(roles, asOf)` — per-role `FrameSource { timeframe, candles, at(idx) }`;
  `null` when no legally closed bar exists (insufficient history → vote 0).
- `snapshotVote` — structure bias first, momentum bias second, else 0 (spec-10 vote
  precedence, `source` recorded).
- `classifyVotes` — the 27-combination truth table including `realigning_*`/`countertrend_*`
  honesty states; `alignmentScore` = weighted vote sum.
- `computedAt` — derived from upstream snapshot timestamps (or `asOf` ISO), never
  wall-clock; deterministic.

Spec 31's composition supplies `FrameSource`s; it re-derives nothing.

## 4. Frame pipeline — minimal legal slice

Each supplied frame role gets its own causal providers over its own candles, built once per
cell in Phase A alongside the cell's own upstream batch:

- `detectSwings(frame.candles, …)` → `structureStateAt(…)` (structure requires swings);
- `momentumStateAt(frame.candles, …)` (standalone over candles).

`FrameSource.at(idx)` returns `{ structure, momentum }` — the only fields `snapshotVote`
consumes. Frame-level `pools`/`zones`/`imbalances`/`events` are legal `FrameSnapshot`
members but consumed by no current MTF consumer (spec-10's "HTF elements consumed" is a
downstream-consumer contract — see §10 non-scope); they are not composed in this phase.

A frame's providers run over the frame's **full** series (mirroring the cell's batch-at-once
upstream pattern); causality is enforced by `closedIndexAt` at join time, not by truncation.

## 5. Temporal anchors

| Anchor | Value | Rationale |
| ------ | ----- | --------- |
| Join `asOf` | `barCloseTime(candles[t], cell.timeframe)` | bar `t` is *closed* when the pipeline evaluates it — the same boundary every other `at(t)` slice uses; a same-timeframe role sees bar `t`, a slower frame sees only bars closed by `t`'s close. |
| Frame visibility | `closedIndexAt(frame.candles, frame.tf, asOf)` | strict close-time comparison on wall-clock ms — never index arithmetic across series of different cadence. |
| Alignment lifetime | recomputed per `at(t)` call | spec 10: "votes are snapshots … recomputed, never persisted as truth." No memoization contract is required (pure function); implementations may memoize on `(t)` within a cell without changing semantics. |

- Alignment is **evaluation-time context**, not a setup anchor: `candidateBar`,
  `confirmBar`, `scoreAtConfirmation`, `regime` anchors, and `decisionTime` are untouched.
- No index mixing: the join compares close timestamps only; a frame with gaps or a shorter
  series simply contributes fewer/older legal bars (or none → vote 0).

## 6. Semantics activated (existing hooks, dormant until now)

With `alignment` populated, previously unreachable behavior becomes live — all of it
already implemented and unit-tested on the producer/consumer side:

- **Reversal (spec 12)**: `alignment.state` starting `countertrend` → `cancelled`
  (`mtf_veto_*` transition); C8 reason gains a real verdict; `contextTimeframe` stamps.
- **Breakout (spec 13)**: HTF bias fighting the break direction blocks confirmation; B7
  reason gains a real verdict.
- **Continuation (spec 14)**: `contextTimeframe`/`mtfState` context stamps populate.
- **Scoring (spec 15)**: gate 3 (`countertrend_*` → `developing` cap) and the
  `htfAlignment` dimension (`aligned_*` = 1.0; `pullback_*`/`realigning_*`/`htf_dominant` =
  0.5; `countertrend_*`/`no_context`/`ltf_directed`/`neutral` = 0.2) activate under the
  `at_bar` path; `scoreContributions` records `mtf <state>` — the explainability trail.

Cells without `frames` produce **bit-identical** output to the spec-30 baseline:
`alignment` stays `undefined`, `fHtf` stays 0.2, no detector reads a state.

## 7. Degradation & error semantics

| Condition | Behavior |
| --------- | -------- |
| `frames` absent/empty | `alignment` undefined; no diagnostic (status quo). |
| Frame series fails `validateSeries`-equivalent checks | role ignored; `mtfFramesSkipped` diagnostic names `cellKey:role`; remaining roles still compose (honest partial context, vote 0 for the missing role). |
| Frame `timeframe` ≠ `config.mtf.set[role]` | role ignored; `mtfFramesSkipped` diagnostic (caller contract violation — never silently re-keyed). |
| Frame whose timeframe equals the cell's own | ignored with diagnostic — the cell's `series` is authoritative for its own role. |
| Frame present but no bar closed by `asOf` | producer's `null` → vote 0 → `no_context`/`ltf_directed`-family states (honest insufficient-history, not an error). |
| `cell.timeframe` ∉ `config.mtf.set` | cell serves no role; all three roles come from `frames` (or vote 0); still composable. |
| `config.mtf` | required field — no fallback invented; absent ⇒ not constructible at the type level. |

No new `EngineError` codes. Diagnostics-only degradation matches spec-30's R4 precedent
(count, degrade honestly, never fabricate, never fail the run for aux evidence).

## 8. Determinism

- Role iteration is fixed (`["htf","itf","etf"]` literal order inside `causalFramesAt`).
- Cell ordering (symbol ASC, timeframe canonical) unchanged; frames do not create cells and
  never appear in `SystemBacktestResult.cells`.
- `causalAlignAt` is pure; `computedAt` derives from snapshot timestamps/`asOf` — identical
  inputs ⇒ identical `MultiTimeframeAlignment` bit-for-bit.
- Permuted `cells[]` and permuted `frames` key-order produce identical output (Map/record
  reads are order-independent).

## 9. Regression surface — spec-26/29/30 invariants held

- Two-phase structure unchanged: frame providers build in Phase A (batched upstream);
  alignment reads inside `at(t)` serve both Phase-A detection and Phase-B evaluation — the
  same value at the same `t` everywhere, by construction.
- `statisticalEvidence` untouched: MTF is explicitly **not** a spec-24 cohort axis and is
  named "forbidden as features" (spec 24); the `reg`/`sb` axes and E1–E4 gating are
  unaffected. (Detection may now cancel setups via MTF veto — that changes *which* outcome
  rows exist for framed cells, which is the intended spec-10 semantic, not leakage.)
- `outcomeRef` post-pass join, frozen records, `existsAt` observed-gating, prefix/full
  stability — all preserved; alignment is recomputed from causal joins and is prefix-stable
  like every other `at(t)` slice.

## 10. Explicit non-scope

- No MTF cohort axis, no statistics change — spec 24 forbids MTF as a feature; spec-30
  evidence semantics untouched.
- No `alignment` field on `ScanCandidate`/`BacktestOpportunity`/`SetupOutcome` — no
  contract slot exists; explainability rides `scoreContributions` (`mtf <state>`) and
  `sources`/`votes` stay inside the producer result consumed by scoring/detection.
  Persisting alignment on records is a contract extension for a later spec if needed.
- Frame-level zones/liquidity/imbalance **consumption** (spec-10 "HTF elements consumed" —
  `htfAligned` flag, `htfProtectedHigh/Low`, HTF-pool sweep strength) — those are
  detector/scoring feature contracts, deferred; this spec supplies votes only.
- No spec-10 `alignmentScore ≥ 0.8` confirmation-threshold enforcement beyond existing
  consumer hooks — see Q1.
- No UI, service, live/realtime, persistence, ML, broker, alerts. No changes to `mtf.ts`,
  `scoring.ts`, or any detector's *logic* — only the `at(t)` join populates the slot.

## 11. Reconciliation decisions

- **R1 — `frames` lives on `BacktestCell`, not the request.** Auxiliary series are
  per-evaluation-cell context (a symbol's own higher/lower frames); a request-level map
  would force symbol+timeframe keying twice and leak cross-cell coupling.
- **R2 — the cell's own series is authoritative for its role.** `frames[itf]` for a 1h
  cell under `set.itf="1h"` is a caller error (diagnostic, ignored) — two candidate sources
  for one role is ambiguity the contract refuses.
- **R3 — `asOf` is the bar close, not the bar stamp.** `candles[t].time` is the bar's
  opening stamp; `barCloseTime` is the visibility boundary `closedIndexAt` compares
  against. Using the open stamp would shift every same-timeframe frame's view back one bar.
- **R4 — composition only, producer untouched.** All MTF semantics (votes, truth table,
  weights, close-time join) are spec-10's and already implemented; this spec adds the join
  surface and the input contract — mirroring spec-29 (regime join) and spec-30 (evidence
  attach) exactly.

## 12. Deferred items (declared, not implemented here)

- Frame `pools`/`zones`/`imbalances`/`events` context and its consumers (spec-10 "HTF
  elements consumed").
- `alignment` persistence on records (contract extension, needs spec-26 field decision).
- `alignmentScore ≥ 0.8` confirmation cap (Q1).
- `regime.minBars` hysteresis (spec-19 conditional deferral — unrelated, still deferred).
- Spec-24 confidence intervals (estimator extension under a new `methodVersion`).

## 13. Test plan

New file `src/lib/engines/__tests__/mtf-composition.test.ts` — additive; fixtures reuse the
spec-26/29/30 `mk()` shape plus crafted HTF/ETF series (e.g. 4h-aggregated and 15m-fine
series whose structure/momentum bias is controllable). No existing test modified unless a
stale premise (like spec-29's "evidence unpopulated" one) proves false.

| ID | Requirement | Test |
| -- | ----------- | ---- |
| A | population | framed cell: `ScoringSnapshot.alignment` populated under `at_bar`; `scoreContributions` shows real `htfAlignment` factor (≠ `no_context` bucket) |
| B | countertrend veto | bearish-HTF frame over a bullish-reversal cell → `mtf_veto_*` cancellation; setup never confirms |
| C | scoring gate 3 | `countertrend_*` state caps scoreable status at `developing` (spec-15 gate) |
| D | htfAlignment dimension | `aligned_*` vs `pullback_*` fixtures produce the spec-15 factor table values in `scoreContributions` |
| E | causal boundary | HTF bar closed *at* vs *after* `asOf` — only the closed one is visible; wall-clock, never frame index |
| F | missing/partial frames | etf-only supply → htf votes 0 → `htf_dominant`-family honesty; no fabrication |
| G | absent frames = baseline | identical run with and without `frames` key ⇒ identical full result (regression anchor) |
| H | prefix/full stability | truncated cell + frames: records ≤ T identical to full-run records ≤ T |
| I | determinism/permutation | two runs + reversed `cells[]` + reversed `frames` key order ⇒ identical output |
| J | validation failures | malformed frame series / timeframe≠`set[role]` / frame==cell.tf → `mtfFramesSkipped` diagnostic, run survives, honest vote-0 |
| K | statistics isolation | `statisticalEvidence` and `outcomes` unaffected by frames beyond intended lifecycle effects; no `mtf` substring in any `cohortKey` |
| L | existing suite | 745-test baseline unchanged (all pre-spec-31 tests pass unmodified) |

## 14. Open questions

- **Q1 — `alignmentScore ≥ 0.8` confirmation cap.** Spec 10 requires `≥0.8` for
  `confirmed`, `0.5–0.8` caps at `developing`; today only the `countertrend` vetoes exist
  in consumers. Implementing the threshold changes detector lifecycle semantics — specs
  11–14 are the authorities. Recommendation: defer to a follow-up lifecycle spec; flag in
  implementation report. (Wiring the field does not silently activate it — no consumer
  reads `alignmentScore` today.)
- **Q2 — frame `FrameSnapshot` breadth.** Should composition pass `pools`/`zones`/`events`
  through `FrameSource.at` now (harmless passthrough) or strictly `structure+momentum`?
  Recommendation: strict minimal slice — passthrough implies a consumer contract that does
  not exist yet.

## 15. Expected files to change (implementation phase)

- `src/lib/engines/backtest.ts` — `frames` handling in `prepareCell` (per-frame upstream
  batch), `FrameSource` construction, `alignment` on the `at(t)` return (~+80/−10 lines).
- `src/lib/types/domain/backtest-system.ts` — `BacktestCell.frames?` field (+3 lines).
- `src/lib/engines/__tests__/mtf-composition.test.ts` — new additive suite (~12 tests).
- `docs/engine/README.md`, `docs/architecture/market-intelligence-engine.md` — index rows.

## 16. Baseline

745 tests passing (733 pre-30 + 12 spec-30 additive). `tsc --noEmit` clean; eslint clean;
`npm run build` clean. Specs 00–30 approved and closed.
