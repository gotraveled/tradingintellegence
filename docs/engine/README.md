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
