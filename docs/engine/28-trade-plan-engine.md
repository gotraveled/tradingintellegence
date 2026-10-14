# Spec 28 — Trade Plan Engine

## Status

Implementation closure of the **Spec 16 Trade Plan model** (`docs/engine/16-trade-plan.md`).
Spec 16 remains the canonical behavioral definition; this document specifies the deterministic
engine surface, the point-in-time contract, and the audit surface. Where they differ, the
shipped types and this document are authoritative for implementation.

## Purpose

Produce the `TradePlan` — the engine's structured answer to "if this setup resolves, what did
the evidence suggest?" — by **assembling** already-produced point-in-time artifacts. The setup
engines (12–14) stamped entry band, invalidation, ordered targets, and bar-indexed lifecycle
markers on `setup.metadata` at detection; spec 15 already decided the score (or vetoed it).
This engine joins those artifacts — it never re-derives levels, never scores, and never
touches candles.

A `TradePlan` is analysis, not advice: never an order, never broker-bound, never a position
size (spec 16 "what a plan is not").

## Scope

In scope: `buildTradePlan`, `planStateAt`, `createTradePlanEngine`, the `TradePlanEngine`
contract, and the `final?: boolean` terminal marker on `TradePlan`.

Out of scope: wiring `ScanCandidate.plan`, backtest/UI/opportunity enrichment, any spec-16
consumer integration — all deferred to Spec 29 (composition).

## Dependencies

| Dependency | Status |
|---|---|
| `Setup` + stamped metadata (`entryBand*`, `invalidation`, `targets`, `targetBars`, lifecycle bars) | implemented (specs 11–14) |
| `OpportunityScoreResult` (spec 15) | implemented |
| `LifecycleConfig.expiryBars` (spec 11) | implemented |
| `TradePlan` / `PriceTarget` / `ScoreContribution` / `SetupReason` types | implemented |
| `ScanCandidate.plan` (spec 25), backtest `plan` projection (spec 26) | consumers — caller-populated |

## Inputs

```ts
buildTradePlan(input: {
  setup: Setup;                     // stamped evidence + bar-indexed lifecycle markers
  score: OpportunityScoreResult;    // spec-15 output — authoritative score source
  atIndex: number;                  // PIT anchor: every stamp filtered by <= atIndex
  atMs?: UnixMs;                    // evaluation bar's wall-clock → plan.createdAt
  config: LifecycleConfig;          // expiryBars only
}): EngineResult<{ plan: TradePlan }>
```

## Derivation Rules

| Field | Derivation |
|---|---|
| `entryZone` | `{low: entryBandLow, high: entryBandHigh, basis}` — stamped values verbatim; `basis` composed from `setup.type` + stamped evidence ids (`zoneId`/`rangeKey`+`boundary`/`pullbackExtreme`). Never recomputed. |
| `invalidation` | `{price: metadata.invalidation, basis, closeOnly: true}` — `closeOnly` always `true` (spec 16). |
| `targets` | `metadata.targets` CSV → `{label: "T"+(i+1), price, reached}`; `reached = targetBars[i] <= atIndex`. |
| `riskReward` | `(finalTarget − mid) / (mid − invalidation)` bullish, mirrored bearish; `mid = (low+high)/2`. Non-positive risk → `invalid_input` (outcomes.ts convention). No `minRR` gate — spec 15 owns it upstream. |
| `score` / `scoreContributions` | `score.score` / `score.contributions` verbatim — mandatory; a gated/empty score → `unavailable`, never fabricated. |
| `reasons` | `setup.reasons` verbatim (unmutated). |
| `conditionsPending` | `reasons.filter(!met)` — emitted only when non-empty (shipped optional type is authoritative). |
| `expiryBars` | `config.expiryBars`. |
| `createdAt` | `atMs → ISO` when supplied; otherwise `setup.createdAt` (PIT-stable — stamped at `candidateBar`). |
| `final` | `true` when a terminal stamp (`targetReachedBar`/`invalidatedBar`/`expiredBar`/`cancelledBar`) `<= atIndex` — spec 16: terminal setups keep their plan for outcome measurement. |
| `paramsVersion` | `exp{expiryBars}` — consumed config fields only. |

## Status Reconstruction

`statusAt(t)` is derived exclusively from bar-indexed stamps filtered by `<= atIndex`:

