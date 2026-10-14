# 33 — MTF Frame-Element Composition

Status: Implemented — 790/790 tests (`mtf-frame-elements.test.ts`, 18 additive), tsc/ESLint/`next build` clean.

Implementation-closure spec: complete spec-10's **"HTF elements consumed"** contract — compose the
non-vote frame payload (`pools`/`zones`/`imbalances`/`events`) through the existing causal join and
activate its named consumers (`Zone.htfAligned`, HTF-confluence scoring weight, `htfConflict`,
`liquidityContext`, `htfProtected*`). This is the last surface explicitly deferred by name inside a
closed spec (31 §12).

## 1. Title

MTF frame-element composition — transport + consumption of per-frame liquidity, zones, imbalances,
and events as scored/marked context (never votes, never direction).

## 2. Classification

- **Type:** composition + dormant-consumer activation (same pattern as specs 29/30/31).
- **Not:** a producer spec (no new detectors), a lifecycle spec (no new statuses), or a contract
  redesign. `FrameSnapshot` already declares the transport slots; the consumers are already named
  in canonical specs.
- **Behavioral authorities:** spec 10 ("HTF elements consumed"), spec 05 (HTF-confluence weight),
  spec 15 (`htfAlignment`/`liquidity` scoring dimensions), spec 13 (`htf_aligned` break bonus).

## 3. Canonical source references

| Source | Statement | Status |
| ------ | --------- | ------ |
| spec-10 §"HTF elements consumed" | `htfAligned` flag for entry inside same-direction HTF zone; `htfConflict` penalty for opposing HTF zone; ETF sweep of HTF pool = stronger evidence (`liquidityContext` in scoring); `htfProtectedHigh/Low` bound trade context — ITF break of protected level = HTF CHOCH, ends aligned state (re-evaluation, not assumption) | **consumers unimplemented** |
| spec-10 §"Implementation notes" (reconciliation) | `FrameSnapshot` "carries them (`liquidity`, `zones`, `imbalances`) through the causal join so consumers get the legally visible sets **without** recomputing" — transport designed, consumption deferred to "detector/scoring feature contracts" | transport declared, unwired |
| spec-31 §12 "Deferred items (declared, not implemented here)" | "Frame `pools`/`zones`/`imbalances`/`events` context and its consumers (spec-10 'HTF elements consumed')" | **explicitly deferred to a later spec — this spec** |
| spec-31 §14 Q2 | "frame `FrameSnapshot` breadth" — whether composition passes `pools`/`zones`/`events` was left open | open question resolved here |
| spec-32 §9 non-scope | "No frame-level zones/liquidity/imbalance consumption (`htfAligned`, `htfConfluence`, `htfConflict`, `htfProtectedHigh/Low`) — separate deferred surface, untouched" | reaffirmed deferral |
| spec-05 §"Implementation notes" | "`htfAligned` stays unset" — HTF-confluence feature (weight 0.10) treated as unavailable, weight redistributed pro-rata | dormant feature + dormant field |
| spec-05 scoring table | "HTF confluence — zone inside HTF demand / at HTF swing low = 1.0; near = 0.5; opposing = 0" | `f` mapping defined, unactivated |
| spec-13 §"MTF rule" | "`htf_aligned` bonus when the break direction agrees with HTF bias" | vote-level part done (B7/`htfBias`); zone/pool-level part is this spec |

## 4. Problem statement

Spec-31 delivered `MultiTimeframeAlignment` (votes + `alignmentScore`) to every detector and to
scoring, and spec-32 enforced the confirmation threshold. But the alignment object is a *vote
summary*: it carries no pools, no zones, no imbalances, no events. Spec-10's "HTF elements
consumed" rules require exactly those elements — a same-direction HTF demand zone, an HTF liquidity
pool, the HTF protected structure level — none of which reach a consumer today:

- `FrameSnapshot.liquidity` / `.zones` / `.imbalances` / `.events` are declared transport slots
  (`src/lib/engines/mtf.ts:113-121`) that no `FrameSource.at` provider populates — the spec-31
  wiring in `runBacktest` supplies only `{ structure, momentum }` per frame.
- `Zone.htfAligned` (`src/lib/types/domain/zone.ts:43`) is a declared contract field that is never
  set — spec-05 documents it stays unset and redistributes the 0.10 weight.
- `htfConflict`, `liquidityContext` (HTF-pool sweep strength), and `htfProtectedHigh/Low` have no
  code representation at all.
- Frame-level `events` (e.g. an HTF `sweep_confirmed`) never reach detector inputs — spec-13's
  canonical-consumption note names `FrameSnapshot.events` as an expected input.

