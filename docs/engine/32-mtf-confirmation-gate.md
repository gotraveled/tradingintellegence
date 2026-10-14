# 32 — MTF Confirmation Gate

Status: Draft (authored — awaiting approval before implementation)

Implementation-closure spec: enforce the spec-10 mandatory conflict-handling rule at the
lifecycle layer — `alignmentScore` thresholds gate the `developing → confirmed` transition.
This is **not** a composition spec: spec 31 already delivers `MultiTimeframeAlignment`
(including `alignmentScore`) into every detector's input via `at(t)`. This spec activates the
one canonical spec-10 rule that has never been enforced.

## 1. Context — why now

- Spec-10 §"Conflict handling rules (deterministic)": **"`alignmentScore ≥ 0.8` required
  for `confirmed` setups; `0.5–0.8` caps setups at `developing`; `< 0.5` or mixed states →
  countertrend/watch only."** — mandatory vocabulary ("required"), canonical text.
- Spec-10 honesty rules: `realigning_*` "is never bullish/bearish … a watch state until ITF
  structure agrees". Signed `realigning_*` scores 0.4 — under the canonical rule it must
  never confirm, yet today it is C8-"acceptable" and nothing blocks its confirmation.
- Spec-31 §14 Q1 — **explicitly deferred to this spec**: "`alignmentScore ≥ 0.8`
  confirmation cap … Recommendation: defer to a follow-up lifecycle spec." The activation
  condition (live `alignment` on the causal join) is now satisfied.
- `alignmentScore` is produced by `causalAlignAt` and flows into `snap.alignment`, but a
  source-wide audit finds **zero production readers** — only `mtf.ts` (producer), the type
  declaration, and unit tests. The rule is implemented nowhere.
- The missing enforcement is now observable: a reversal that meets C1–C6 inside
  `pullback_in_trend_bull` (signed score 0.6) confirms today; spec 10 says it must hold
  `developing` until `≥ 0.8`.

## 2. Dependency map

```
spec-10 truth table + weights          (mtf.ts — producer, COMPLETE, tested)
        ↓ causalAlignAt / closedIndexAt
spec-31 at(t) join                     (backtest.ts — composition, COMPLETE)
        ↓ snap.alignment.alignmentScore
spec-12/13/14 confirm transitions      ← SPEC 32 GATES HERE (currently ungated)
        ↓ confirmed setups
spec-15 scoring / spec-17 outcomes / spec-24 decision views   (downstream, unchanged)
```

Confirm sites to gate (exact, audited):
`reversal.ts` `transit(l,t,"confirmed","all_required_met")` at both emit points
(candidate-time `allMet` promotion and the re-evaluation sweep);
`breakout.ts` `transit(l,t,"confirmed","attempt_disp_confirmed")`;
`continuation.ts` `transit(l,t,"confirmed","quality_recovery_confirm")`.

## 3. Canonical rule — exact semantics

At each `developing → confirmed` transition attempt, when `snap.alignment !== undefined`:

```ts
const signedScore =
  snap.alignment.alignmentScore * (setup.direction === "bullish" ? 1 : -1);
const confirmable = signedScore >= 0.8;
```

- **Direction-signed** (R1): `alignmentScore` is signed toward bullish. Spec-10's "≥0.8"
  only has meaning as *agreement with the setup's direction* — a bearish setup inside
  `aligned_bear` (raw −1.0) must be confirmable. `signedScore = score · dir`.
- **Gate iff alignment is defined** (R2): `alignment === undefined` (no frames supplied)
  ⇒ gate inactive ⇒ records bit-identical to the spec-31 baseline. The spec-31 parity
  invariant is preserved by construction.
- **Thresholds land on the same transition**: `≥0.8` → may confirm (all other required
  conditions still govern); `0.5–0.8` → hold `developing`; `<0.5`/mixed → hold
  `developing` ("watch" — spec 11 has no watch status; "watch only" = remains developing,
  which is already the observable vocabulary for non-cancellable, non-confirming states).
