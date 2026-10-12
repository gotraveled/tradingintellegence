# 15 â€” Opportunity Score

The 0â€“100 score measures **evidence quality** â€” how much of the required evidence for a setup is
present and how strong each piece is. It is **not** a probability of profit and must never be
displayed as one. `90/100 â‰  90%`.

## Model

Additive dimension model â€” bounded contributions summed, then clamped to [0, 100]:

```
score = clamp(0, 100, Î£ wáµ¢ Â· fáµ¢)    with Î£ max(wáµ¢) = 100
```

Each dimension contributes `0 â€¦ wáµ¢` (its max). `fáµ¢ âˆˆ [0, 1]` is the normalized feature value. All
weights are `score.weights.*` `EngineParams` â€” a different weight set = a different
`paramsVersion`, and scores are comparable only within one version.

## Dimensions (defaults â€” each documented, not arbitrary)

| Dimension      | Max                | f (0â†’1)                                                                                                                          | Why it exists                                                                                                              |
| -------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `structure`    | 20                 | trend agreement: aligned trend on setup TF = 1.0; transition = 0.4; opposing = 0                                                 | Structure is the foundation every setup is built on â€” highest weight.                                                      |
| `liquidity`    | 15                 | confirmed sweep = 1.0; developing sweep or pool proximity = 0.5; none = 0                                                        | Stops taken = fuel spent; the engine's core edge.                                                                          |
| `zoneQuality`  | 20                 | `zone.strength / 100` (05 scoring already normalized)                                                                            | The level the setup trades from â€” second pillar.                                                                           |
| `displacement` | 15                 | `displacementScore / 100` (09)                                                                                                   | Conviction of the confirming leg.                                                                                          |
| `momentum`     | 10                 | strengthening = 1.0; neutral = 0.5; weakening/diverging = 0                                                                      | Confirms the leg isn't already dying.                                                                                      |
| `htfAlignment` | 10                 | `aligned_*` = 1.0; `pullback_in_trend_*`/`realigning_*`/`htf_dominant` = 0.5; `countertrend_*`/`no_context`/`ltf_directed` = 0.2 | HTF context raises or caps quality.                                                                                        |
| `freshness`    | 5                  | fresh = 1.0; tested = 0.5; mitigated = 0.1                                                                                       | Untapped zones carry more residual orders.                                                                                 |
| `fvg`          | 5                  | open FVG on the confirming leg = 1.0; filled/other = 0.3; none = 0                                                               | Imbalance left behind = urgency evidence.                                                                                  |
| `riskReward`   | (gate, not scored) | â€”                                                                                                                                | RR is a _filter_: setups with `rr < score.minRR` (default 1.5) are dropped before scoring â€” RR must never inflate quality. |
| `marketRegime` | (modulator)        | â€”                                                                                                                                | Regime modulates weights Ã—0.5â€“1.5 by setup type â€” see below.                                                               |

## Rules

1. **Explainability is mandatory.** Every score carries `ScoreContribution[]` â€” per-dimension
   `weight`, `feature value`, `points`, and `signalIds` referencing the entities that produced it
   (zone id, sweep id, break id, fvg id, mtf state). A score without its contribution list is an
   engine error.
2. **No double counting.** The same evidence can feed only one dimension â€” e.g. the sweep feeds
   `liquidity`, not `structure`. Each dimension names its source signal set; the scorer asserts
   disjoint inputs.
3. **Regime modulation.** `marketRegime` (`trending`/`ranging`/`compressing`/`expanding`)
   multiplies each dimension's weight by a per-setup-type factor
   (`score.regimeMatrix.{regime}.{setupType}.{dimension}`), then renormalizes the sum to 100 â€”
   e.g. `htfAlignment` counts more for continuations in `trending`, less in `ranging`.
4. **Gates before scoring.** Hard vetoes never produce a score: `insufficient_data`,
   `countertrend` MTF, zone `invalidated`/`expired`, `rr < minRR`. They emit the setup's
   `developing`/`cancelled` state instead.
5. **Monotonic sanity.** Replacing any `fáµ¢` with a weaker value must not raise the score â€” the
   test suite asserts it.

## Explainable output shape

```ts
interface ScoreContribution {
  dimension:
    | "structure"
    | "liquidity"
    | "zoneQuality"
    | "displacement"
    | "momentum"
    | "htfAlignment"
    | "freshness"
    | "fvg";
  weight: number; // max points (after regime modulation)
  feature: number; // fáµ¢ in [0,1]
  points: number; // weight Ã— feature
  label: string; // human-readable "what this evidence is"
  signalIds?: ID[]; // entities that produced it
}
```

`Opportunity.score` = sum of `points`. The UI renders the breakdown â€” the user's example:

```
91/100
+18 Structure   +15 Liquidity   +18 Zone   +14 Displacement
+10 Momentum    +9 HTF Alignment +7 Freshness   (+0 FVG: none on the leg)
```

## Calibration & versioning

- Initial weights ship from _reasoned_ defaults (structure/zone dominant because the product's
  edge is location + evidence), **not** tuned on outcomes â€” there is no outcome data yet.
- Once the historical outcome dataset exists (16+), weights are **fit and reversioned** â€” the
  mechanism is weight-tuning, never score-rewriting.
