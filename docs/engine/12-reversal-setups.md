# 12 — Reversal Setups

A reversal setup trades the absorption of a liquidity sweep at a significant zone, confirmed by
displacement and a structure break against the prior move. Bullish defined first; bearish mirrors.

## Parameters

| Parameter                  | Default | Meaning                                                     |
| -------------------------- | ------- | ----------------------------------------------------------- |
| `reversal.zoneMaxAgeBars`  | `500`   | Zone must not be `expired`.                                 |
| `reversal.zoneMinStrength` | `50`    | Origin zone `strength` (05) required.                       |
| `reversal.sweepMaxAgeBars` | `10`    | Bars since the sweep for the setup to stay live.            |
| `reversal.dispMinScore`    | `60`    | Post-sweep leg `displacementScore` (09) required.           |
| `reversal.entryZoneDepth`  | `0.5`   | Entry band = proximal edge to this fraction of zone height. |
| `reversal.invalidateAtr`   | `0.1`   | Close beyond distal edge + this × ATR → invalidated.        |

## Bullish reversal — condition sequence

Every condition is a measurable event from earlier specs; order matters where noted.

| #   | Condition                           | Measurable rule                                                                                                                                              | Required                                                    |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| C1  | Price approaches significant demand | A `demand` zone `active`/`tested` with `strength ≥ zoneMinStrength`, `remainingStrength > 0`; a bar's `low ≤ zone.upperPrice` (entry into zone, wick counts) | Yes                                                         |
| C2  | Sell-side liquidity exists below    | A `resting`/`approaching` `sell_side` pool at or below the zone's distal area (within 1×ATR)                                                                 | Yes                                                         |
| C3  | Liquidity sweep occurs              | `confirmed` or `developing` sell-side `sweep` targeting that pool (04), ≤ `sweepMaxAgeBars` old                                                              | Yes                                                         |
| C4  | Rejection                           | The sweep's reclaim bar closed back above the pool level (04 step 3)                                                                                         | Yes                                                         |
| C5  | Bullish displacement                | Post-sweep leg `displacementScore ≥ dispMinScore` (09)                                                                                                       | Yes                                                         |
| C6  | Bullish CHOCH/BOS                   | `StructureBreak` bullish (CHOCH on the protected LH, or BOS on a lower-frame sequence) confirmed at bar close                                                | Yes                                                         |
| C7  | FVG created                         | A bullish FVG on the displacement leg, `status = open`/`partially_filled`                                                                                    | Optional (+score)                                           |
| C8  | MTF context                         | `MtfAlignmentState` not `countertrend_bull`/`no_context`; `aligned_bull`/`realigning_bull`/`pullback_in_trend_bull` acceptable                               | Optional (+score; `countertrend` = hard veto → `cancelled`) |
| C9  | Retest/entry condition              | After C6, a bar re-enters the zone's proximal band or the departure FVG (`low ≤ upperPrice` or `low ≤ fvg.upperPrice`)                                       | Trigger for `active`, not for `confirmed`                   |

- **Entry band:** `[zone.lowerPrice, zone.lowerPrice + entryZoneDepth × zoneHeight]` — the
  proximal half of the zone (or the departure-FVG band when present and tighter).
- **Invalidation:** close below `zone.lowerPrice − reversal.invalidateAtr × ATR` (the distal
  edge — a decisive close through the level that was supposed to hold).
- **Targets:** T1 = nearest opposing `buy_side` pool (resting); T2 = nearest `active` opposing
  supply zone's proximal edge; T3 = prior `HH`/`EH` level or range high. Targets are ordered by
  price; the first is the conservative exit.

## Lifecycle mapping (spec 18)

| Setup state                                     | For a bullish reversal means…                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `developing`                                    | C1–C2 met, waiting on sweep (C3–C4) or displacement/structure (C5–C6). `reasons[]` names the missing conditions. |
| `confirmed`                                     | C1–C6 all met — the sequence qualified. Entry band may be above/below current price; waiting for C9.             |
| `active`                                        | C9 fired — price re-entered the entry band (or FVG) after confirmation.                                          |
| `invalidated`                                   | Close through the distal edge + tolerance.                                                                       |
| `completed` → `target_reached`/`partial_target` | T3 hit / T1–T2 hit.                                                                                              |
| `expired`/`cancelled`                           | Stale before activation, or the sweep's premise disproved (e.g. a new bearish CHOCH before C6) → `cancelled`.    |

## Bearish reversal — mirror

| Element      | Bearish version                                                   |
| ------------ | ----------------------------------------------------------------- |
| Zone         | `supply` zone, `active`/`tested`, same strength rules             |
| Liquidity    | `buy_side` pool above the zone                                    |
| Sweep        | confirmed/developing buy-side sweep with reclaim below the level  |
| Displacement | bearish leg `≥ dispMinScore`                                      |
| Structure    | bearish CHOCH/BOS (protected HL broken)                           |
| FVG          | bearish FVG `open`/`partially_filled` (optional)                  |
| Entry band   | `[zone.upperPrice − 0.5 × height, zone.upperPrice]`               |
| Invalidation | close above `zone.upperPrice + invalidateAtr × ATR`               |
| Targets      | nearest `sell_side` pool → opposing demand zone → prior `LL`/`EL` |

## Point-in-time

`confirmed` is first knowable at the close of the bar that confirmed C6 — the sequence cannot
complete before structure breaks, so no look-ahead exists. The sweep (C3) may be up to
`sweepMaxAgeBars` old at that moment.

## Test requirements

- Fixtures: textbook sequence (zone + pool + sweep + reclaim + displacement + CHOCH → confirmed;
  retest → active; T1 → partial_target; close-through → invalidated).
- Anti-fixtures (must NOT confirm): wick-through with no reclaim (no sweep), sweep + weak rally
  (`displacementScore < 60`), displacement but no structure break, zone `mitigated`/`invalidated`,
  `countertrend_bull` MTF state → `cancelled`.
- Property: a confirmed reversal's evidence chain (`zoneId`, `poolId`, `sweepEventId`, `breakId`,
  optional `fvgId`) is populated — the setup is always explainable.