- **Layered over existing vetoes, never replacing them** (R3): the spec-12 `mtf_veto_*`
  countertrend cancellation (which also applies to `confirmed` setups — reversal.ts:238)
  is unchanged and remains the stronger action. The gate only *withholds* confirmation.
- **Re-evaluated, never latched** (R4): `alignmentScore` is recomputed per `at(t)`
  (spec 10: "votes are snapshots … never persisted as truth"). A setup held at `t` can
  confirm at `t+k` when the ETF realigns — `confirmBar` then moves honestly, and spec-30's
  decision view/scoreAtConfirmation anchor at the later bar.
- **Explainability** (R5): when the gate blocks an otherwise-confirmable setup, emit one
  unmet `multi_timeframe` reason so `developing` records report "what's missing"
  (spec-25 SetupRef semantics): family-local ids `C10` (reversal � `C9` is the activation trigger, already reserved), `B9` (breakout � `B8` is the opposing-CHOCH guard), `N8` (continuation); label "MTF confirmation threshold (alignmentScore·dir ≥ 0.8)".
  The reason is emitted **only when alignment exists** — unframed runs never see it
  (parity holds), and `met` is re-evaluated each bar like every other reason.

## 4. Producer/consumer audit

| Component | State |
| --------- | ----- |
| `causalAlignAt` → `alignmentScore` | implemented, tested (spec 10 + spec 31 wiring) |
| `snap.alignment` on all three detector inputs | populated (spec 31) |
| Named-state consumers | live: C8 acceptable-map, `mtf_veto_*` cancel, breakout HTF-fight, continuation stamps, spec-15 gate-3 + `htfAlignment` dimension |
| **`alignmentScore` numeric consumer** | **none — this spec** |

## 5. Data flow

```
BacktestCell.frames → per-frame providers → causalAlignAt(t)
    → at(t).alignment { state, votes, alignmentScore }
    → detector input snapshot
    → developing→confirmed guarded by signedScore ≥ 0.8
    → (unchanged) scoring / plans / outcomes / evidence downstream
```

Temporal model: identical anchors to spec 31 — `asOf = barCloseTime(candles[t])`; the gate
reads the same `at(t)` snapshot the rest of detection sees at that bar. No new temporal
surface; prefix/full stability and determinism inherit from the spec-31 join.

## 6. Degradation & determinism

- `alignment === undefined` → gate inactive (§3 R2). No diagnostic — absent frames are
  baseline, not an error (spec-31 convention).