- `confirmBar <= t` required — otherwise `unavailable` (developing/unconfirmed: no plan).
- Earliest terminal stamp `<= t` → terminal status, `final: true`.
- Otherwise `partialTargetBar <= t` → `partial_target`; `activeBar <= t` → `active`; else `confirmed`.

The setup's final `status`/`updatedAt` fields may encode post-`atIndex` transitions — they are
never consulted for the at(t) answer.

## Causal StateAt Contract

```ts
planStateAt(setup, score, atIndex, config): TradePlan | undefined
```

Thin composer over `buildTradePlan` — degrades non-ok results to `undefined`, never throws.
Causality is entirely inherited: the caller supplies the PIT setup artifact and the spec-15
score at `t`. A full-series setup whose future stamps exceed `atIndex` produces the identical
plan to a prefix-detected setup — future stamps are invisible by construction (`stamp <=
atIndex`).

## Outputs

`EngineResult<{ plan: TradePlan }>` — `stage: "plan"`, `events: []`,
`barsConsumed: {from: -1, to: -1}` (snapshot convention), diagnostics
`{statusAt, targetsTotal, targetsReached, final}`.

## Configuration

Consumed: `LifecycleConfig.expiryBars` — must be finite and `> 0`, else `invalid_config`.
`invalidateAtr` is unconsumed and unvalidated. `ScoringConfig.minRR` is **not** consumed —
the spec-15 `rr_below_min` veto is authoritative and happens upstream.

## Determinism

Pure function of `(setup, score, atIndex, atMs, config)` — no clocks, randomness, I/O, or
module state. Identical inputs → identical plan, always.

## Insufficient Data / Errors

| Condition | Code |
|---|---|
| `confirmBar` absent or `> atIndex` | `unavailable` |
| Score gated / score or contributions missing | `unavailable` |
| `entryBandLow`/`entryBandHigh`/`invalidation`/`targets` absent | `insufficient_data` |
| Non-finite stamped level, inverted band, malformed CSV, non-positive risk | `invalid_input` |
| `atIndex` non-integer/negative | `invalid_input` |
| `expiryBars` non-finite or `<= 0` | `invalid_config` |

## Downstream Consumers

`ScanCandidate.plan` (25) and backtest record `plan` (26) already accept a projected plan and
record it verbatim — wiring the producer into the at(t) join is Spec 29 composition, same as
`SetupOutcome.regime`/`ScoringSnapshot.regime`/`StatisticalDecision.regime` for spec 27.

## Integration Boundary

Producer-only. No imports beyond `@/lib/types` + `@/lib/services/engine`. No candle access,
no upstream recomputation, no downstream wiring, no persistence, no orders, no sizing, no
broker, no alerts, no ML.

## Test Requirements

Per the spec-22 matrix: all three setup families happy-path; lifecycle gating (pre-confirm
`unavailable`; each non-terminal status; every terminal → `final`); RR long/short incl.
zero/negative risk; target labels/order/`reached` under an `atIndex` sweep; every missing
stamp → `insufficient_data`; corrupt levels/CSV → `invalid_input`; config rejection; gated
score → `unavailable`; determinism; adapter parity; **prefix/full equivalence on a real
upstream detection replay** (`detectReversals` on truncated vs full series → identical plan
at `t`, full-series future stamps hidden).

## Non-Goals

No regime consumption (spec 27 unwired). No hysteresis or plan lifecycle. No re-derivation of
entry/invalidation/targets. No order/execution surface of any kind.

## Acceptance Criteria

- [x] `buildTradePlan`/`planStateAt`/`createTradePlanEngine` implemented per contract
- [x] `TradePlanEngine` declared in `engine.ts`; `final?: boolean` on `TradePlan`
- [x] Status/RR/targets/evidence semantics verified by 68 focused tests
- [x] Prefix/full causal equivalence proven on real `detectReversals` replay
- [x] 648 baseline + 68 = 716 tests green; typecheck/lint/build clean
- [x] No spec-29 wiring, no downstream modification

## Open Questions

None — the three discovery-phase questions resolved at reconciliation:
`final?: boolean` (R4), `invalid_input` on non-positive risk (Q2), `atMs`-with-`createdAt`
fallback to `setup.createdAt` (Q3).
