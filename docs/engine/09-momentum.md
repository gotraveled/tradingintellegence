# 09 — Displacement & Momentum

Two related but distinct feature sets: **displacement** measures a single leg's conviction (an
event), **momentum** measures the market's current directional energy (a state). Both are
normalized in ATR/volatility units — never raw percentages, which mean different things on BTC,
gold, forex, and stocks.

## Part A — Displacement score (event, 0–100)

Measured over a _leg_ — a departure from a zone, a post-sweep reclaim, or a breakout move —
`n` consecutive bars from the leg's start bar to the bar where `displacementBars` elapses or the
move terminates.

### Inputs (all normalized)

| Input                        | Formula                                                                        | Why                                                      |
| ---------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Body strength                | `max_body = maxᵢ                                                               | close − open                                             | ᵢ / ATR` | Conviction lives in bodies, not wicks. |
| Range expansion              | `max_range = maxᵢ (high − low)ᵢ / ATR`                                         | Volatility signature of initiative.                      |
| Close location               | `avg_close_loc = meanᵢ (close − low)/(high − low)` (bullish; mirrored bearish) | Closes near the extreme = follow-through intent.         |
| Consecutive directional bars | `dir_ratio = directional_bars / n`                                             | Persistence, not a one-off print.                        |
| Distance travelled           | `move_atr = (leg_end_close − leg_start_close) / ATR`, absolute                 | Total initiative delivered.                              |
| Volume ratio                 | `legVol / medianVol(20)` — only where volume exists                            | Initiative shows in participation.                       |
| Structure break              | `1.0` if the leg closed through a protected/leg extreme (BOS/CHOCH)            | Displacement that flips structure is the strongest kind. |

### Score

```
f_body    = min(1, max_body / 2.0)        f_range = min(1, max_range / 3.0)
f_close   = avg_close_loc                  f_dir   = dir_ratio
f_move    = min(1, move_atr / 4.0)         f_vol   = min(1, volume_ratio / 2.0)
f_struct  = 0 | 0.5 | 1  (none / minor / BOS-CHOCH)

displacementScore = 100 × (0.20 f_body + 0.15 f_range + 0.15 f_close + 0.15 f_dir
                          + 0.15 f_move + 0.05 f_vol + 0.15 f_struct)
```

- Weights are `momentum.disp.weights.*` params summing to 1.0; `f_vol` redistributes pro-rata when
  volume is absent (same rule as zone scoring).
- `displacementScore ≥ momentum.disp.threshold` (default 60) qualifies a candle/leg as
  "displacement" for other stages — this is the threshold all earlier specs reference
  (sweep displacement, zone departure, break follow-through).

## Part B — Momentum feature set (state)

A deliberately small set — the engine reads _price behaviour_, it does not assemble an indicator
collection. Each feature is emitted per bar for the current timeframe:

| Feature           | Formula                                                  | Reads                                           |
| ----------------- | -------------------------------------------------------- | ----------------------------------------------- |
| `directionalMove` | signed `Σ close − open` over `lookback` (10) bars, ÷ ATR | Net initiative delivered, in ATR units.         |
| `rateOfChange`    | `(close[t] − close[t−n]) / ATR`, `n = 10`                | Speed of the move — an ATR-normalised ROC.      |
| `atrTrend`        | `ATR(14) now ÷ ATR(14) 20 bars ago`                      | Expanding (>1.15), compressing (<0.85), stable. |
| `bodyStrength`    | `mean                                                    | close − open                                    | / ATR` over 10 bars | Participation quality of recent bars. |
| `consecDirection` | current run of same-direction closes, signed             | Streak of initiative.                           |
| `volumeRatio`     | `vol[5-bar mean] ÷ vol[20-bar mean]` — optional          | Participation trend where volume exists.        |

**Secondary features** — allowed but never required:

- `rsi14` may be computed and attached, but no rule may depend on it — it exists for display and
  later ML features. The engine must produce identical decisions with all secondary features
  removed. This keeps the core deterministic on OHLCV alone.

### Derived state

```
MomentumState (existing domain type):
  strengthening : directionalMove and rateOfChange same sign, |directionalMove| ≥ 1.5,
                  bodyStrength ≥ 0.6
  weakening     : directionalMove decelerating (|value| below its own 10-bar mean × 0.7)
                  or direction flipped vs its 10-bar mean sign
  diverging     : price makes new extreme but directionalMove fails to (recorded for setups)
  neutral       : none of the above
```

`bias` = sign of `directionalMove` (>0.5 bullish, <−0.5 bearish, else neutral). All thresholds are
`momentum.*` params.

## Point-in-time & testing

- All inputs use closed bars only; `atrTrend` uses the shifted comparison so it never embeds the
  current bar in its own baseline.
- Fixtures: displacement leg (all features ~1 → score ≥90), wick-driven move (low body score),
  volumeless series (score identical with f_vol redistributed), momentum flip sequence, diverging
  swing-vs-momentum fixture.
- Properties: scores in [0,100]; secondary features provably do not alter primary outputs;
  momentum state is identical when run on truncated series (no look-ahead).

## Implementation notes (Phase 4F — `src/lib/engines/momentum.ts`)

- **Config additions.** `momentum.trendShift` (ATR baseline shift, spec "20 bars ago"),
  `momentum.vol { fast, slow }` (5/20 volume means), and `momentum.state { strengthMoveAtr,
  strengthBodyAtr, weakenFactor, biasMoveAtr }` were added — spec constants with no typed
  fields, caller-injected like prior phases. ROC `n` uses `lookback` (spec default 10 = 10).
- **Leg anchor.** The `MomentumEngine` contract is `{ series, config }` — no zones/sweeps/
  breaks — so Part A evaluates the **trailing `disp.bars` window** ending at each bar as the
  candidate leg (direction = sign of window move). Event-anchored legs (zone departures,
  reclaims) are downstream consumers' concern; the score formula is unchanged.
- **`f_struct` is capped at 0.5** — the price-only "minor" proxy (leg-end close through the
  pre-leg `lookback` extreme). 1.0 requires a BOS/CHOCH input the contract lacks. The weight
  is not redistributed — a measurable proxy exists.
- **`displacement` DetectionEventKind added** — events fire on the **rising edge** of
  `score ≥ threshold` (one per qualifying episode, not per qualifying bar). refId =
  `disp:{symbol}:{tf}:{direction}:{barTime}`; `momentum.displacementScore` reports the last
  leg's score regardless of threshold.
- **State precedence** — `diverging > weakening > strengthening > neutral` (the spec lists
  states but not precedence; divergence is the setup-relevant signal). `weakening` needs ≥2
  `directionalMove` observations; `diverging` needs a `lookback` history of it.
- **Warm-up.** Features stay `undefined` until their window is fully populated — no
  fabricated values. `consecDirection` is computable from bar 1; `rsi14` (Wilder) from
  `atrLength`; zero-range bars yield `closeLoc = 0.5`, never NaN.
- **`featuresByBar`/`scoreByBar`** are exposed on the internal `MomentumResult` for replay
  tests and downstream stages; the contract's `data` is the end-of-series snapshot only.
