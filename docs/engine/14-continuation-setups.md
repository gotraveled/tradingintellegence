# 14 — Continuation Setups

A continuation setup trades the resumption of an established trend after a controlled pullback
into an origin zone or imbalance. Bullish defined; bearish mirrors throughout.

## Parameters

| Parameter              | Default | Meaning                                                                                |
| ---------------------- | ------- | -------------------------------------------------------------------------------------- |
| `cont.minTrendSwings`  | `3`     | Confirmed swings establishing the trend (≥1 HH + ≥1 HL for bullish).                   |
| `cont.impulseMinAtr`   | `3`     | Impulse leg travel ≥ this × ATR.                                                       |
| `cont.pullbackMinPct`  | `23.6`  | Pullback must retrace ≥ this % of the impulse (a real pullback, not a pause).          |
| `cont.pullbackMaxPct`  | `78.6`  | Retracing more → the impulse is spent — treat as potential reversal, not continuation. |
| `cont.pullbackMinBars` | `3`     | Pullback must span ≥ this many bars (a controlled move, not a gap).                    |
| `cont.recoveryBodyAtr` | `0.5`   | Recovery bar: body ≥ this × ATR, closes in trend direction.                            |
| `cont.confirmCloseAtr` | `0.05`  | Confirmation close beyond the pullback's last countertrend swing high by this × ATR.   |

## Definitions (bullish)

| Term                        | Deterministic rule                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `established trend`         | Structure `trend = uptrend` with ≥ `minTrendSwings` confirmed swings, at least one `HH` and one `HL` in order.                                                                                                                                                                                                                      |
| `impulse`                   | The leg from the last `HL` to the last `HH`: `impulseAtr = (HH.price − HL.price) / ATR ≥ impulseMinAtr`, formed within `impulseMaxBars` (default 15) bars.                                                                                                                                                                          |
| `pullback`                  | Consecutive ≥ `pullbackMinBars` bars retracing `[pullbackMinPct, pullbackMaxPct]` of impulse height, measured `HH.price − pullback_low`.                                                                                                                                                                                            |
| `pullback quality`          | 0–1 composite: (a) overlap ratio — pullback candles' combined range vs impulse range, lower overlap = cleaner; (b) pullback displacement < impulse displacement (counter-move is _weaker_); (c) declining volume on the pullback vs the impulse (where volume exists). Each component normalized; mean = quality. `≥ 0.5` required. |
| `demand/supply interaction` | Pullback low lands inside an `active`/`fresh`/`tested` demand zone, or within `0.5×ATR` of its proximal edge — origin of the prior impulse or a higher-quality zone.                                                                                                                                                                |
| `FVG interaction`           | Pullback low fills an `open` bullish FVG from the impulse leg (`fillPct` crossed 50 or 100 inside it) — confluence alternative to the zone.                                                                                                                                                                                         |
| `momentum recovery`         | `MomentumState` flips to `strengthening` or `directionalMove` sign flips positive after the pullback, plus a recovery bar: body ≥ `recoveryBodyAtr` closing bullish.                                                                                                                                                                |
| `continuation confirmation` | A close above the pullback's last confirmed countertrend swing high by `confirmCloseAtr × ATR` — the ETF/ITF sequence has printed a bullish BOS on its own micro-structure.                                                                                                                                                         |

## Lifecycle (spec 18 machine)

| State                             | Trigger                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `developing`                      | Trend + impulse confirmed; pullback ≥ `pullbackMinPct` and inside zone/FVG — waiting on quality + recovery + confirmation.                                                                                                           |
| `confirmed`                       | Pullback quality ≥ 0.5 **and** momentum recovery **and** continuation confirmation close.                                                                                                                                            |
| `active`                          | Entry band = pullback low → recovery bar close (or the zone/FVG band); price re-enters it.                                                                                                                                           |
| `partial_target`/`target_reached` | T1 = prior `HH`; T2 = impulse projection `1.0 ×` impulse height from pullback low; T3 = next opposing pool.                                                                                                                          |
| `invalidated`                     | Close below `pullback_low − invalidateAtr × ATR` — the pullback's defence failed.                                                                                                                                                    |
| `cancelled`                       | Pullback exceeds `pullbackMaxPct`, or a bearish CHOCH confirms on the setup timeframe **before** continuation confirmation — that _is_ a reversal signature, so the continuation premise dies (and a reversal may begin separately). |

## Healthy pullback vs trend reversal (deterministic)

| Signature | Healthy pullback                  | Reversal warning                                              |
| --------- | --------------------------------- | ------------------------------------------------------------- |
| Depth     | `23.6–78.6%` of impulse           | `> 78.6%` or close through pullback origin `HL`               |
| Duration  | ≥ `pullbackMinBars`, gradual      | V-shaped single-bar drop, or prolonged drift                  |
| Strength  | pullback displacement < impulse   | pullback displacement ≥ impulse (counter-move has initiative) |
| Structure | protected `HL` untouched          | close through protected `HL` + tolerance → bearish CHOCH      |
| Momentum  | weakens, doesn't flip             | `directionalMove` flips sign and `bodyStrength` expands       |
| End       | recovery bar + confirmation close | none of the above — the "pullback" never ends                 |

A "reversal warning" does **not** itself become a bearish setup — it only kills the continuation
premise (`cancelled`). The bearish reversal needs its own spec-12 sequence.

## Bearish continuation — mirror

`downtrend` (≥1 `LL` + `LH`), impulse `LH→LL`, pullback up into supply/bearish FVG,
bearish momentum recovery, close below the pullback's countertrend swing low, invalidation above
the pullback high.

## Test requirements

- Fixtures: clean uptrend → 38% pullback into origin demand → recovery + confirmation
  (confirmed → active → T1). Anti-fixtures: 82% retracement (cancelled), pullback with stronger
  displacement than impulse (quality < 0.5 → stays developing), bearish CHOCH before
  confirmation (cancelled), pullback that never touches a zone/FVG (no setup — interaction is
  required).
- Property: `pullbackMaxPct` is a hard gate — nothing above it can reach `confirmed`.
