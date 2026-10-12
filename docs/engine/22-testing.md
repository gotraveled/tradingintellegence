# 22 — Testing Specification

The goal is **deterministic reproducibility**: every engine produces identical output for
identical input + config, on every run, on every machine. Tests are defined before implementation
— the specs are the test contracts.

## Test architecture

| Layer           | What it proves                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Golden fixtures | A named candle sequence produces the exact expected entity list (prices, statuses, confirmation bars). Fixtures are data, not code — stored as serialized `CandleSeries` + expected output. |
| Property tests  | Invariants that must hold for _all_ inputs (listed per engine below).                                                                                                                       |
| Contract tests  | `EngineResult` shape: errors returned not thrown, `meta` complete, `paramsVersion` stamped.                                                                                                 |
| Replay tests    | `state(t)` prefix-truncation and walk-forward replay equality (spec 18).                                                                                                                    |

## The 14 required categories — fixture matrix

Every engine must have fixtures covering each applicable category:

| #   | Category            | Purpose                                                                                            |
| --- | ------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | `normal_market`     | Baseline: mixed trend + pullbacks, clean detections.                                               |
| 2   | `high_volatility`   | `atrTrend ≥ 1.5` — wide bars, fast swings; thresholds must still hold (ATR-normalised).            |
| 3   | `low_volatility`    | `atrTrend ≤ 0.7` — compressed ranges; no false signals from noise.                                 |
| 4   | `ranging_market`    | EQ-dominant swings, bounded band — structure `range`, no forced trend.                             |
| 5   | `gaps`              | Session gaps (equities/indices) — gap-through invalidation, first-close break rules.               |
| 6   | `equal_highs_lows`  | Within-`equalToleranceAtr` extremes — EH/EL classification, merged pools.                          |
| 7   | `overlapping_zones` | Nested/adjacent zones — both emitted, no merging, no double-count.                                 |
| 8   | `repeated_retests`  | 1st/2nd/multiple retest transitions, `penetrationDepthPct`, decay (07).                            |
| 9   | `false_breakout`    | Close beyond, re-enter within `holdBars` — `false_breakout`, never `sweep`.                        |
| 10  | `liquidity_sweep`   | Penetration → reclaim → displacement — full lifecycle incl. `aborted`.                             |
| 11  | `insufficient_data` | Fewer bars than any minimum — `insufficient_data` error, `ok: false`, **never** fabricated output. |
| 12  | `missing_volume`    | No volume field — volume-dependent features redistribute weight (05/09/15).                        |
| 13  | `asset_classes`     | BTC, XAUUSD, EURUSD, NIFTY, MSFT — ATR-normalised rules hold at every scale.                       |
| 14  | `timeframes`        | 15m / 1h / 4h / 1D — same rules, different bar counts; MTF closed-bar gating.                      |

## Per-engine required tests

| Engine                     | Golden fixtures                                                                                  | Properties                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `SwingEngine`              | clean pivots, equal-highs merge, superseded candidate, insufficient bars                         | `confirmedIndex > pivotIndex` always; outputs identical on truncation at any bar                                    |
| `MarketStructureEngine`    | uptrend chain, downtrend chain, CHOCH-and-fail, wick-through (no break), insufficient swings     | no BOS/CHOCH at bars > t in `state(t)`; never breaks when `transition`                                              |
| `LiquidityEngine`          | sell-side sweep, buy-side sweep, no-reclaim wick, close-through break, pool merge, expiry        | pools merge at same level; sweeps never visible before reclaim close                                                |
| `ZoneEngine`               | DBR, RBR, RBD, DBD, invalid base, timed-out departure, retest chain, gap-invalidated             | `remainingStrength ≤ strength`; `penetrationDepthPct` monotonic                                                     |
| `ImbalanceEngine`          | bullish/bearish FVG, tiny gap rejected, flat middle rejected, partial/filled/invalidated         | `gap ≥ minGapAtr × ATR` for every emitted FVG                                                                       |
| `DisplacementEngine`       | strong leg, wick-driven leg, no-volume leg, structure-breaking leg                               | score in [0,100]; monotonic in every input                                                                          |
| `MomentumEngine`           | strengthening, weakening, diverging, neutral                                                     | secondary features (rsi14) provably change nothing                                                                  |
| `MultiTimeframeEngine`     | all 27 vote combinations; (+,−,+) → `realigning_bull`; unclosed HTF bar                          | `realigning_*` never yields directional bias; HTF bar not closed never contributes                                  |
| `MarketRegimeEngine`       | each of 6 states, boundary `atrTrend` values                                                     | precedence table holds; single label always                                                                         |
| `SetupDetectionEngine`     | full reversal chain, full breakout chain, full continuation chain; every anti-fixture from 12–14 | no setup `confirmed` on a wick; `pullbackMaxPct` hard gate                                                          |
| `OpportunityScoringEngine` | scored setup + contribution list; every gate (countertrend, low RR, insufficient data)           | contributions sum to score; weakening any feature never raises score; scores only comparable within `paramsVersion` |
| `OutcomeEngine`            | activated→T3, invalidated at stop, expired unactivated, partial target                           | outcome rows never use bars before `confirmedAt + 1`; unactivated rows still emitted                                |
| `BacktestEngine`           | full-history run vs manual stage replay                                                          | pipeline result == stage-by-stage composition; identical across machines/platforms                                  |

## Reproducibility rules

- Tests pin `paramsVersion` — a config change means fixtures are re-golden'd deliberately, never
  silently.
- No wall-clock, no `Math.random`, no floating-order dependency — engines iterate in bar order.
- Fixture regeneration is a single documented command; diffs in golden output are review events.
- CI runs the full matrix — a spec change without a fixture change is a failing review.
