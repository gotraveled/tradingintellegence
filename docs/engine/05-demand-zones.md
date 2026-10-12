# 05 — Demand Zones

A demand zone is a price band where buyers previously showed initiative — marked by a base of
small-range bars followed by an impulsive rally away. This spec defines exactly how zones are
created, bounded, scored, retested, and invalidated. Supply mirrors in 06.

## Parameters

| Parameter                             | Default    | Meaning                                                              |
| ------------------------------------- | ---------- | -------------------------------------------------------------------- |
| `zone.base.minBars`                   | `2`        | Minimum candles in the base.                                         |
| `zone.base.maxBars`                   | `10`       | Maximum base duration — longer is consolidation, not a base.         |
| `zone.base.maxRangeAtr`               | `1.0`      | `max(high) − min(low)` of the base ≤ this × ATR.                     |
| `zone.base.maxBodyAtr`                | `0.5`      | Mean body of base candles ≤ this × ATR (compression).                |
| `zone.departure.minMoveAtr`           | `1.5`      | `close` of departure leg must travel ≥ this × ATR from the base top. |
| `zone.departure.maxBars`              | `5`        | Bars allowed for the departure to reach `minMoveAtr`.                |
| `zone.departure.displacementBodyAtr`  | `0.6`      | At least one departure candle: body ≥ this × ATR.                    |
| `zone.departure.displacementRangeAtr` | `1.2`      | …and range ≥ this × ATR.                                             |
| `zone.retest.depthMitigatedPct`       | `80`       | Deepest penetration reaching this % of zone height → `mitigated`.    |
| `zone.retest.invalidateCloseAtr`      | `0.1`      | Close beyond distal edge by this × ATR → `invalidated`.              |
| `zone.retest.maxRetests`              | `3`        | After this many retests the zone is `mitigated` regardless of depth. |
| `zone.freshnessMaxBars`               | `500`      | Zone untouched this long → `expired` (diagnostic status).            |
| `zone.boundaryMode`                   | `extremes` | `extremes` uses base highs/lows; `bodies` uses open/close.           |

## Zone origin — candidate patterns

| Pattern                  | Sequence               | Role                                                                                          |
| ------------------------ | ---------------------- | --------------------------------------------------------------------------------------------- |
| `DBR` (Drop→Base→Rally)  | decline → base → rally | Reversal-origin demand. Primary candidate.                                                    |
| `RBR` (Rally→Base→Rally) | rally → base → rally   | Continuation-origin demand. Valid when the departure is stronger than the leg in (see below). |

**Drop** (the leg in): the `lookbackLeg` (default 5) bars before the base decline ≥ `legMinAtr`
(1.0×ATR) — there must be a real drop for a _reversal_ base to absorb.

**Base:** 2–`maxBars` contiguous closed bars where:

- `max(high) − min(low) ≤ base.maxRangeAtr × ATR` (compressed)
- mean `|close − open|` over base bars ≤ `base.maxBodyAtr` (small-bodied)
- optional: no base candle's range ≥ `displacementRangeAtr` — a wide bar inside the base is not
  basing

**Rally** (the departure): within `departure.maxBars` after the base:

- `close` reaches `baseTop + departure.minMoveAtr × ATR` where `baseTop = max(high)` of base bars
- at least one departure bar meets the displacement candle test (body and range thresholds,
  bullish close)
- if the base formed after a `DBR`-style drop, the departure ideally produces a `CHOCH`/`BOS` —
  recorded as `structureImpact` for scoring, not required

A zone is **created** at the close of the first departure bar that satisfies `minMoveAtr`.
`originAt` = the first base bar's open time; `createdAt` = the departure-confirmation bar.

## Boundaries

- `lowerPrice` (distal): `min(low)` of base bars under `boundaryMode = extremes` (or `min(open,
close)` under `bodies`).
- `upperPrice` (proximal): `max(high)` of base bars under `extremes` (or `max(open, close)`
  under `bodies`).
- Under `extremes` the zone spans the full base footprint including rejection wicks — those wicks
  are evidence of absorption. `bodies` is tighter and misses wick-defended edges; `extremes` is
  the default because it matches where stops actually rest.
- Zone `width = upperPrice − lowerPrice`, recorded in ATR units at origin for scoring.

## Structure impact

The departure is measured against confirmed structure:

- `strong`: departure produces a `CHOCH` or `BOS` (03) within `departure.maxBars`.
- `minor`: departure breaks a confirmed swing that was not a protected level.
- `none`: rally without a break — the zone still exists but `structureImpact` scores lower.

## Liquidity interaction

Two directions, both recorded:

1. **Base at swept liquidity** (`liquidityContext: "formed_on_sweep"`): the base formed at or
   just after a confirmed sell-side sweep (04) — the strongest context, because stops were run
   before the base absorbed them.
