# Market Intelligence Engine — Specification

Deterministic, testable contracts for the analysis engine. **Nothing here is implemented yet** —
these documents define what will be built and how it will be verified. The frontend consumes the
contracts in `src/lib/types/domain` and `src/lib/services`; it never implements these rules.

The engine is a separate, replaceable, independently testable component:

```
Frontend → API → Market Intelligence Engine → Market Data → Database
```

## Documents

| Doc                                                        | Scope                                                                                               | Status |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| [00-overview.md](00-overview.md)                           | Objective, deterministic pipeline, correctness principles                                           | Draft  |
| [01-market-data-contract.md](01-market-data-contract.md)   | Normalized candle model, candle identity, sessions, non-24/7 markets                                | Draft  |
| [02-swing-detection.md](02-swing-detection.md)             | Deterministic swing highs/lows, lifecycle, no look-ahead                                            | Draft  |
| [03-market-structure.md](03-market-structure.md)           | HH/HL/LH/LL + EH/EL classification, trend state, BOS/CHOCH, failed breaks                           | Draft  |
| [04-liquidity.md](04-liquidity.md)                         | Pool detection, LiquidityPool, sweeps vs breakouts vs false breakouts                               | Draft  |
| [05-demand-zones.md](05-demand-zones.md)                   | DBR/RBR origin, boundaries, freshness/retests, strength score model                                 | Draft  |
| [06-supply-zones.md](06-supply-zones.md)                   | RBD/DBD mirror, deliberate asymmetries vs forced symmetry                                           | Draft  |
| [07-zone-freshness.md](07-zone-freshness.md)               | Retest state machine, penetration depth, remaining strength decay                                   | Draft  |
| [08-imbalances.md](08-imbalances.md)                       | FVG 3-candle rule, ATR-normalised gaps, fill tracking, invalidation                                 | Draft  |
| [09-momentum.md](09-momentum.md)                           | Normalized displacement score, minimal momentum feature set                                         | Draft  |
| [10-multi-timeframe.md](10-multi-timeframe.md)             | HTF/ITF/ETF roles, confluence-conflict truth table                                                  | Draft  |
| [11-setup-lifecycle.md](11-setup-lifecycle.md)             | Universal state machine: developing→confirmed→active→partial_target/target_reached, terminal states | Draft  |
| [12-reversal-setups.md](12-reversal-setups.md)             | Bullish/bearish reversal condition tables, entry band, invalidation, targets                        | Draft  |
| [13-breakout-setups.md](13-breakout-setups.md)             | Range/compression/break/acceptance/retest; vs sweeps and false breakouts                            | Draft  |
| [14-continuation-setups.md](14-continuation-setups.md)     | Trend+impulse+pullback quality; healthy pullback vs reversal signatures                             | Draft  |
| [15-opportunity-score.md](15-opportunity-score.md)         | 0–100 evidence-quality score, explainable contributions, regime modulation                          | Draft  |
| [16-trade-plan.md](16-trade-plan.md)                       | Structured analytical plan — never execution or recommendation                                      | Draft  |
| [17-outcomes.md](17-outcomes.md)                           | Historical outcome model, R-multiples, ML dataset schema                                            | Draft  |
| [18-look-ahead.md](18-look-ahead.md)                       | Per-feature confirmation bars, no-look-ahead verification rules                                     | Draft  |
| [19-regime.md](19-regime.md)                               | 6-state market regime label with deterministic precedence                                           | Draft  |
| [20-engine-interfaces.md](20-engine-interfaces.md)         | Per-engine contracts: inputs, outputs, errors, metadata, versioning                                 | Draft  |
| [21-configuration.md](21-configuration.md)                 | Named config objects — no magic numbers, versioned parameter sets                                   | Draft  |
| [22-testing.md](22-testing.md)                             | 14-category fixture matrix + per-engine required tests                                              | Draft  |
| [23-contested-definitions.md](23-contested-definitions.md) | V1 vs alternative definitions — no overfitting, parameters decide by backtest                       | Draft  |
| [24-statistical-validation.md](24-statistical-validation.md) | Empirical outcome probabilities over the spec-17 dataset — expanding walk-forward history, cohorts, labels | Draft  |
| [25-scanner-opportunity-discovery.md](25-scanner-opportunity-discovery.md) | Opportunity discovery & ranking over caller-produced PIT candidates — eligibility, filters, deterministic ordering | Draft  |
| [26-system-backtesting.md](26-system-backtesting.md) | System-level historical backtesting — orchestration, frozen records, Model-B outcome pass, aggregation | Draft  |
| [27-market-regime-engine.md](27-market-regime-engine.md) | Market regime engine — implementation closure of the spec-19 6-state `RegimeLabel` model (spec 19 remains the behavioral authority) | Draft  |
| [28-trade-plan-engine.md](28-trade-plan-engine.md)       | Trade plan engine — implementation closure of the spec-16 `TradePlan` model; pure snapshot assembler over stamped setup evidence + spec-15 score | Draft  |
| [29-pipeline-composition.md](29-pipeline-composition.md) | Pipeline composition — wires spec-27 regime into `at(t)`/`ScoringSnapshot.regime`, spec-28 plans into `ScanCandidate.plan`, outcome `regime`/`scoreAtDetection` anchors | Draft  |
| [30-statistical-evidence-composition.md](30-statistical-evidence-composition.md) | Statistical evidence composition — wires spec-24 `estimateProbability` into `runBacktest`, populating `ScanCandidate`/`BacktestOpportunity.statisticalEvidence` at the `confirmBar` decision anchor | Draft  |
| [31-mtf-alignment-composition.md](31-mtf-alignment-composition.md) | MTF alignment composition — wires spec-10 `causalAlignAt` into the `at(t)` join via additive `BacktestCell.frames`, populating the dormant detector-input and `ScoringSnapshot.alignment` slots | Draft  |
| [32-mtf-confirmation-gate.md](32-mtf-confirmation-gate.md) | MTF confirmation gate — enforces spec-10's direction-signed `alignmentScore ≥ 0.8` rule at `developing → confirmed` in all three lifecycle detectors; unmet `C10`/`B9`/`N8` `multi_timeframe` reason while blocked | Draft  |
| [33-mtf-frame-element-composition.md](33-mtf-frame-element-composition.md) | MTF frame-element composition — populates the declared `FrameSnapshot` transport slots (`liquidity`/`zones`/`imbalances`/`events`) and activates spec-10's "HTF elements consumed" consumers (`htfAligned`, `htfConflict`, `liquidityContext`, `htfProtected*`) | Draft  |
| [34-mtf-record-evidence.md](34-mtf-record-evidence.md) | MTF record evidence — freezes the causal join's `at(t).alignment` onto `BacktestOpportunity`/`BacktestDeveloping` at emit time; absent (never null) on unframed runs | Draft  |
| [35-outcome-feature-vector.md](35-outcome-feature-vector.md) | Outcome feature-vector completion — closes spec-17's declared `featureVector` breadth (`swing.*`/`zone.*`/`disp.score`/`momentum.*`/`mtf.*`/`regime.*` + `score.*`), all anchored at the existing `at(confirmBar)` join | Draft  |

