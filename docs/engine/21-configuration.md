# 21 — Configuration

All thresholds live in **named, typed, versioned config objects** — `src/lib/types/domain/config.ts`.
Magic numbers inside engine logic are forbidden: a threshold that isn't a named parameter is a bug.

## The objects (one per spec area)

| Config                                                     | Spec  | Governs                                                                                       |
| ---------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| `SwingConfig`                                              | 02    | `leftBars`, `rightBars`, `atrLength`, `minSignificanceAtr`, `equalToleranceAtr`, `mergeEqual` |
| `StructureConfig`                                          | 03    | `classifyToleranceAtr`, `minBreakAtr`, `failedBreakBars`, `minSwingsForTrend`                 |
| `LiquidityConfig`                                          | 04    | pool/cluster/sweep/break thresholds, `poolExpiryBars`                                         |
| `ZoneConfig`                                               | 05–07 | base/departure/retest windows, `boundaryMode`, `gapInvalidates`, `sideOverrides`, `weights`   |
| `FVGConfig`                                                | 08    | `minGapAtr`, `minMidBodyAtr`, `partialFillPct`, `invalidateAtr`                               |
| `MomentumConfig`                                           | 09    | lookbacks, `disp` windows + weights                                                           |
| `MTFConfig`                                                | 10    | timeframe `set`, per-frame `weights`                                                          |
| `LifecycleConfig`                                          | 11    | `expiryBars`, `invalidateAtr`                                                                 |
| `ReversalConfig` / `BreakoutConfig` / `ContinuationConfig` | 12–14 | all per-setup thresholds                                                                      |
| `ScoringConfig`                                            | 15    | `minRR`, dimension `weights`, `regimeMatrix`                                                  |
| `RegimeConfig`                                             | 19    | `expandAtrTrend`, `compressAtrTrend`, `minBars`                                               |
| `StatsConfig`                                              | 24    | `minSamples`, `scoreBands`, `methodVersion`                                                 |
| `ScannerConfig`                                            | 25    | `topK`, `includeDeveloping`                                                                 |
| `BacktestConfig`                                           | 26    | `methodVersion`                                                                             |
| `EngineConfig`                                             | —     | The whole set + `version` — the unit of reproducibility                                       |

## Rules

1. **Versioned.** `EngineConfig.version` is required; a param change produces a new version, and
   outputs/stamps (`paramsVersion`) are comparable only within one.
2. **Validated.** `invalid_config` errors for: weights not summing to 1, negative windows,
   `leftBars`/`rightBars` < 1, `pullbackMinPct ≥ pullbackMaxPct`, etc.
3. **Overrides, not rewrites.** Per-market or per-timeframe adjustments live in config
   (`zone.sideOverrides`, MTF `set`) — the algorithm stays identical.
4. **`EngineParams` vs `EngineConfig`.** `EngineParams` (`common.ts`) is the _stamp_ carried by
   outputs — `{ version, values }` flattened. `EngineConfig` is the typed object the engines
   consume; the stamp derives from it.
5. **No hidden defaults.** Every field is required — an engine may not fall back to a hardcoded
   number. Defaults live in one factory (`defaultConfig()`), versioned like everything else.