2. **Departure through opposing liquidity** (`departureThroughPool: true`): the rally closes
   through a resting buy-side pool — initiative cleared the overhead supply of stops.

## FVG relationship

If the departure leg creates a **fair value gap** — a 3-bar sequence where `low[i+2] > high[i]`
(bullish) — the FVG is recorded (`fvgId`, `fvgOpen: true`). The FVG and the zone are linked:

- If the FVG sits inside the zone's band, the zone **contains** it (tighter sub-level).
- When price later fills the FVG without entering the zone deeper than `depthMitigatedPct`, the
  zone's freshness is unaffected; the FVG tracks its own `open/partially_filled/filled` status
  (07 spec).
- The presence of an open FVG on the departure leg is a scoring input (imbalance left behind).

## Freshness and retests

- **fresh**: never re-entered since departure. First retest carries the most stored orders.
- **tested**: at least one bar's `low ≤ upperPrice` (entered the zone) while `close > lowerPrice`
  — the zone has been tapped but not consumed. `retestCount` increments per _distinct_ retest —
  consecutive bars inside the zone count once until price exits above `upperPrice` again.
- **mitigated**: any of —
  - deepest penetration `low` reaches `depthMitigatedPct%` of zone height below `upperPrice`;
  - `retestCount ≥ maxRetests` (each tap consumes residual orders);
  - a close inside the zone below its midline.
- **invalidated**: a close below `lowerPrice − invalidateCloseAtr × ATR`. The zone becomes a
  _failed_ level — historically a flip candidate but no longer valid demand.
- **expired**: `freshnessMaxBars` with no interaction (diagnostic; zone removed from watch).

## Zone strength — deterministic score 0–100

Score = `100 × Σ wᵢ · fᵢ`, each feature normalized to [0, 1] before weighting. Weights are
parameters (`zone.weights.*`), must sum to 1.0, and ship with the defaults below. When a feature
is unavailable (e.g. volume on spot forex), its weight is redistributed **pro-rata** to the
remaining features — the score is still a weighted mean, never padded.

| Feature               | Weight | f (0→1)                                                                   | Why it exists                                                 |
| --------------------- | ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Departure strength    | 0.25   | `min(1, moveAtr / 4)` — ATR travelled in departure, capped at 4×          | The whole premise: a strong exit means imbalance left behind. |
| Structure break       | 0.15   | CHOCH/BOS on departure = 1.0; minor break = 0.5; none = 0                 | Zones that flip structure are the ones traders defend.        |
| Liquidity interaction | 0.15   | `formed_on_sweep` = 1.0; `departureThroughPool` = 0.5; neither = 0        | Stops run before/at the base = fuel already spent.            |
| Freshness             | 0.15   | fresh = 1.0; tested = 0.5; mitigated = 0.1                                | Retested zones are partially consumed; order flow decays.     |
| FVG association       | 0.10   | open FVG on departure = 1.0; filled FVG = 0.4; none = 0                   | An unfilled gap marks urgency; a filled one has delivered.    |
| HTF confluence        | 0.10   | zone inside HTF demand / at HTF swing low = 1.0; near = 0.5; opposing = 0 | Higher-timeframe levels dominate intraday defence.            |
| Volume expansion      | 0.05   | `min(1, departureVol / (2 × baseVol))` — absent → redistribute            | Initiative shows in volume where it exists.                   |
| Zone width            | 0.05   | `1 − min(1, widthAtr / 1.5)` — narrower scores higher                     | A tight base means a sharp decision, clearer risk line.       |

- The score is **quality of evidence**, never probability of a bounce.
- Every feature is a measurable quantity on closed bars; weights are `EngineParams` — changing
  them produces a different `paramsVersion`, so scores are comparable only within the same
  version.

## Lifecycle (backtest visibility)

| State                       | First visible bar                                                                |
| --------------------------- | -------------------------------------------------------------------------------- |
| `forming`                   | close of first base bar after the leg qualifies (diagnostic; not an output zone) |
| `active`                    | close of the departure-confirmation bar                                          |
| `tested`                    | close of the first re-entry bar                                                  |
| `mitigated` / `invalidated` | close of the triggering bar                                                      |

## Test requirements

- Fixtures: textbook DBR (decline → 4-bar compressed base → displacement rally + BOS), RBR
  continuation base, base that fails `maxRangeAtr` (no zone), base that times out on departure
  (no zone), retest-and-hold (fresh→tested), deep retest (tested→mitigated), close-through
  (invalidated), zone with FVG on departure (fvgId set).
- Property: `widthAtr` appears only in the width feature — it never blocks zone creation.
- Property: score in [0, 100] always; zero when all features are 0.
- Property: weights redistributed when volume absent still sum to 1.0.