## Series status

**The canonical engine specification series is closed at spec 35.** Spec-36 discovery (specs
00–35 inventoried; deferred surfaces reassessed) found no candidate satisfying the activation
rule — every canonical contract with a production consumer is closed. Spec 36 is therefore not
an implementation specification.

Deferred surfaces stay deferred and must not be silently activated — including spec-24's MTF
cohort axis, confidence intervals, smoothing/decay/rolling windows, and censoring correction;
spec-19's `regime.minBars` hysteresis slot and display-only `MarketRegimeSnapshot.strength`;
`FrameSnapshot.events` detector consumption; `zone.metadata.htfConflict` scoring consumption;
`ScanCandidate.alignment`; and `SetupOutcome.market` population. Dataset persistence,
calibration, and out-of-sample methodology remain product/methodology concerns, not engine
contracts.

**Future activation rule:** a new specification may be created only when a concrete production
consumer creates a genuine dependency on a deferred capability — identify the consumer, the
exact missing contract, and why existing contracts cannot satisfy it. Causal/PIT guarantees
must be preserved; closed specs are not reopened unless the new requirement demonstrably
changes an existing canonical contract.

## Spec coverage

All requested sections (1–29) are drafted. The architectural map is
[`docs/architecture/market-intelligence-engine.md`](../architecture/market-intelligence-engine.md).
Engine contracts live in `src/lib/services/engine.ts`, config types in
`src/lib/types/domain/config.ts`, and the fixture contract in `src/lib/testing/` — interfaces and
types only, no algorithms. Next step: implementation against these contracts, validated by the
golden fixture suite.

## Ground rules for every spec

1. **Deterministic.** Same input candles + parameters → identical output. No randomness, no
   hidden state, no wall-clock dependence.
2. **Testable.** Every rule names its parameters, its edge cases, and the candle at which its
   output becomes visible (point-in-time semantics for backtesting).
3. **No subjective terms.** "Strong", "good", "high probability" are never outputs. The engine
   emits numbers and enumerable states; interpretation happens in scoring.
4. **Parameterised.** Every threshold is an explicit, versioned parameter with a documented
   default — never a magic constant inside logic.
