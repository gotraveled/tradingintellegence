# 04 — Liquidity

Liquidity = resting orders concentrated at obvious levels: stops below lows, stops above highs.
The engine detects **pools** (the levels), then **interactions** (sweeps, breaks, retests). These
are different entities and must never be conflated.

## Parameters

| Parameter                              | Default | Meaning                                                                                |
| -------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `liquidity.equalToleranceAtr`          | `0.05`  | Highs/lows within this × ATR are "equal".                                              |
| `liquidity.clusterMinCount`            | `3`     | Swings required to form a cluster pool.                                                |
| `liquidity.clusterWidthAtr`            | `0.25`  | Max band width for a cluster pool.                                                     |
| `liquidity.poolExpiryBars`             | `250`   | Bars without interaction before a pool expires.                                        |
| `liquidity.sweep.minPenetrationAtr`    | `0.05`  | Wick must exceed the pool level by this × ATR.                                         |
| `liquidity.sweep.maxReclaimBars`       | `3`     | Bars allowed after penetration to close back inside.                                   |
| `liquidity.sweep.displacementBars`     | `3`     | Bars after reclaim in which displacement must appear.                                  |
| `liquidity.sweep.displacementBodyAtr`  | `0.6`   | Displacement candle: body ≥ this × ATR.                                                |
| `liquidity.sweep.displacementRangeAtr` | `1.2`   | Displacement candle: range ≥ this × ATR.                                               |
| `liquidity.break.minCloseAtr`          | `0.1`   | Close beyond the level by this × ATR = break attempt.                                  |
| `liquidity.break.holdBars`             | `5`     | Bars after a break in which price must not close back inside for the break to succeed. |
| `liquidity.break.retestWindow`         | `10`    | Bars in which a retest may occur and count.                                            |

## Liquidity pool detection

A **pool** is a price band (often a single level) where resting stops or entry orders are likely
concentrated. All pools carry a `side`: `buy_side` rests **above** highs (shorts' stops + breakout
buyers), `sell_side` rests **below** lows.

| Pool type                          | Side       | Deterministic rule                                                                                                                                  |
| ---------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `equal_highs`                      | buy        | ≥2 confirmed swing highs within `equalToleranceAtr` (includes merged swings with `equalCount ≥ 2`).                                                 |
| `equal_lows`                       | sell       | Mirror on confirmed swing lows.                                                                                                                     |
| `swing_high`                       | buy        | Any single confirmed swing high (the weakest pool — still a stop level).                                                                            |
| `swing_low`                        | sell       | Mirror.                                                                                                                                             |
| `prev_day_high` / `prev_day_low`   | buy / sell | High/low of the prior _session_ per `Market.sessions` — not the prior 24h. In 24/7 markets, prior UTC day unless the market defines a day boundary. |
| `prev_week_high` / `prev_week_low` | buy / sell | High/low of the prior week aligned to the market's week boundary.                                                                                   |
| `range_high` / `range_low`         | buy / sell | Boundaries of an active range: `structure.trend = range` and the current `range_high − range_low` band of the last `range.lookbackBars` bars.       |
| `cluster_high` / `cluster_low`     | buy / sell | ≥ `clusterMinCount` confirmed swings within `clusterWidthAtr` of each other — wider than "equal", captures shelf-like congestion.                   |

Pool precedence when types overlap at the same level: they are recorded as **one pool with
multiple sources** (`sources: PoolType[]`) — never double-counted as separate pools.

### LiquidityPool object

```ts
interface LiquidityPool {
  id: ID;
  symbol: string;
  timeframe: Timeframe;
  side: "buy_side" | "sell_side";
  sources: PoolType[]; // e.g. ["equal_highs", "prev_week_high"]
  price: Price; // representative level (extreme for singles, band mid for clusters)
  lowerPrice?: Price; // band bounds for clusters/ranges
  upperPrice?: Price;
  touches: number; // swings/approaches that formed it
  strength: Score; // 0–100: touches, source count, recency, tightness
  status: "resting" | "approaching" | "swept" | "broken" | "expired";
  formedAt: ISODateTime;
  lastTouchedAt: ISODateTime;
  sweptAt?: ISODateTime;
  expiredAt?: ISODateTime;
  metadata?: Metadata;
}
```

