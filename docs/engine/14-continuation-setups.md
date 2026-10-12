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

## Phase 4J implementation notes

- **Canonical consumption.** `detectContinuations({ candles, at(idx) })` walks closed bars
  chronologically; `at(idx)` supplies per-bar `*StateAt` snapshots (structure/swings, pools,
  zones, imbalances, momentum) plus the 4G `causalAlignAt` alignment and `FrameSnapshot.events`.
  The pullback geometry is measured on candles per this spec's definition — anchored to upstream
  confirmed swings (price/id), never re-detected. `createContinuationSetupEngine()` satisfies the
  `SetupDetectionEngine` contract.
- **Established trend.** `structure.trend === uptrend|downtrend` plus ≥ `minTrendSwings`
  confirmed, knowable (`confirmedIndex ≤ t`) swings with ≥1 HL and ≥1 HH (bullish; LH/LL
  bearish) where the base pivot precedes the top pivot. No candle-derived trend classification.
- **Impulse.** Last confirmed base→top pair; `height / atrAt(t) ≥ impulseMinAtr` and
  `top.pivotIndex − base.pivotIndex ≤ impulseMaxBars`. `impulseMaxBars` was spec-required
  (default 15) but absent from `ContinuationConfig` — added as the smallest additive typed
  change (same precedent as `breakout.dispBars` in 4I).
- **Pullback.** Consecutive bars since the top pivot; depth = `(top − extreme) / height`
  ∈ `[pullbackMinPct, pullbackMaxPct]` over `≥ pullbackMinBars` bars. The extreme evolves per
  bar while developing; `pullbackMaxPct` is a hard gate — exceeding it cancels the premise
  (`pullback_too_deep`) before `confirmed`, never invalidates an already-confirmed setup.
- **Interaction (required for `developing`).** The pullback extreme must land inside an
  `active` + `fresh|tested` demand/supply zone (or within `0.5×ATR` of its proximal edge —
  spec-literal constant), or penetrate ≥50% into an `open`/`partially_filled` FVG whose
  `createdBar` falls inside the impulse leg. No interaction → no setup (spec anti-fixture).
  FVG openness at bar `t` is reconstructed **only** from bar-indexed stamps — `createdBar`,
  `filledBar` (added to 4E output for exactly this), `expiredBar`, `invalidatedAt` — never
  from the end-of-series `status`. On the provider path `imbalanceStateAt` already returns
  per-bar truth; on the contract path the same stamps answer it deterministically.
- **Quality composite (0–1) — component definitions: spec; normalization: implementation-
  derived (spec leaves the component formulas undefined).** Spec 14 names the three components
  and requires "each component normalized; mean = quality; ≥ 0.5" but defines no normalization
  formulas — the ones below are the deterministic implementation choices, pinned by tests
  (`metadata.quality` exact-value assertion), not a normative reading of the spec:
  (a) `1 − min(1, combined pullback-bar range / combined impulse-bar range)` — pullback segment
  bounded at the extreme bar (recovery bars are not part of the pullback);
  (b) `1` iff max counter-direction `displacementScore` on pullback bars < max trend-direction
  score on impulse bars (upstream scores only, else `0`);
  (c) `1` iff mean pullback volume < mean impulse volume.
  Any unevaluable component is skipped and the mean redistributes over present components
  (spec-09 volume convention); if all are missing the gate cannot pass. This gate is distinct
  from the future spec-15 opportunity score — it is a binary lifecycle condition only.
- **Momentum recovery.** Latches when a bar closes trend-direction with body ≥
  `recoveryBodyAtr×ATR` AND (`state === "strengthening"` OR `directionalMove` sign flips vs the
  pullback window). Latch persists until confirmation (spec defines no re-arm expiry).
- **Confirmation.** Close beyond the pullback's last confirmed countertrend swing
  (swing high for bullish — the micro lower-high) by `confirmCloseAtr×ATR`. No confirmed
  countertrend swing → the level is missing, not defaulted — the setup stays `developing`.
- **Entry band / `active`.** Band = `[pullback extreme, recovery-bar close]`, frozen at
  confirmation. `active` = the bar's range overlaps the band (spec 11: "wick counts — the
  fill zone was touched") — the confirm bar itself may activate.
- **Targets (evidence metadata, not orders).** T1 = prior HH/LL; T2 = impulse height projected
  from the pullback extreme; T3 = nearest resting opposing pool strictly beyond T1. Ordered by
  forward distance, float-normalized dedupe; absent pool → T3 omitted. A bar reaching multiple
  levels emits a single transition to the deepest reached state.
- **`invalidated` vs `cancelled`.** `invalidated` = close through `extreme ∓ invalidateAtr×ATR`
  (level frozen at confirmation — reachable only post-confirmation). `cancelled` = depth >
  `pullbackMaxPct` or an opposing confirmed CHOCH with `breakIndex > impulseStart` while
  developing — the spec's reversal warnings; they kill the premise and produce no bearish setup.
- **Deterministic ID.** `cont:{symbol}:{tf}:{dir}:{anchorRef}` where `anchorRef` = the qualifying
  zone id, else the qualifying FVG id. Duplicate prevention by live key + historical anchorRef
  scan; a later impulse anchored to a different zone/FVG may re-arm.
- **`expired` — authorized by spec 11, inherited.** Spec 11 defines `expired` universally:
  "`expiryBars` elapsed without becoming `active` (confirmed) or without target/invalidation
  (active)". Spec 14's table omits it but the universal machine governs — applied as:
  `developing`/`confirmed` expire `expiryBars` after creation without reaching `active`;
  `active`/`partial_target` expire `expiryBars` after the last progress bar (activation or
  target hit) without target/invalidation. Terminal states remain immutable.
- **MTF.** Spec 14 defines no MTF gate — alignment is recorded as context
  (`contextTimeframe`/`mtfState`) but never vetoes.
- **`score: 0`** placeholder — spec 15; targets/band/invalidation are lifecycle evidence only.
- **Contract-path caveat.** `detect()` consumes end-of-series snapshots (as 4H/4I); historical
  runs must drive `detectContinuations` with the 4G causal join. Bar-indexed metadata
  (`confirmedIndex`, `createdBar`, `filledBar`, `invalidatedBar`, `expiredBar`, `invalidatedAt`)
  guards what each bar may see.
