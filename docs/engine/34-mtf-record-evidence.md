# 34 — MTF Alignment Evidence on Backtest Records

Status: Implemented — 800/800 tests (`mtf-record-evidence.test.ts`, 10 additive), tsc/ESLint/
`next build` clean.

Implementation-closure spec: persist the point-in-time `MultiTimeframeAlignment` observation on
frozen backtest records — the approved closure of the record-persistence contract deferred by
name in specs 31 (§12), 32 (§9), and 33 (§17/"Alternatives rejected").

## 1. Title

MTF record evidence — stamp the causal join's `at(t).alignment` onto `BacktestOpportunity` and
`BacktestDeveloping` at emission time, verbatim.

## 2. Classification

- **Type:** record-contract extension + emit-time population (additive optional field).
- **Not:** a producer spec (no MTF computation changes), a scoring spec (the field is never
  re-derivable input), or a persistence spec (records remain in-memory results — no storage).
- **Behavioral authorities:** spec 10 (`MultiTimeframeAlignment` shape + semantics), spec 26
  (frozen record contract, emission timing), spec 31 (causal join producing `at(t).alignment`),
  spec 33 (the `htfProtected*` post-vote rule whose states this spec persists).

## 3. Canonical source references

| Source | Statement | Status |
| ------ | --------- | ------ |
| spec-10 | `MultiTimeframeAlignment { symbol, timeframes, votes, sources, alignmentScore, state, computedAt }` — the composed MTF observation | produced by `causalAlignAt` since spec 10 |
| spec-31 §12 "Deferred items" | "`alignment`/`alignmentScore` fields on records/outcomes" | **explicitly deferred — this spec closes it** |
| spec-32 §9 non-scope | "Record `alignment` fields — non-scope" | reaffirmed deferral |
| spec-33 §17 non-scope | "No `alignment`/frame persistence on records (spec-31 deferral stands — needs a spec-26 field decision)" | spec-26 field decision made — this spec |
| spec-26 §"Frozen records" | records freeze at emission per bar; only `outcomeRef` may stamp post-emit | `alignment` respects: frozen at emit, never mutated after |

## 4. Problem statement

Every framed backtest run already computes `at(t).alignment` — the point-in-time
`MultiTimeframeAlignment` consumed by detectors (spec-31), scoring (`htfAlignment` dimension),
and the spec-32 confirmation gate. But the **frozen record carries none of it**: a
`BacktestOpportunity` at bar `t` records `rank`/`score`/`statisticalEvidence` while the MTF
evidence that produced those numbers evaporates. Auditing *why* a setup was scored/gated a
certain way requires re-running the pipeline to reconstruct the join — the record is not
self-evidencing.

The contract was deferred three times pending a spec-26 field ownership decision. This spec is
that decision: the field is an **optional frozen observation**, not authoritative state.

## 5. Contract additions

```ts
// src/lib/types/domain/backtest-system.ts
interface BacktestOpportunity {
  /* …existing fields… */
  /** Spec-34: frozen PIT observation of the causal join's at(t).alignment AT this
   *  evaluation bar — the spec-10 object verbatim, never recomputed or persisted as
   *  authoritative state. Absent when no frames were supplied (unframed parity). */
  alignment?: MultiTimeframeAlignment;
  outcomeRef?: ID;
}

interface BacktestDeveloping {
  /* …existing fields… */
  /** Spec-34: frozen PIT alignment observation — same semantics as
   *  BacktestOpportunity.alignment; auditable evidence for the spec-32 gate. */
  alignment?: MultiTimeframeAlignment;
  outcomeRef?: ID;
}
```

- **Full canonical object** — `MultiTimeframeAlignment` from `src/lib/types/domain/analysis.ts`.
  No reduced alignment type: the approved decision is the verbatim spec-10 object, so the
  record carries votes, per-role `sources`, the weighted `alignmentScore`, the classified
  `state`, and `computedAt` exactly as the join produced them.