- `approaching`: a bar's high/low comes within `approachAtr` (0.1×ATR) of the level without
  touching it.
- `expired`: `poolExpiryBars` bars with no touch, or the level is subsumed by a newer pool.
- `swept` vs `broken`: different end-states — see below.

## Liquidity sweep

A sweep is a raid followed by a reclaim. For a **sell-side sweep** (the bullish setup — stops
below a low are taken, price rejects):

1. **Target:** a `resting` (or `approaching`) sell-side pool at level `L`.
2. **Penetration:** a bar's `low < L − sweep.minPenetrationAtr × ATR`. The **wick counts** — a
   sweep exists to take stops, which intrabar wicks do. Required; penetration without the minimum
   depth is merely an approach.
3. **Reclaim (rejection):** within `maxReclaimBars` bars of the penetration bar, a bar must
   **close above `L`** (back inside the range the level bounded). A bar that closes _below_ `L`
   is not reclaiming — it may become a breakout instead.
4. **Displacement:** within `displacementBars` after the reclaim bar, at least one candle must
   show: `body ≥ displacementBodyAtr × ATR`, `range ≥ displacementRangeAtr × ATR`, and a **bullish
   close** (close in the upper half of its range). Displacement is evidence that the sweep was
   absorbed and initiative moved the other way.

Mirror all four steps for a **buy-side sweep** (bearish setup): wick above `L + minPenetrationAtr`,
reclaim close below `L`, bearish displacement.

### Sweep lifecycle

- **Developing sweep:** penetration + reclaim done; displacement not yet observed. Emitted at the
  close of the reclaim bar.
- **Confirmed sweep:** displacement requirement met. Emitted at the close of the displacement bar;
  the pool's `status` becomes `swept`, `sweptAt` recorded.
- **Aborted sweep:** `displacementBars` elapse with no displacement → the event is marked
  `aborted` (diagnostics only; the pool still counts as swept for liquidity purposes — the stops
  were taken either way).

## Sweep vs breakout vs false breakout vs successful breakout

These are four distinct events. The difference is **where the close happens** and **what follows**.

|                         | Sweep                                   | Breakout (attempt)               | False breakout                                 | Successful breakout                                |
| ----------------------- | --------------------------------------- | -------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| Penetration             | wick beyond `minPenetrationAtr`         | close beyond `break.minCloseAtr` | close beyond `break.minCloseAtr`               | close beyond `break.minCloseAtr`                   |
| Close relative to level | back **inside** within `maxReclaimBars` | beyond the level                 | beyond, then **back inside** within `holdBars` | beyond, **no** close back inside within `holdBars` |
| Follow-through          | displacement **against** the level      | n/a                              | displacement back inside                       | closes further beyond, or a retest that holds      |
| Pool end-state          | `swept`                                 | `approaching`→`broken`?          | `swept`-adjacent (`false_broken` in metadata)  | `broken`                                           |
| Meaning                 | stops taken, absorbed                   | unresolved                       | stops taken _then lost_ — often a trap         | level yielded, may flip role                       |

Deterministic rules:

- **Breakout attempt:** the first close beyond `L` by `break.minCloseAtr`. Emitted immediately;
  status `pending`.
- **Successful breakout:** `holdBars` consecutive bars with no close back inside, **or** an
  intervening retest (bar trades back to within `approachAtr` of `L`) that closes back on the
  breakout side. Then `status = successful`, pool `broken`.
- **False breakout:** any close back inside before `holdBars` completes → `status = failed`; the
  pool's stops were likely run _and_ the level was given back. A failed breakout followed by
  displacement in the _reclaim_ direction is functionally a late sweep — the engine records the
  sequence (`break_failed` → `reclaim`) rather than mislabelling either event.
- A **sweep** never requires a close beyond the level — penetration is intrabar. If the close
  also lands beyond but reclaims inside `maxReclaimBars`, the _sweep_ classification wins (the
  reclaim is what matters).

## Confirmation timing (summary for backtests)

| Event               | Earliest visible bar                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- |
| Pool formation      | close of the bar that confirms the final constituent swing, or the session/week boundary bar |
| Approaching         | close of the approach bar                                                                    |
| Developing sweep    | close of the reclaim bar                                                                     |
| Confirmed sweep     | close of the displacement bar                                                                |
| Breakout attempt    | close of the breaking bar                                                                    |
| Successful breakout | close of the `holdBars`-th bar, or the retest-hold bar                                       |
| False breakout      | close of the re-entry bar                                                                    |

