# 20 — Engine Interfaces

The pipeline decomposes into independently implementable, independently testable engines. Each is
a **pure function**: `(inputs, config) → EngineResult`. No shared mutable state, no hidden
dependencies — an engine receives exactly the upstream objects it needs.

## Shared contract

Every engine returns `EngineResult<T>` (`src/lib/services/engine.ts`):

| Field                | Contract                                                              |
| -------------------- | --------------------------------------------------------------------- |
| `ok`                 | `true` when `data` is present and usable.                             |
| `data`               | Stage output — domain types, never engine-private shapes.             |
| `errors`             | `EngineError[]` — expected conditions are **returned, never thrown**. |
| `meta.stage`         | Engine name — audit trail.                                            |
| `meta.paramsVersion` | Config version — comparability boundary.                              |
| `meta.barsConsumed`  | Input range used — proves no silent truncation.                       |
| `meta.events`        | `DetectionEvent[]` — what this run emitted (UI timeline / audit).     |
| `meta.diagnostics`   | Stage-specific counters (rejected candidates, weight redistribution). |

## Error codes (expected conditions are results, not exceptions)

| Code                | When                                                             | Correct response                                                                 |
| ------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `insufficient_data` | not enough closed bars, missing required field                   | Return with `ok: false` — the caller renders "insufficient data", never guesses. |
| `invalid_input`     | unsorted candles, duplicate identity, negative OHLC              | Hard reject — upstream contract violated.                                        |
| `invalid_config`    | weights don't sum to 1, negative windows                         | Hard reject — config bugs must be loud.                                          |
| `unavailable`       | upstream produced nothing usable (e.g. no swings → no structure) | Cascade `insufficient_data`-style — honest absence, not fabricated output.       |
| `internal`          | engine bug                                                       | Surfaced, never swallowed.                                                       |

## The engines

| Engine                     | Spec  | In                             | Out                             |
| -------------------------- | ----- | ------------------------------ | ------------------------------- |
| `SwingEngine`              | 02    | `CandleSeries`, `SwingConfig`  | `SwingPoint[]`                  |
| `MarketStructureEngine`    | 03    | + `swings`                     | `MarketStructure`               |
| `LiquidityEngine`          | 04    | + `structure`                  | `pools`, `events`               |
| `ZoneEngine`               | 05–07 | + `pools`                      | `Zone[]`                        |
| `ImbalanceEngine`          | 08    | `CandleSeries`                 | `Imbalance[]`                   |
| `DisplacementEngine`       | 09A   | leg bounds + series            | `score`, `components`           |
| `MomentumEngine`           | 09B   | `CandleSeries`                 | `Momentum` + `MomentumFeatures` |
| `MultiTimeframeEngine`     | 10    | per-TF `structure`+`momentum`  | `MultiTimeframeAlignment`       |
| `MarketRegimeEngine`       | 19    | `structure` + `features`       | `RegimeLabel`                   |
| `SetupDetectionEngine`     | 11–14 | all stage outputs              | `Setup[]`                       |
| `OpportunityScoringEngine` | 15    | `setup` + evidence             | `score` + `contributions`       |
| `OutcomeEngine`            | 17    | `setup`/`opportunity` + series | `SetupOutcome`                  |
| `BacktestEngine`           | 11–17 | series + `EngineConfig`        | `setups` + `outcomes`           |
| `StatisticalValidationEngine` | 24 | decision view + `SetupOutcome[]` | `ProbabilityEstimate`         |
| `ScannerEngine`            | 25    | PIT candidates + universe + filters | `ScanResult`              |

## Rules

- **Pure & deterministic.** No clocks, no randomness, no global state, no I/O. Side effects
  (persistence, logging) happen in the caller, never inside an engine.
- **Compose, don't embed.** `LiquidityEngine` doesn't re-detect swings — it consumes them. Each
  engine's inputs are exactly its declared dependencies.
- **Same version, comparable outputs.** `paramsVersion` on every `EngineMeta` ties a result to its
  config — two different configs produce results that must not be compared.
- **Independent testability.** Every engine has fixtures that run it alone with synthetic inputs —
  no engine requires the full pipeline to be exercised.
