# 19 — Market Regime Model

A deliberately small 6-state label that answers one question: **which setup types work in which
conditions** (fed into 15's regime modulation and 17's outcome dataset). Two orthogonal inputs —
structure direction and volatility trend — map to a single label by precedence.

## Inputs (all already specified)

- `structure.trend` — `uptrend`/`downtrend`/`range`/`transition` (03)
- `momentum.atrTrend` — ATR(14) now ÷ ATR(14) 20 bars ago (09): `≥ 1.5` expanding, `≤ 0.7`
  compressing
- `structure` confirmed-swing count — `transition`/insufficient history

## The 6 states — deterministic precedence (first match wins)

| #   | State              | Rule                                                                                            |
| --- | ------------------ | ----------------------------------------------------------------------------------------------- |
| 1   | `HIGH_VOLATILITY`  | `atrTrend ≥ 1.5` — expanding volatility overrides direction; breakouts and whipsaws dominate.   |
| 2   | `LOW_VOLATILITY`   | `atrTrend ≤ 0.7` — compression; few setups qualify, breakout candidates build.                  |
| 3   | `TRENDING_BULLISH` | `structure.trend = uptrend` and `atrTrend > 0.7`                                                |
| 4   | `TRENDING_BEARISH` | `structure.trend = downtrend` and `atrTrend > 0.7`                                              |
| 5   | `RANGING`          | `structure.trend = range` — EQ-dominant swings inside a bounded band.                           |
| 6   | `TRANSITION`       | Anything else: mixed structure, insufficient swings, boundary `atrTrend` — honest "don't know". |

- Precedence keeps the output a **single label** — no "trending and high-volatility" ambiguity.
- `RANGING` requires structure `range`, not merely low volatility — a quiet uptrend is
  `TRENDING_BULLISH` until volatility truly collapses.

## Deliberately deferred

- No regime _strength_ score yet — `MarketRegimeSnapshot.strength` stays a display value, not an
  engine input.
- No hysteresis parameter yet — regime flicker between states is acceptable at this stage; if it
  proves noisy in backtesting, a `regime.minBars` (e.g. 5 consecutive qualifying bars) is the
  documented place to add it.

## Where it's consumed

- `SetupOutcome.regime` (17) — the core question it exists for.
- `score.regimeMatrix` (15) — modulates dimension weights per setup type.
- Dashboard `MarketRegimeSnapshot` (UI) — the existing `trending/ranging/compressing/expanding`
  enum is **unchanged**; `RegimeLabel` is the engine's label, recorded on outcomes.