## Test requirements

- Fixtures: textbook sell-side sweep (wick, reclaim, displacement); wick-through with no reclaim
  (no sweep — becomes pending break); close-through with reclaim (sweep, not break); breakout
  that holds 5 bars (successful); breakout that re-enters at bar 3 (false); pool at same level
  from two sources (merged, `sources` length 2); expired pool.
- Property: sweep events never appear at bars before the reclaim close.
- Property: `sources` merging produces exactly one pool per level band.

## Implementation notes (Phase 4C — `src/lib/engines/liquidity.ts`)

Points where the spec left room for interpretation — recorded, not silently changed:

- **ATR source.** `LiquidityConfig` has no `atrLength`; every level margin (`equalToleranceAtr`,
  `minPenetrationAtr`, `minCloseAtr`, `approachAtr`, displacement thresholds) uses the pool's
  **frozen formation ATR** — the representative swing's `metadata.atrAtPivot`; session pools use
  the mean TR of the prior session's bars. Deterministic and scale-free.
- **`approachAtr = 0.1`.** The spec hard-codes `approachAtr (0.1×ATR)` — implemented as a named
  constant, not config.
- **Range pools not implemented.** The pool table references `range.lookbackBars`, which does
  not exist in `LiquidityConfig` — flagged as a spec/config gap rather than inventing a param.
  `range_high`/`range_low` land in a later pass once the config exists.
- **Session pools.** `prev_day_*`/`prev_week_*` use UTC day and ISO-week (UTC Monday)
  boundaries — the spec's 24/7 default. Market-specific session calendars land when consumed
  via `Market.sessions`.
- **Pool status `swept` at the reclaim bar.** The spec ties `status = swept` to the confirmed
  sweep but also says an aborted sweep's pool "still counts as swept" — so the pool flips at
  reclaim (stops were taken), `sweptAt` recorded then; `sweep_developing`/`sweep_confirmed`
  carry the event lifecycle. Aborted sweeps are diagnostics-only (`metadata.sweepAborted` +
  `diagnostics.abortedSweeps`), per spec.
- **Sweep vs break same raid.** A close beyond `minCloseAtr` emits `break_attempt` immediately;
  if the reclaim lands inside `maxReclaimBars` the pending break is superseded — the sweep
  classification wins (spec). Re-entry after `maxReclaimBars` but inside `holdBars` →
  `false_breakout`, pool marked `falseBroken`.
- **`approaching` is transient.** Recomputed per bar: the pool is `approaching` only while the
  latest bar sits inside the approach band without touching; moving away reverts to `resting`.
- **Cascade merge.** A cluster band forming after its members' single-swing pools bridges
  overlapping bands — pools consolidate until no same-side overlaps remain (identity keeps the
  earliest pool, status keeps the most advanced lifecycle). Satisfies "one pool per level band".
- **Strength formula.** Spec defines 0–100 over "touches, source count, recency, tightness"
  without weights — implemented as `touches 40 + sources 25 + recency 20 + tightness 15`
  (touches capped at 5, sources at 3, recency decays linearly over `poolExpiryBars`, tightness
  = 1 − band width in ATR clamped [0,1]). Documented for later tuning.
- **Displacement bar timing.** Displacement is required strictly **after** the reclaim bar
  (window `reclaim+1 … reclaim+displacementBars`) — the reclaim bar itself cannot satisfy it.
- **Sweep event payload.** `sweep_developing`/`sweep_confirmed` metadata carries
  `eventId` (`{poolId}:sweep:{barTime}` — deterministic), `side`, `level`, `penetrationBar`,
  `reclaimBar`, and `extreme` (deepest wick of the raid). The pool's stops are taken at the
  penetration extreme — recorded for later engines.
- **Pool composition + freshness.** `metadata.memberSwingIds` (comma-joined ids) preserves
  membership through sweeps/merges — pools are never deleted. `metadata.freshnessBars` is the
  bars-since-last-touch at snapshot time — bar-index freshness, no wall-clock.
