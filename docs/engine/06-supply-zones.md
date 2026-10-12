# 06 — Supply Zones

The bearish mirror of 05-demand-zones.md. Rules are structural mirrors — side, direction, and
penetration edge invert. Asymmetries are introduced **only where there is a stated reason**, never
to force artificial difference.

## Candidate patterns

| Pattern                 | Sequence            | Role                                                                              |
| ----------------------- | ------------------- | --------------------------------------------------------------------------------- |
| `RBD` (Rally→Base→Drop) | rally → base → drop | Reversal-origin supply. Primary candidate.                                        |
| `DBD` (Drop→Base→Drop)  | drop → base → drop  | Continuation-origin supply. Valid under the same departure-vs-leg-in rule as RBR. |

**Rally** (leg in): the `lookbackLeg` bars before the base advance ≥ `legMinAtr` — a real rally
for the base to distribute.

**Base:** identical rule to demand (2–`maxBars` bars, `maxRangeAtr`, `maxBodyAtr`, no wide bars).
_No asymmetric default is applied here_ — compression is compression regardless of side.

**Drop** (departure): within `departure.maxBars` after the base:

- `close` reaches `baseBottom − departure.minMoveAtr × ATR`, `baseBottom = min(low)` of base bars
- at least one departure bar meets the displacement test with a **bearish** close
- `structureImpact` measured against confirmed structure (`CHOCH`/`BOS` bearish, minor break,
  none)

Zone `createdAt` = close of the first departure bar satisfying `minMoveAtr`; `originAt` = first
base bar.

## Boundaries (mirrored)

- `upperPrice` (distal): `max(high)` of base bars (`extremes`) or `max(open, close)` (`bodies`).
- `lowerPrice` (proximal): `min(low)` of base bars (`extremes`) or `min(open, close)` (`bodies`).

## Structure impact

Identical to demand, inverted: strong = bearish `CHOCH`/`BOS` within the departure window;
minor = unprotected-swing break; none = no break.

## Liquidity interaction

Mirrored:

1. `formed_on_sweep`: base forms at/just after a confirmed **buy-side** sweep (stops above highs
   taken).
2. `departureThroughPool`: the drop closes through a resting **sell-side** pool.

## FVG relationship

Identical rule, inverted: bearish FVG = 3-bar sequence with `high[i+2] < low[i]` on the departure
leg. `fvgId`/`fvgOpen` recorded; contains/sub-level relationship unchanged.

## Freshness, retests, invalidation (mirrored)

- **fresh** → **tested**: bar's `high ≥ lowerPrice` while `close < upperPrice`; distinct retests
  counted after price exits below `lowerPrice`.
- **mitigated**: deepest penetration `high` reaches `depthMitigatedPct%` up from `lowerPrice`; or
  `retestCount ≥ maxRetests`; or a close inside above the midline.
- **invalidated**: close above `upperPrice + invalidateCloseAtr × ATR`.
- **expired**: `freshnessMaxBars` without interaction.

## Deliberate asymmetries (and where symmetry is kept)

| Rule                                                          | Symmetric?                 | Reason                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base definition, departure displacement, FVG, retest counting | Yes                        | Same mechanics both directions; inventing different thresholds would be unjustified.                                                                                                                                                                                                                                                                                                                                               |
| `departure.minMoveAtr` default                                | Yes (same)                 | ATR-normalised; measured departure speed differences belong to backtest evidence, not a priori constants.                                                                                                                                                                                                                                                                                                                          |
| Scoring weights                                               | Yes (same table)           | Features are side-agnostic; if backtests justify different weights they become a `zone.weights.*` override per side — never a hidden asymmetry.                                                                                                                                                                                                                                                                                    |
| Gap-through invalidation                                      | Configurable, default same | In gapped session markets (equities, indices) an open beyond the distal edge invalidates **without** needing a close — `zone.gapInvalidates` (default `true` for `equities`/`indices`, `false` for continuous markets). Applied identically to both sides, but listed here because it is the most likely place a side-specific override would later be justified by evidence (gap-down opens are statistically common in indices). |
| Wick-through vs close invalidation                            | Yes                        | Close-only, both sides — deterministic and wick-immune.                                                                                                                                                                                                                                                                                                                                                                            |

`zone.sideOverrides` in `EngineParams` allows any `zone.*` parameter to carry `demand:`/`supply:`
prefixed overrides — the mechanism exists, **with no defaults set**, so future evidence changes a
documented parameter rather than a hidden constant.

## Zone strength

Identical scoring model to 05 (same features, same default weights, same redistribution rule):
departure strength 0.25, structure break 0.15, liquidity interaction 0.15, freshness 0.15,
FVG 0.10, HTF confluence 0.10 (supply inside HTF supply / at HTF swing high), volume 0.05,
width 0.05. Score is evidence quality — not probability of rejection.

## Lifecycle

Same as demand: `forming` (diagnostic) → `active` at departure confirmation → `tested` →
`mitigated` / `invalidated`, plus `expired`. First-visible bars identical to the demand table.

## Test requirements

- Fixtures: textbook RBD, DBD continuation, invalid base, timed-out departure, retest-and-hold,
  mitigation depth, close-through invalidation, gap-through open in a sessioned market
  (`gapInvalidates: true` → immediately invalidated; `false` → waits for close), FVG on
  departure.
- Property: every demand fixture mirrored through `low↔high`, `bullish↔bearish` produces the
  identical lifecycle sequence — the mirror is itself a test.
- Property: with no `sideOverrides`, demand and supply scores for mirrored inputs are identical.