Result: every framed run silently under-scores HTF-confluent zones, cannot mark HTF-pool sweeps as
stronger evidence, and cannot detect an HTF CHOCH against the protected level — all named
requirements of a closed spec, not new ideas.

## 5. Current architecture state

Producer → transport → consumer map as implemented:

```text
BacktestCell.frames?: { htf, itf, etf }: CandleSeries        (spec-31 contract)
        │
        ▼   per-frame batch (backtest.ts:235-243)
detectSwings → structureStateAt / momentumStateAt            (votes only)
        │
        ▼   FrameSource { timeframe, candles, at: (idx) => ({ structure, momentum }) }
causalFramesAt / causalAlignAt (mtf.ts)  — closedIndexAt enforces barCloseTime ≤ asOf
        │
        ▼
MultiTimeframeAlignment { votes, state, alignmentScore }     (all composed paths)
        │
        ├──► detector inputs .alignment   (spec-31)
        ├──► ScoringSnapshot.alignment    → htfAlignment dimension   (spec-15)
        └──► spec-32 confirmation gate    (C10/B9/N8)

FrameSnapshot.liquidity|zones|imbalances|events              — DECLARED, NEVER POPULATED
```

Frame payloads are **batched per cell** (`fSwings` computed once per supplied frame in
backtest.ts) — extending `at` to return the full `FrameSnapshot` requires the frame-level
`analyzeLiquidity`/`analyzeZones`/`analyzeImbalances` batches plus their `*StateAt` providers
(`liquidityStateAt` liquidity.ts:556, `zoneStateAt` zones.ts:517, `imbalanceStateAt`
imbalances.ts:225) — all of which exist, are tested, and take the same
`(candles, …, paramsVersion, atIndex)` signature already used by `structureStateAt`/
`momentumStateAt` in the spec-31 wiring.

## 6. Dependency map

```text
existing verified producers (per-frame *StateAt)
        ↓
FrameSource.at extended to full FrameSnapshot   ← single canonical composition point
        ↓
causalFramesAt (existing join — unchanged)
        ↓
consumers:
  ├─ zones.ts        htfAligned flag + HTF-confluence feature (spec-05, weight 0.10)
  ├─ scoring.ts      liquidityContext (HTF-pool sweep) feeds liquidity dimension (spec-15);
  │                  htfConflict feeds htfAlignment dimension f (spec-10 penalty rule)
  ├─ detectors       FrameSnapshot.events reach *Input.events only where a spec names it
  │                  (spec-13 canonical-consumption note); reversal/continuation unchanged
  └─ mtf.ts producer htfProtected* — see §12 R3 (the one producer-side rule spec 10 defines)
```

Depends on: specs 10 (contract), 31 (frames + join — the activation trigger it deferred on).
Satisfied by: nothing pending — all triggers met post-32.

## 7. Existing implementation audit

| Component | State |
| --------- | ----- |
| `FrameSnapshot` type with all four slots | exists (mtf.ts:113) — designed for exactly this |
| `causalFramesAt` join | exists, tested (mtf.test.ts) — returns `JoinedFrame.snapshot` which already carries whatever `at` returns — zero producer changes needed for transport |
| Frame `*StateAt` providers | `liquidityStateAt`, `zoneStateAt`, `imbalanceStateAt` exist; frame events need only `poolsRes.events`/`zonesRes.events`-style filtering `≤ idx` (own-TF code does this at backtest.ts:269) |
| `Zone.htfAligned` field | declared (zone.ts:43), never set — parity requires it remain unset when no HTF frame is supplied |
| spec-05 HTF-confluence weight redistribution | implemented pro-rata fallback — becomes conditional on frame presence, not unconditional |
| `htfAlignment` scoring dimension | consumes `alignment.state` (scoring.ts:149,211) — spec-10's `htfConflict` is a *zone-position* penalty, a different fact; see §12 R4 |
| `liquidity` scoring dimension | "confirmed sweep = 1.0" — no HTF-pool distinction; spec-10's `liquidityContext` is the upgrade path |
| `supersedes`, `selected`, `outcomeRef`, `BacktestSelection` | all wired — not part of this surface |

## 8. Missing functionality / composition

1. **Transport**: `FrameSource.at` in `runBacktest` returns `{ structure, momentum }` — extend to
   `{ structure, momentum, liquidity, zones, imbalances, events }` from per-frame batches.
   Causality is unchanged: `closedIndexAt` bounds `idx`, and each provider is already causal at
   `atIndex`.