- Scores are stamped with `paramsVersion` â€” comparability only within a version.

## Test requirements

- Score always in [0, 100]; contributions sum exactly to the score (Â± float epsilon).
- Every contribution lists signalIds resolvable to real entities.
- Gate fixtures: `countertrend` MTF â†’ no score; `rr < minRR` â†’ no score.
- Property: weakening any single feature never increases the score.

## Implementation notes (Phase 5)

- **Entry points.** `scoreOpportunity({setup, atBar, atMs?, snap, config})` is the causal path —
  callers pass the setup state and upstream objects legally visible at `atBar`. The contract
  adapter `createOpportunityScoringEngine()` evaluates at the setup's stamped
  `metadata.confirmBar` (spec 16: "evidence quality at confirmation"); a confirmed setup without
  the stamp gates `insufficient_data` rather than guessing a bar.
- **Gates (§4) ? `OpportunityScoreResult.gate`, never a score.** `unconfirmed` (developing) and
  `terminal` (target_reached/invalidated/expired/cancelled) guard lifecycle — spec 16 bounds
  plans/scores to confirmed/active/partial_target. `countertrend`, `zone_dead` (anchor zone
  invalidated/expired at t), `rr_below_min`, `insufficient_data` are the spec-named vetoes.
  `emittedStatus` records what the veto emits: the setup's own terminal state, `cancelled` for a
  dead anchor zone (evidence basis gone), `developing` for the rest.
- **RR** uses spec 16's formula: `(finalTarget - entryZone.mid)/(entryZone.mid - invalidation)`,
  mirrored for shorts, where the zone mid is the setup's `entryBand` midpoint and `finalTarget`
  is the last ordered target. `rr === minRR` passes (spec says `<`).
- **Anchor resolution** reads the setup's recorded evidence only: `zoneIds[0]`/`zoneId`,
  `poolId`/`anchorPoolId`/`liquidityEventIds[0]`, `fvgId`, `dispScore`. Nothing is re-derived
  from candles. Continuation setups carry no liquidity evidence ? `liquidity` scores 0
  (spec's `none` bucket); `t3PoolId` is a *target*, never fed to `liquidity`.
- **FVG dimension**: the recorded `fvgId` resolves first; without one, reversal scans
  `[sweepBar, t]` and breakout scans `[attemptBar, t]` for a direction-matching FVG — the
  "confirming leg" per specs 12/13. Continuation does not scan: its qualifying FVG is the
  recorded anchor, or there is none. `open`/`partially_filled` = 1.0, filled/other = 0.3, none = 0.
- **Causality.** Pool/zone/FVG statuses at `t` come from bar-indexed stamps only
  (`sweepConfirmedBar`, `brokenBar`, `invalidatedBar`, `expiredBar`, `createdBar`, `filledBar`,
  `invalidatedAt` — via shared `poolStatusAt`/`imbStatusAt`/`zoneStatusAt`); a stamped future
  transition restores the earlier status, an un-stamped terminal stays terminal. `zone.freshness`
  and `zone.strength` are snapshot fields — on the contract path they read as final values;
  historical runs must drive the causal join (`zoneStateAt`) for exact per-bar freshness.
- **Path separation is explicit.** `ScoringSnapshot.provenance` is a required `"at_bar" |
  "snapshot"` discriminator — the caller must declare where its upstream objects came from, and
  `meta.diagnostics.path` records the declaration on every result (scored or gated). Historical
  validation must use `at_bar` (per-bar causal providers); the contract adapter declares
  `snapshot` unconditionally, so a convenience-path score can never masquerade as authoritative
  historical output.
- **Regime modulation** (§3): factors `regimeMatrix[regime][setupType][dimension]`, validated
  within [0.5, 1.5]. `RegimeLabel` (spec 19's 6 states) maps to the matrix's 4 family keys:
  `trending_*`?trending, `ranging`?ranging, `high_volatility`?expanding,
  `low_volatility`?compressing, `transition`/absent ? identity. Exact-label keys also work.
  Effective weights renormalize so S max = 100.
- **Structure `range`**: the table maps aligned/transition/opposing only — `range` reads as
  `transition` (0.4, "no directional agreement"), the smallest consistent choice; breakout
  setups are range-native so this matters.
- **Missing data**: absent zone/pool/fvg/dispScore score their `none` bucket (0), absent
  alignment reads `no_context` (0.2); missing `structure` or `momentum` gates
  `insufficient_data`.
- **Precision**: `weight`/`points` rounded to 4 dp; `score = clamp(0,100, Spoints)` rounded 4 dp —
  contributions sum exactly to the score within float epsilon.
- **Upstream additions (additive metadata only, no behavior change)**: `reversal.ts` and
  `breakout.ts` now stamp `metadata.confirmBar` at confirmation (4J already did); `imbStatusAt`
  is exported from `continuation.ts` as the shared causal FVG-status helper.
- **Disjoint inputs (§2)** asserted — each entity id may appear in at most one contribution's
  `signalIds` (the anchor zone id is reported under `zoneQuality` only; `freshness` derives from
  the same entity without re-claiming the signal).
- **Not implemented here**: `Opportunity`/TradePlan materialization (spec 16), outcome/historical
  validation (spec 17), any weight fitting. The score is evidence quality, not a probability.