- **Optional, additive** — `?` on both interfaces; absence is the unframed semantic.
- **Both record kinds** — developing records carry it because the spec-32 gate writes
  `multi_timeframe` unmet-reasons onto exactly those records; the alignment is the gate's
  own evidence and belongs beside the reason.

## 6. Emit-time population

`runBacktest` Phase B (`src/lib/engines/backtest.ts`):

```text
per eval bar t:
  joinAt() — lazily memoized at(t)             ← ONE causal join per bar, shared by
  │                                              scoring (snap) and record emission
  ├─► snap: { provenance: "at_bar", ...joinAt() } → scoreOpportunity
  │
  └─► after scan succeeds:
      const recAlignment = hasMtf ? joinAt().alignment : undefined;
      → spread onto every emitted record for this bar:
        ...(recAlignment !== undefined ? { alignment: recAlignment } : {})
```

- `hasMtf` (= `mtfRoles !== undefined` from Phase A context) gates the join on framed cells
  only — unframed cells never pay the join cost and never touch the key.
- `causalAlignAt`/`causalFramesAt` are invoked **at most once per bar** per `joinAt` — the
  record's `alignment` is the *same object the scorer consumed*, not a second computation.
  Before spec 34, `at(t)` was invoked once per scoreable setup per bar; the memoized `joinAt`
  is a strict reduction, so no recomputation was introduced — an existing recomputation was
  removed.
- The conditional spread `...(x !== undefined ? { alignment: x } : {})` emits **key-absent**
  on unframed cells — not `alignment: undefined`. `Object.keys`/`hasOwnProperty`/`JSON.stringify`
  on an unframed record show no trace of the field (hard parity).

## 7. Point-in-time semantics

- The stored object is the frozen observation **at `evaluatedAt`** — the same bar the
  `scoreContributions`/`statisticalEvidence`/`plan` fields were decided at. It is not an
  authoritative MTF record; `computedAt` inside it reflects frame-snapshot `updatedAt`
  stamps, bounded by `closedIndexAt` as always.
- **No future information:** the join resolves frames via `closedIndexAt(asOf)` — frame
  bars closing after the eval close cannot appear. Verified by the truncation test (§9 E).
- **Prefix stability:** truncating *frame* series changes nothing for records ≤ T
  (bit-identical, alignment included). Truncating the *cell* series legitimately changes
  the cell's own producers at its right edge — unconfirmed pending swings resolve
  differently — which the field records honestly; equality is asserted inside the
  confirmed-data region.
- **Frozen:** the field is set inside the record literal at `opportunities.push` /
  `developing.push` and is never touched again. The only sanctioned post-emit mutation in
  the function remains spec-26's `outcomeRef` join.
- **Determinism / permutation invariance:** frame-role key order and repeated runs produce
  identical records (§9 F).

## 8. Unframed parity and partial-frame semantics

- **`mtfRoles === undefined` ⇒ `record.alignment === undefined` and key-absent.** Never
  `null`, never a `neutral`/synthetic/default object. Absence is the semantic.
- **Partial frames record exactly what the producer returns:** an etf-only run emits
  `state: "ltf_directed"` with `votes.htf === 0` and no `sources.htf` — votes of absent roles
  are `0`, never fabricated. No normalization layer sits between the join and the record.
- **Spec-33 composition visible:** when `htfProtected*` fires, the record carries
  `countertrend_*` — e.g. `votes: {htf:-1, itf:-1, etf:-1}` with `state: "countertrend_bull"`,
  a combination `classifyVotes` alone can never produce. The test verifies the state appears
  at exactly the bars where the ITF break is confirmed (cell bar 47–48) and never before.

## 9. Test matrix — `src/lib/engines/__tests__/mtf-record-evidence.test.ts`