2. **Alignment payload**: `causalAlignAt`'s returned `JoinedFrame`s already expose the snapshots —
   the missing piece is surfacing joined frames (not just the alignment summary) to detector
   inputs and `ScoringSnapshot`. Today only `alignment` is propagated (backtest.ts:271); consumers
   need `frames` (or per-role snapshots) to find HTF pools/zones.
3. **Consumers**:
   - `Zone.htfAligned` + spec-05 HTF-confluence feature activation (0.10 weight stops
     redistributing when HTF zones exist at zone-origin time).
   - `htfConflict` — setup entry inside an *opposing* HTF zone penalises the same evidence class.
   - `liquidityContext` — a cell-TF (ETF-role) sweep whose swept pool is an HTF-role pool scores
     as stronger evidence in the `liquidity` dimension (spec-15) — an *upgrade of the sweep
     feature*, not a new dimension.
   - `htfProtectedHigh/Low` — HTF structure's protected levels; an ITF break of the protected
     level = HTF CHOCH ending the aligned state. This is the only rule that reaches into
     alignment semantics — placement decision in §12 R3.

## 9. Data flow

```text
frame series (htf)  ──batch──► fSwings, fStructure, fPools, fZones, fImbs, fEvents
                                     │  *StateAt(idx≤closedIndexAt(asOf))
                                     ▼
                     JoinedFrame { timeframe, barIndex, snapshot: FrameSnapshot }
                                     │
            ┌────────────────────────┼─────────────────────────────┐
            ▼                        ▼                             ▼
   causalAlignAt → alignment   detector inputs (+frames)     ScoringSnapshot (+frames)
   (unchanged votes)           └► zone htfAligned/htfConflict └► liquidityContext /
                                  evaluation                       htfAlignment uplift
```

## 10. Temporal/PIT model

- Frame elements are knowable **only** at `closedIndexAt(frame.candles, tf, asOf)` — the same
  closed-bar boundary spec-31 enforces for votes. No new temporal rule is introduced.
- Zone `htfAligned` is evaluated against HTF-zone state **as of the zone's origin/anchor bar** —
  the legally-closed HTF bar at that instant, never an end-of-series HTF zone list.
- `htfProtected*` state change is *re-evaluation* per bar (spec 10: "re-evaluation, not
  assumption") — the aligned state ends at the first bar where an ITF close beyond the protected
  level is legally visible.
- Prefix property preserved: truncating any frame series can only *remove* context at later bars
  (`insufficient → null` frame), never fabricate it.

## 11. Error/degradation semantics

- Missing frame (no series for a role) → that role contributes no elements; `htfAligned` unset,
  confluence weight redistributes — identical to today's spec-31 honest-absence convention.
- Frame present but insufficient history (`at(idx) → null`) → `JoinedFrame = null`; consumers
  behave exactly as the absent case. Never fabricated.
- Malformed frame series fails spec-01 validation → skipped + `mtfFramesSkipped` diagnostic
  (existing spec-31 counter, same grammar).
- A frame supplying zones but no pools (or vice versa) is impossible by construction — the
  frame batch derives all artifacts from one `detectSwings` upstream, mirroring the cell's own
  batch.

## 12. Reconciliation decisions

- **R1 — transport before consumers, in one spec.** Spec-31 split composition from consumption
  because the field was dormant; here the consumers are *named by spec-10* and dormant fields
  already exist, so transport without consumers would emit no observable delta — both land
  together, each independently testable.
- **R2 — element scope = spec-10's list exactly.** `htfAligned`, `htfConflict`,
  `liquidityContext`, `htfProtectedHigh/Low`, and the spec-05 confluence feature. Nothing else
  (no new vote types, no new alignment states, no scoring dimensions).
- **R3 — `htfProtected*` placement.** Spec-10 defines it as ending the *aligned state* — producer
  semantics. Options: (a) implement inside `causalAlignAt` as a post-vote override (state →
  `countertrend_*`/`realigning_*` per truth-table semantics on an ITF-protected-level break),
  keeping `classifyVotes` pure; (b) leave alignment untouched and express it as a consumer-side
  veto/penalty. Recommended: **(a)** — spec-10 owns the rule, the join already has both frames'
  structure legally at `asOf`, and consumer-side expression would duplicate the rule at three
  detector sites. It is *not* a "modification" of the spec-10 producer — it is implementing its
  declared rule.
- **R4 — `htfConflict` ≠ `htfAlignment` dimension.** `htfAlignment` (scoring.ts) consumes the
  vote *state*; `htfConflict` is positional (entry inside opposing HTF *zone*). They coexist:
  a setup can be `aligned_bull` while its entry sits in an HTF supply zone.
- **R5 — parity invariant stands.** Unframed cells emit bit-identical records: no `htfAligned`,
  unchanged zone strengths (weight still redistributed), no `liquidityContext` marks, unchanged
  alignment (no frames → no protected-level data → rule cannot fire).
- **R6 — `events` slot.** Populated for frames; reaches detector `events` input only where the
  detector spec names frame events (spec-13). No speculative consumption elsewhere.

## 13. Detailed implementation design

1. `runBacktest` frame batch (per supplied frame): extend the existing `detectSwings` batch with
   `analyzeLiquidity`/`analyzeZones`/`analyzeImbalances` over the frame series; `FrameSource.at`
   returns `{ structure, momentum, liquidity, zones, imbalances, events }` via the frame
   `*StateAt` providers + events filtered `atBar ≤ idx`.
2. Surface joined frames: propagate `causalFramesAt` output (or a `frames:` map of
   `JoinedFrame`s) alongside `alignment` into detector inputs and `ScoringSnapshot` — additive
   optional fields (`frames?: Record<FrameRole, JoinedFrame>`), parity by construction.
3. `zones.ts`: `analyzeZones`/`zoneStateAt` gains an *optional* HTF-context input
   (`(atBar) => { zones, keyLevels } | undefined` — composition-supplied, never recomputed).
   Spec-05 feature activates: `inside same-dir HTF zone / at HTF swing low = 1.0; near = 0.5;
   opposing = 0`; sets `Zone.htfAligned`; `htfConflict` recorded for the opposing case
   (zone metadata + scoring input).
4. `scoring.ts`: `liquidity` dimension — a confirmed sweep whose pool id exists in the joined
   HTF frame's pools upgrades `liquidityContext` per spec-10 (f mapping stays spec-15's);
   `htfConflict` feeds the `htfAlignment` feature or a documented sub-contribution — exact slot
   per spec-15's single-dimension rule, decided at implementation (open question Q1).
