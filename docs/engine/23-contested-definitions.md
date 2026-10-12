# 23 — Contested Definitions (Do Not Overfit the Theory)

Some concepts in this spec have no single universally accepted definition — different schools of
technical analysis define them differently, and none is provably "correct" a priori. This document
flags every such concept: the spec ships a **Version 1 definition**, keeps the alternatives
configurable, and defers the choice to backtest evidence (17), not opinion.

## Policy

1. **V1 definition is labelled, not canonized.** Where a concept is contested, the spec says so —
   the parameter table is the contract, not the narrative.
2. **Alternatives are parameters, not rewrites.** A defensible alternative maps to a config change
   (`EngineConfig` field or documented override), so competing definitions can be backtested under
   identical conditions.
3. **Outcomes decide.** `SetupOutcome` rows carry `paramsVersion` — the dataset can compare two
   definitions by filtering on version. No definition is adopted on reasoning alone.
4. **No silent changes.** Switching a contested default requires a new `paramsVersion` and a
   documented rationale.

## The contested list

| Concept                       | V1 definition (shipped)                                  | Defensible alternatives (backtestable via)                                                                                                                    |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Demand/supply zone boundaries | `boundaryMode: "extremes"` — base highs/lows incl. wicks | `"bodies"` (open/close only), distal-line conventions from other schools — `zone.boundaryMode`                                                                |
| Zone origin patterns          | DBR/RBR (demand), RBD/DBD (supply)                       | Leg-in requirements, "rally-base-rally only" schools, gap-origin zones — `zone.base`, `zone.departure` params + pattern enum is open                          |
| Base duration                 | `maxBaseBars: 10`                                        | Tighter (≤4) and looser (≤20) conventions — `zone.base.maxBars`                                                                                               |
| Equal highs/lows              | `equalToleranceAtr: 0.05`                                | Exact-touch schools, wider-tolerance schools — `structure.classifyToleranceAtr`, `liquidity.equalToleranceAtr`                                                |
| Swing significance            | `minSignificanceAtr` + left/right bars                   | Pure-fractal (no ATR gate), zigzag-% schools — `swing.minSignificanceAtr` can be set to 0                                                                     |
| Sweep rejection window        | `maxReclaimBars: 3`                                      | Same-bar-only purists, wider windows — `liquidity.sweep.maxReclaimBars`                                                                                       |
| FVG minimum size              | `minGapAtr: 0.15` + mid-body displacement                | "Any gap counts" schools (set to 0), stricter imbalance definitions — `fvg.minGapAtr`, `fvg.minMidBodyAtr`                                                    |
| Pullback quality bounds       | 23.6%–78.6% of impulse                                   | 38.2%/61.8% fib schools, non-fib depth measures — `cont.pullbackMinPct`/`pullbackMaxPct`                                                                      |
| Break acceptance              | `holdBars` closes beyond                                 | "One clean close" schools, volume-only acceptance — `breakout.holdBars`, `volumeMinRatio`                                                                     |
| MTF frame set                 | 4H/1H/15M                                                | 1D/4H/1H and other triplets — `mtf.set`                                                                                                                       |
| Wick vs close breaks          | Close-only for BOS/CHOCH; wick-counts for sweeps/retests | "Wick-break" schools — documented per rule; changing semantics requires a new paramsVersion, not a parameter flip, because it alters the meaning of the event |
| Zone invalidation             | Close through distal edge                                | "Wick-through kills the zone" schools — `zone.gapInvalidates` covers gaps; wick-vs-close is a semantics choice like above                                     |

## What is NOT contested

The _mechanism_ is fixed even where the _threshold_ is configurable: confirmation bars, lifecycle
states, `state(t)` visibility, and the scoring/explainability contract do not vary by school —
those are the engine's correctness properties, not trading theory.