| ID | Requirement | Test |
| -- | ----------- | ---- |
| A | ranked records carry the object | every `BacktestOpportunity.alignment` is defined, symbol/timeframes match config, `state ∈` the canonical set, `alignmentScore` is internally coherent with `votes`, `computedAt ≤ evaluatedAt + tfMs` |
| B | developing records carry it | etf-only run — spec-32 gate emits `multi_timeframe` unmet-reason records that carry the very `alignment` whose signed `alignmentScore < 0.8` blocked them |
| C | unframed parity | unframed run: `hasOwnProperty("alignment") === false` on every record; `JSON.stringify` contains no `alignment` key |
| D | partial frames verbatim | etf-only → `ltf_directed` + zero-vote absent roles + no fake `sources`; opposing etf → honest votes/score coherence |
| E | prefix causality | frames truncated at a wall-clock boundary → records ≤ T bit-identical to full run; cell truncation → identical inside the confirmed-data region |
| F | determinism | repeated runs + reversed `frames` key order → identical record arrays |
| G | spec-33 protected state | `bearProt` 4h frame reaches `downtrend` + `protected: 97.4`; the cell's bullish CHOCH @47 crosses it → records at bars 47–48 carry `countertrend_bull` with all-bearish votes (override fingerprint); never countertrend before 47 |
| H | existing fields unchanged | `rank`, `score`, `statisticalEvidence.decisionTime ≤ evaluatedAt`, `outcomeRef`, `selected`, `reasons` (unmet-only) semantics verified on framed records; two framed runs stripped of `alignment` compare equal — the field never feeds back |
| I | record-shape parity | `Object.keys` of every record ⊆ the canonical field set ∪ `{alignment}` — no unrelated fields appear |

## 10. Boundaries

- **`SetupOutcome` gets no `alignment`** — explicitly deferred (same as spec-33's deferral
  posture; outcome-row shape stays spec-17 canonical).
- **`FrameSnapshot.events` are not wired into `BreakoutInput.events`** — that routing
  ambiguity remains a separate future decision (spec-13's note names it, spec-33 deferred it).
- **No new MTF states, vote types, scoring dimensions, or statistical cohorts.** The field is
  a transport of an existing object onto a record — nothing downstream consumes it in-engine.
- **Closed contracts untouched:** `scanner.ts`, `ScanCandidate`, `ScannedOpportunity`,
  `SetupRef`, `mtf.ts` (`causalAlignAt`/`causalFramesAt`/`classifyVotes`), all three detectors,
  `scoring.ts`/`scoreOpportunity`, `statistics.ts`/`estimateProbability`, `outcomes.ts`/
  `measureOutcome`, `planStateAt`, `regimeStateAt` — verified unchanged.
- No UI/service/persistence/database/broker/live-data work.

## 11. Files changed

- `src/lib/types/domain/backtest-system.ts` — `alignment?: MultiTimeframeAlignment` on both
  record types + the type import. Doc comments state the frozen-PIT semantics.
- `src/lib/engines/backtest.ts` — `hasMtf` on the cell context; per-bar lazy `joinAt`;
  `recAlignment` computed once per bar and conditionally spread onto both record kinds.
  ~15 production LOC.
- `src/lib/engines/__tests__/mtf-record-evidence.test.ts` — additive suite (10 tests).
- `src/lib/engines/__tests__/mtf-composition.test.ts` — one `20000ms` timeout annotation on
  spec-31 test A (parallel-load flake; no assertion change). Same convention spec-33 used
  for its own multi-run tests.
- `docs/engine/34-mtf-record-evidence.md` (this file) + README index row.

## 12. Acceptance criteria

1. Framed runs stamp `record.alignment` = the exact `at(t).alignment` object at emit time.
2. Unframed runs: key absent — output parity apart from the optional field's non-presence.
3. Partial-frame states recorded verbatim (`ltf_directed`, honest `0` votes).
4. Spec-33 `countertrend_*` (from `htfProtected*`) persists at the causally-correct bars.
5. Prefix/determinism/permutation invariance hold on records including the new field.
6. Only the optional field is added; every other field's semantics unchanged.
7. Baseline test count preserved plus additive tests: **800/800**.