5. `mtf.ts`: `causalAlignAt` post-vote rule — ITF close beyond `htfProtected*` level ends the
   aligned state at that bar (R3a). `barIndex` boundaries already make the check causal.
6. Diagnostics: none new beyond spec-31's `mtfFramesSkipped` — element absence is the existing
   honest-null path.

**Landed specifics:**
- Aux `FrameSource.at` supplies `{ structure, momentum, liquidity, zones, imbalances, events }`,
  memoized per joined bar index (pure cache — the join asks the same closed `idx` repeatedly).
- The cell's **own-role** frame supplies only the vote slice (`structure`/`momentum`) — the
  cell's own elements already reach consumers via `snap.pools/zones/imbalances` (same objects);
  duplicating them inside the frame view was unobserved and quadratically expensive.
- `ScoringSnapshot` gained `frames?: Record<FrameRole, JoinedFrame | null>`; the spec-15
  `liquidity` dimension reads `frames.htf.snapshot.liquidity` — a resting/approaching anchor
  pool overlapping an HTF-role pool band upgrades `0.5 → 1.0` (spec-10 "stronger evidence";
  1.0 is the table's only higher tier). Detector input types unchanged.
- `at(t)` calls `causalFramesAt` (for the `frames` payload) + `causalAlignAt` (which re-joins
  internally — its contract is untouched) at the same `barCloseTime` asOf. Redundant by design:
  memoized frame snapshots bound the cost to once per distinct closed frame bar.
- `zones.ts`: `analyzeZones`/`zoneStateAt` gained a trailing optional `htfAt` provider —
  `ZoneHtfProvider = (asOfMs) => { zones?, structure? } | undefined`, resolved at each zone's
  creation close via `barCloseTime`. `undefined` return = insufficient HTF history → the
  confluence feature redistributes (spec-05 unavailable rule).
- Perf guard: two spec-31 multi-run tests (J, I/J) got `15000ms` timeouts — full per-frame
  upstream chains legitimately ~2× the per-framed-run cost.

## 14. Test matrix

| ID | Requirement | Test |
| -- | ----------- | ---- |
| A | transport | framed run exposes frame pools/zones/imbalances/events bounded by `closedIndexAt` — `at(idx)` never sees an unclosed frame bar |
| B | `htfAligned` | cell demand zone inside HTF demand → flag set + confluence f=1.0; near → 0.5; opposing → 0 + `htfConflict` |
| C | absent frame parity | unframed run bit-identical to spec-32 baseline — no flags, weight redistributed |
| D | `liquidityContext` | ETF sweep of HTF-role pool scores stronger than same sweep of a cell-local pool |
| E | `htfProtected*` | ITF break of HTF protected level ends `aligned_*` at that bar; prefix run unaffected; re-alignment re-evaluates normally |
| F | causality | mutating frame bars after T changes nothing ≤T; frame events leak nothing earlier than their close |
| G | regression | existing 772-test baseline unchanged (framed scores may *change by design* only where HTF context is supplied — justified per §18 convention) |
| H | determinism | permuted frame supply + repeated runs identical |

## 15. Acceptance criteria

1. All spec-10 "HTF elements consumed" rules observable on records when frames are supplied.
2. `Zone.htfAligned`/`htfConflict`, `liquidityContext`, `htfProtected*` behave per spec-10/05/15.
3. Unframed runs bit-identical to the spec-32 baseline.
4. No changes to `classifyVotes`, the truth table, `alignmentScore` weights, or the spec-32 gate.
5. Additive test file; baseline preserved.

## 16. Scope

WILL: populate `FrameSnapshot` slots via existing frame `*StateAt` providers; surface joined frames
to consumers; implement `htfAligned`/`htfConflict`/`liquidityContext`/`htfProtected*`; activate the
spec-05 HTF-confluence weight when HTF zones exist; additive tests.

## 17. Non-scope

- No new detectors, lifecycle states, scoring dimensions, vote types, or alignment states.
- No `alignment`/frame persistence on records (spec-31 deferral stands — needs a spec-26 field
  decision; separate spec if ever wanted).
- No `regime.minBars` hysteresis (spec-19 condition — "if it proves noisy" — unmet).
- No spec-24 confidence intervals (deliberate deferral under a future `methodVersion`).
- No UI/service/realtime/persistence/ML/broker work; no changes to spec-10 vote semantics beyond
  the `htfProtected*` rule it defines.

## 18. Expected files

- `src/lib/engines/backtest.ts` — frame batch breadth + joined-frame propagation.
- `src/lib/engines/mtf.ts` — `htfProtected*` rule (R3a) only.
- `src/lib/engines/zones.ts` — optional HTF-context input → `htfAligned`/`htfConflict` + confluence.
- `src/lib/engines/scoring.ts` — `liquidityContext` uplift + `htfConflict` consumption.
- `src/lib/types/domain/*` — additive optional `frames` on detector inputs/`ScoringSnapshot` only.
- `src/lib/engines/__tests__/mtf-frame-elements.test.ts` — additive suite.
- Index rows (`docs/engine/README.md`, architecture map) at implementation time.

## 19. Baseline test count

Verified at authoring: **772/772 tests**, `tsc --noEmit` clean, ESLint clean, `next build` clean.

## 20. Open questions

- **Q1 — resolved (implemented).** `htfConflict` landed on the spec-05 `htfConfluence`
  feature's *opposing* leg — a cell zone inside an opposite-type HTF zone evaluates
  `f=0` (the spec-05 table's lowest tier, which *is* the penalty inside zone strength)
  plus the `zone.metadata.htfConflict: true` marker. It was NOT added to scoring's
  `htfAlignment` dimension — spec-15's 8 dimensions are canonical and `htfConflict` is
  positional (zone-in-opposing-zone, R4), not vote-level.
- **Q2 — resolved (implemented).** `htfProtected*` successor = `countertrend_*` — HTF bias
  intact but challenged. Implemented as a post-vote override inside `causalAlignAt`: when the
  classified state is `aligned_*`/`pullback_in_trend_*` and the ITF frame's `structure.breaks`
  contains a confirmed break whose `refPrice` crosses the HTF's `keyLevels.protected` price
  (a low in uptrend / high in downtrend), the state resolves to `countertrend_*` at that bar.
  Non-latching: each call re-evaluates the *current* protected level against ITF breaks — a
  newly-confirmed HTF level restores alignment naturally. Observable via
  `diagnostics.htfProtectedBroken`.

## 21. Alternatives rejected

| Candidate | Why not Spec 33 |
| --------- | --------------- |
| `regime.minBars` hysteresis (specs 19/27) | Conditional deferral — trigger "if it proves noisy in backtesting" has no recorded evidence; slot stays reserved |
| Spec-24 confidence intervals | Deliberately deferred; "a future spec **may** add" under new `methodVersion` — no trigger, no consumer pull |
| `alignment`/`alignmentScore` on records | Contract-extension decision pending spec-26 ownership (spec-31 §12); smaller than this surface and does not unblock consumers |
| `MarketRegimeSnapshot.strength` | Spec-19 display value, deliberately deferred; not an engine input |
| `supersedes` end-to-end | Implemented contract — caller supplies; `runBacktest` never produces corrections by design |
| Detector-level MTF features beyond spec-10's list | Speculative — no canonical naming |
| UI/service consumption of frames | All specs exclude service/UI scope |