- Missing frame roles inside a composed run → producer vote-0 → the named states and a
  low `alignmentScore` do the honest work; `htf_dominant`/`ltf_directed` families score
  `<0.8` and hold developing — exactly the spec-10 intent ("no HTF context ⇒ lower frames
  can only produce `developing`, never `confirmed`").
- No new error codes, no diagnostics counters beyond the reason itself.
- Determinism: pure predicate over an already-deterministic field; no ordering effects.

## 7. Reconciliation decisions

- **R1** direction-signed score (§3).
- **R2** gate iff `alignment` defined (parity invariant).
- **R3** gate is additive to C8/B7/N-family acceptability — acceptability is the
  *veto boundary* ("not countertrend"); the gate is *confirmation readiness*. C8/B7/N7
  verdicts are unchanged; a `pullback_in_trend_*` setup still shows C8 `met: true` while
  C10 blocks confirmation — two different predicates, both honest.
- **R4** blocked ⇒ hold `developing` only; never cancel, never invalidate, never a new
  status. `watch` maps onto `developing` (spec-11 vocabulary has nothing else).
- **R5** the gate reason is conditional on `alignment` existing (§3 R5).
- **R6** post-confirmation drift does not un-confirm: the gate lives only at the
  `developing → confirmed` edge; post-confirm countertrend handling stays with the
  existing spec-12 `mtf_veto_*` cancellation path.
- **R7** detectors only; `runBacktest`, `scoring.ts`, `mtf.ts` are untouched — spec 31
  already supplies the field.

## 8. Scope

- Gate the `developing → confirmed` transition in `reversal.ts`, `breakout.ts`,
  `continuation.ts` on the direction-signed `alignmentScore ≥ 0.8`, alignment-present only.
- Emit the family-local unmet reason (`C9`/`B8`/`N8`) while blocked.
- One additive test file.

## 9. Non-scope

- No change to spec-10 producer, spec-15 scoring formulas/gates, spec-11 status model,
  spec-12/13/14 named-state vetoes or C8/B7/N7 acceptability semantics.
- No `alignment`/`alignmentScore` fields on records/outcomes (spec-31 non-scope stands).
- No frame-level zones/liquidity/imbalance consumption (`htfAligned`, `htfConfluence`,
  `htfConflict`, `htfProtectedHigh/Low`) — separate deferred surface, untouched.
- No hysteresis, no CI, no UI/service/realtime/ML/persistence/broker work.

## 10. Test plan

New file `src/lib/engines/__tests__/mtf-confirmation-gate.test.ts` — additive.

| ID | Requirement | Test |
| -- | ----------- | ---- |
| A | gate blocks below threshold | framed cell, `pullback_in_trend_bull` regime (signed 0.6): reversal stays `developing`, `confirmBar` absent; unframed twin confirms |
| B | gate releases at ≥0.8 | same fixture where ETF realigns later → `aligned_bull` (1.0) → confirms at the later bar; `confirmBar` > earlier blocked bar |
| C | boundary | craft signed score exactly 0.8 (`aligned` with one role 0) → confirms; 0.7 (`htf_dominant`, etf-agree) → holds developing |
| D | direction symmetry | bearish setup under `aligned_bear` confirms (signed +1.0); bullish setup under `aligned_bear` is blocked (existing countertrend path still owns cancellation) |
| E | reason honesty | blocked record carries unmet `C10`-family `multi_timeframe` reason; confirmed/absent-frame records never carry it |
| F | parity | unframed cell bit-identical to spec-31 baseline (reasons included — `C10`/`B9`/`N8` absent) |
| G | post-confirm stability | countertrend veto on confirmed setups unchanged (reversal.ts:238 path); gate never un-confirms |
| H | prefix/full + determinism | truncated runs identical ≤ T; permuted frames/cells identical |
| I | regression | 757-test baseline unchanged |

## 11. Expected files

- `src/lib/engines/reversal.ts` — gate at both confirm sites + `C10` reason.
- `src/lib/engines/breakout.ts` — gate at `attempt_disp_confirmed` + `B9` reason.
- `src/lib/engines/continuation.ts` — gate at `quality_recovery_confirm` + `N8` reason.
- `src/lib/engines/__tests__/mtf-confirmation-gate.test.ts` — additive suite.
- Index rows (docs/engine/README.md, architecture map) at implementation time.

## 12. Baseline

757 tests (745 + 12 spec-31 additive); `tsc --noEmit` clean; eslint clean; `npm run build`
clean. Specs 00–31 approved/closed.

## 13. Open questions

- **Q1**: `ltf_directed`/`no_context`/`neutral` (signed score ≤ 0.5 with no HTF frame) —
  spec-10's "ETF alone cannot create a setup" vs the current reality that unframed cells
  *must* confirm (parity). Resolved by R2: the gate only exists when alignment is
  composed; inside a composed run a `ltf_directed` state (htf=0, e.g. malformed/absent
  htf frame) signs ≤0.5 and correctly holds developing — the intended spec-10 outcome.
- **Q2**: whether `htf_dominant` at exactly 0.8 boundary semantics need a dedicated
  fixture — implementation determines via test C.

## 14. Acceptance criteria

1. `developing → confirmed` fires iff `signedScore ≥ 0.8` whenever `snap.alignment` is
   defined — at all three detectors, all confirm paths.
2. `alignment === undefined` ⇒ bit-identical records vs spec-31 (records + reasons).
3. Blocked confirmations hold `developing` with the unmet `C10`/`B9`/`N8` reason; release
   re-anchors `confirmBar` and all spec-29/30 downstream anchors honestly.
4. Existing vetoes (`mtf_veto_*`, gate-3) unchanged; no producer/scoring/composition code
   modified outside the three detector files.
5. 757-test baseline preserved; new suite is additive.
