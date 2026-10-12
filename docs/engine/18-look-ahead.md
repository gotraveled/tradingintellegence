# 18 — Look-ahead Bias Rules

Every feature, event, and state must be knowable **at the bar it's used**. This is the single most
important correctness property of the engine — a spec violation here silently produces fake
backtest results.

## Global rules

1. **Closed bars only.** Every rule consumes `candles[0…t]` at bar `t`. A still-forming bar never
   contributes.
2. **Visibility function.** `state(t)` returns exactly what was knowable at bar `t`'s close — the
   backtest calls `state(t)` per bar, never the full output.
3. **Confirmation bar is recorded.** Every entity stores `confirmedIndex`/`confirmedAt` — the first
   bar a consumer may see it. Filters are `confirmedIndex <= t`, not `index <= t`.
4. **HTF gating.** An HTF bar counts only after its own close relative to the lower timeframe —
   `lastConfirmedBarTime` per timeframe (spec 10).
5. **Revision is forward-only.** A later state change (invalidation, superseded) never rewrites
   what `state(t)` produced earlier — histories replay identically.

## Per-feature confirmation bars

| Feature                             | Earliest knowable bar                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Swing high/low                      | Close of `pivot + rightBars` (`confirmedIndex` — spec 02). Developing swings visible only at pivot for rules that opt in. |
| Swing classification (HH/LH/…)      | Same bar as the swing's own confirmation (03).                                                                            |
| BOS / CHOCH                         | Close of the breaking bar (close-only rule, 03).                                                                          |
| Liquidity pool formation            | Close of the bar that confirms the last constituent swing, or the session/week boundary bar (04).                         |
| Approaching pool                    | Close of the approach bar.                                                                                                |
| Developing sweep                    | Close of the reclaim bar.                                                                                                 |
| Confirmed sweep                     | Close of the displacement bar.                                                                                            |
| Breakout attempt                    | Close of the breaking bar.                                                                                                |
| Successful/false breakout           | Close of `holdBars`-th bar / the re-entry bar.                                                                            |
| Zone creation                       | Close of the first departure bar meeting `minMoveAtr` (05/06).                                                            |
| Zone retest/mitigation/invalidation | Close of the triggering bar (07).                                                                                         |
| FVG                                 | Close of bar `i+2` — the third candle of the pattern (08).                                                                |
| Displacement score                  | Close of the bar where the leg measurement completes (09).                                                                |
| Momentum features                   | Close of each bar (lookbacks use ≤ t only; `atrTrend` baseline is shifted, 09).                                           |
| MTF alignment                       | Recomputed at each ETF close using last-closed HTF/ITF bars (10).                                                         |
| Setup confirmed                     | Close of the bar where the last required condition lands (12–14).                                                         |
| Setup active                        | Close of the bar entering the entry band (11).                                                                            |
| Target/partial_target               | Close of the bar touching the target.                                                                                     |
| Setup invalidated                   | Close of the bar closing through the invalidation level + tolerance.                                                      |
| Outcome measurement                 | Starts the bar **after** `confirmedAt` — the confirmation bar's close is evidence, not outcome (17).                      |

## The common mistake — worked example

A swing high at bar 100 with `rightBars = 3` **cannot be confirmed at bar 100** — bars 101–103
must close first. Correct: `confirmedIndex = 103`, and any setup consuming it is knowable from
bar 103, not 100. Backtests that use the pivot bar leak three bars of the future.

The same applies transitively: a BOS on bar 150 uses the swing's _level_ (which existed at 100)
but the _classification_ is only knowable from 103 — both facts recorded separately.

## Verification requirements

- **Prefix property:** truncate the series at any bar → all confirmed outputs are identical.
- **Replay property:** `state(t)` over a walk-forward replay equals slicing the full output by
  `confirmedIndex <= t`.
- **No-future-read audit:** engine code may only index `candles[≤ t]` — enforced by the fixture
  suite asserting identical outputs when later bars are replaced with noise.
