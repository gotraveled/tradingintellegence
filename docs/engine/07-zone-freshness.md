# 07 — Zone Freshness & Retest Lifecycle

Zones are consumed by interaction, not by opinion. This spec defines the exact state machine and
the tracked quantities. Applies to demand and supply identically (all price comparisons invert;
shown for demand).

## Tracked quantities on every zone

| Field                 | Type         | Meaning                                                                                                                                                          |
| --------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retestCount`         | integer      | Number of _distinct_ retests completed (see counting rule).                                                                                                      |
| `lastRetestAt`        | ISODateTime? | Close time of the most recent retest bar.                                                                                                                        |
| `penetrationDepthPct` | 0–100        | Deepest penetration into the zone since `active`, as % of zone height measured from the proximal edge (demand: `upperPrice − deepest low`, ÷ zone height, ×100). |
| `remainingStrength`   | Score        | Creation-time `strength` decayed by consumption — a live value, not the origin score.                                                                            |
| `status`              | enum         | Lifecycle state below.                                                                                                                                           |
| `freshness`           | enum         | `fresh` / `tested` / `mitigated` — derived from `retestCount` + `penetrationDepthPct`.                                                                           |

`strength` (origin score, 05) is **immutable** — it describes the evidence at creation.
`remainingStrength` is mutable — it describes what is left.

## Retest counting (deterministic)

A **retest** begins when a closed bar's `low ≤ upperPrice` (demand) after `active`, and ends when
a bar's `low > upperPrice` again (price exits the zone) **or** the zone leaves `active`/`tested`
state. One contiguous block of bars inside the zone = **one** retest, regardless of bar count.
`retestCount` increments at the _end_ of the retest block, `lastRetestAt` = the exit bar's close.

`penetrationDepthPct` is monotonic: it records the deepest `low` ever reached and never decreases
while the zone is alive.

## States

| State                       | Definition (demand; supply inverts)                                                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forming`                   | Base qualifies; departure not yet confirmed. Diagnostic only — not an output zone.                                                                                                                                                        |
| `active` (fresh)            | Departure confirmed; `retestCount = 0`, `penetrationDepthPct = 0`.                                                                                                                                                                        |
| `tested` (first retest)     | `retestCount = 1` completed, `penetrationDepthPct < depthMitigatedPct`, no close through.                                                                                                                                                 |
| `tested` (second retest)    | `retestCount = 2` completed under the same conditions. Recorded distinctly — the second tap is the last high-quality state.                                                                                                               |
| `tested` (multiple retests) | `retestCount ≥ 3` completed; zone is largely consumed even if depth is shallow — repeated taps spend resting orders.                                                                                                                      |
| `consumed`                  | `penetrationDepthPct ≥ depthMitigatedPct` (80%) **or** a bar **closed** inside the zone below its midline (`upperPrice − 0.5 × height`). The zone gave way to at least half its depth — residual value is minor. `freshness = mitigated`. |
| `invalidated`               | A closed bar: `close < lowerPrice − invalidateCloseAtr × ATR` (demand). Or `gapInvalidates` (06) — session open beyond the distal edge. Terminal.                                                                                         |
| `expired`                   | `freshnessMaxBars` bars `active`/`tested` with zero re-entry. Terminal.                                                                                                                                                                   |

Aliases: spec 05's `mitigated` = this doc's `consumed` (same predicate, same field value
`"mitigated"`). `ZoneStatus` = the status column; `ZoneFreshness` = the derived `fresh` (retest 0)
/ `tested` (retests 1–2+ shallow) / `mitigated` (consumed) summary for the UI.

## Does partial penetration reduce strength?

**Yes — `remainingStrength` decays with consumption; `strength` (origin) does not.**

```
remainingStrength = strength × (1 − retestDecay × retestCount) × (1 − depthDecay × penetrationDepthPct / depthMitigatedPct)
```

- `retestDecay` default `0.15` → after 3 retests, ≤ 55% of origin strength remains even if taps
  were shallow.
- `depthDecay` default `0.7` → at 80% penetration, depth term leaves 30%; at `consumed` the zone
  is terminal anyway.
- `remainingStrength` floors at 0 and is recomputed on every bar close while the zone is alive.
- A retest that produces _a bullish response with displacement_ does **not** restore strength —
  consumption is one-directional. Strength is spent, never regained.

## State transition table

| From               | Trigger (at bar close)              | To                                                                 |
| ------------------ | ----------------------------------- | ------------------------------------------------------------------ |
| `forming`          | departure `minMoveAtr` met          | `active`                                                           |
| `forming`          | `departure.maxBars` elapse          | discarded                                                          |
| `active`/`tested`  | first re-entry bar (low ≤ upper)    | `tested` (retest in progress — `retestCount` unchanged until exit) |
| retest in progress | close beyond midline or depth ≥ 80% | `consumed`                                                         |
| retest in progress | close < lower − tolerance           | `invalidated`                                                      |
| retest in progress | exit bar (low > upper)              | `tested`, `retestCount += 1`                                       |
| any live           | `freshnessMaxBars` elapsed          | `expired`                                                          |

## Edge cases

- **Entry and invalidation in the same bar:** close rules win — a bar that closes below the distal
  edge invalidates even though it also penetrated (penetration recorded first, then terminal state).
- **Wick to exactly the boundary:** `low = upperPrice` is not a retest — must be `≤` strictly with
  penetration? No: touching (`≤`) is the rule — equality counts as entry (deterministic; the tick
  touched the edge).
- **Retest during the departure leg itself:** bars before `active` never count.
- **Depth vs gap-through:** a gap that opens inside the zone updates `penetrationDepthPct` at
  open; if it opens beyond the distal edge and `gapInvalidates` applies → `invalidated`.

## Test requirements

- Fixtures: first retest shallow (state `tested`, remainingStrength ≈ 0.85×), second retest,
  three shallow taps → consumed by count (if `maxRetests` reached) or deep-penetration consumed,
  wick-exactly-on-boundary (counts), simultaneous entry+invalidation bar (invalidated wins),
  retest with bullish displacement (strength does not recover).
- Property: `penetrationDepthPct` monotonically non-decreasing while alive.
- Property: `remainingStrength ≤ strength` always.
- Property: `retestCount` never exceeds the number of distinct entry blocks.
