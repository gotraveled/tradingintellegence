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

## Implementation notes (Phase 4H)

- **Canonical consumption.** `detectReversals({ candles, at(idx) })` walks closed bars
  chronologically; `at(idx)` supplies the per-bar `*StateAt` snapshots (structure/momentum/
  liquidity/zones/FVG) and the 4G `causalAlignAt` alignment — the engine never scans raw
  history itself and cannot see a bar it wasn't given. `createReversalSetupEngine()` satisfies
  the `SetupDetectionEngine` contract for callers holding end-of-series snapshots; bar-indexed
  pool/zone lifecycle metadata (`sweepConfirmedBar`, `invalidatedBar`) still reconstructs what
  each bar may see. Historical backtests should prefer the provider path.
- **Developing sweeps.** Pools retain only *confirmed* sweeps (`sweepConfirmedBar`); C3's
  "developing" leg reads `sweep_developing` events carried on `FrameSnapshot.events`.
  `sweepConfirmedBar` is gated `≤ t` everywhere — a future confirmation is never knowable.
- **C4 = reclaim.** Spec 04 confirms a sweep only on reclaim, so `sweepConfirmedBar` present ⇒
  C4 met; a developing-only sweep satisfies C3 while C4 stays unmet.
- **Zone freshness.** Spec's "active/tested" maps to `status === "active"` (freshness is a
  property of an active zone; `mitigated`/`invalidated`/`expired` are rejected outright,
  `invalidatedBar` restores pre-invalidation state when reconstructing per-bar).
- **Expiry.** Developing with no confirmed sweep: `lifecycle.expiryBars` from creation.
  Sweep anchored but unconfirmed: `sweepMaxAgeBars` from `sweepBar` (C3's "stay live" window).
  Confirmed/active: `lifecycle.expiryBars` from the anchor transition (spec 11).
- **Cancelled.** Confirmed opposing-direction break after the sweep anchor, or `countertrend_*`
  MTF state — both only reachable from `developing`/`confirmed` per spec 11.
- **Entry band / targets / invalidation** are stored in `metadata` (`entryBandLow/High`,
  `targets`, `invalidation`) because the lifecycle's `active`/`partial_target`/`target_reached`
  states require them (spec 11) — they are evidence levels, not a trade plan (doc 16).
- **`score: 0`** is a contract placeholder, not a quality claim — spec 15 scoring is a later
  phase; `scoreContributions` is left absent.
- **ATR** for C2's 1×ATR distal band and `invalidateAtr` uses a local mean-TR(14) helper
  (`atrAt`) — 14 is the spec-wide ATR convention; no reversal-specific window exists.
- **Setup id** `rev:{symbol}:{tf}:{dir}:{zoneId}:{sweepAnchor}` — deterministic; a zone re-arms
  only on a new sweep anchor; one live setup per (zone, direction).
- **Transitions emit `setup_transition` events** (`atBar`/`transitionReason`) — bar-close only.
- **Excluded (later phases):** breakout/continuation families, scoring, trade plans, outcomes,
  alerts, live data.
