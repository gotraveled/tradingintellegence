# 15 — Opportunity Score

The 0–100 score measures **evidence quality** — how much of the required evidence for a setup is
present and how strong each piece is. It is **not** a probability of profit and must never be
displayed as one. `90/100 ≠ 90%`.

## Model

Additive dimension model — bounded contributions summed, then clamped to [0, 100]:

```
score = clamp(0, 100, Σ wᵢ · fᵢ)    with Σ max(wᵢ) = 100
```

Each dimension contributes `0 … wᵢ` (its max). `fᵢ ∈ [0, 1]` is the normalized feature value. All
weights are `score.weights.*` `EngineParams` — a different weight set = a different
`paramsVersion`, and scores are comparable only within one version.

## Dimensions (defaults — each documented, not arbitrary)

| Dimension      | Max                | f (0→1)                                                                                                                          | Why it exists                                                                                                              |
| -------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `structure`    | 20                 | trend agreement: aligned trend on setup TF = 1.0; transition = 0.4; opposing = 0                                                 | Structure is the foundation every setup is built on — highest weight.                                                      |
| `liquidity`    | 15                 | confirmed sweep = 1.0; developing sweep or pool proximity = 0.5; none = 0                                                        | Stops taken = fuel spent; the engine's core edge.                                                                          |
| `zoneQuality`  | 20                 | `zone.strength / 100` (05 scoring already normalized)                                                                            | The level the setup trades from — second pillar.                                                                           |
| `displacement` | 15                 | `displacementScore / 100` (09)                                                                                                   | Conviction of the confirming leg.                                                                                          |
| `momentum`     | 10                 | strengthening = 1.0; neutral = 0.5; weakening/diverging = 0                                                                      | Confirms the leg isn't already dying.                                                                                      |
| `htfAlignment` | 10                 | `aligned_*` = 1.0; `pullback_in_trend_*`/`realigning_*`/`htf_dominant` = 0.5; `countertrend_*`/`no_context`/`ltf_directed` = 0.2 | HTF context raises or caps quality.                                                                                        |
| `freshness`    | 5                  | fresh = 1.0; tested = 0.5; mitigated = 0.1                                                                                       | Untapped zones carry more residual orders.                                                                                 |
| `fvg`          | 5                  | open FVG on the confirming leg = 1.0; filled/other = 0.3; none = 0                                                               | Imbalance left behind = urgency evidence.                                                                                  |
| `riskReward`   | (gate, not scored) | —                                                                                                                                | RR is a _filter_: setups with `rr < score.minRR` (default 1.5) are dropped before scoring — RR must never inflate quality. |
| `marketRegime` | (modulator)        | —                                                                                                                                | Regime modulates weights ×0.5–1.5 by setup type — see below.                                                               |

## Rules

1. **Explainability is mandatory.** Every score carries `ScoreContribution[]` — per-dimension
   `weight`, `feature value`, `points`, and `signalIds` referencing the entities that produced it
   (zone id, sweep id, break id, fvg id, mtf state). A score without its contribution list is an
   engine error.
2. **No double counting.** The same evidence can feed only one dimension — e.g. the sweep feeds
   `liquidity`, not `structure`. Each dimension names its source signal set; the scorer asserts
   disjoint inputs.
3. **Regime modulation.** `marketRegime` (`trending`/`ranging`/`compressing`/`expanding`)
   multiplies each dimension's weight by a per-setup-type factor
   (`score.regimeMatrix.{regime}.{setupType}.{dimension}`), then renormalizes the sum to 100 —
   e.g. `htfAlignment` counts more for continuations in `trending`, less in `ranging`.
4. **Gates before scoring.** Hard vetoes never produce a score: `insufficient_data`,
   `countertrend` MTF, zone `invalidated`/`expired`, `rr < minRR`. They emit the setup's
   `developing`/`cancelled` state instead.
5. **Monotonic sanity.** Replacing any `fᵢ` with a weaker value must not raise the score — the
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
  feature: number; // fᵢ in [0,1]
  points: number; // weight × feature
  label: string; // human-readable "what this evidence is"
  signalIds?: ID[]; // entities that produced it
}
```

`Opportunity.score` = sum of `points`. The UI renders the breakdown — the user's example:

```
91/100
+18 Structure   +15 Liquidity   +18 Zone   +14 Displacement
+10 Momentum    +9 HTF Alignment +7 Freshness   (+0 FVG: none on the leg)
```

## Calibration & versioning

- Initial weights ship from _reasoned_ defaults (structure/zone dominant because the product's
  edge is location + evidence), **not** tuned on outcomes — there is no outcome data yet.
- Once the historical outcome dataset exists (16+), weights are **fit and reversioned** — the
  mechanism is weight-tuning, never score-rewriting.
- Scores are stamped with `paramsVersion` — comparability only within a version.

## Test requirements

- Score always in [0, 100]; contributions sum exactly to the score (± float epsilon).
- Every contribution lists signalIds resolvable to real entities.
- Gate fixtures: `countertrend` MTF → no score; `rr < minRR` → no score.
- Property: weakening any single feature never increases the score.
