# 17 — Historical Outcome Model

Every setup that reaches `confirmed` becomes a measurable case in an outcome dataset. This dataset
is the **entire reason the deterministic engine exists** — it is what future ML trains on, and it
is what makes the score honest (calibration, not claims).

## Measurement window

- Observation starts at the bar after `confirmedAt` (never the confirmation bar itself — its close
  is evidence, not outcome).
- Ends at the first terminal event: `target_reached`, `invalidated`, `expired`, or `cancelled`.
- A setup that never reached `active` still produces an outcome row — "never activated" is a
  measurable, informative result (score quality without fills).

## Recorded fields (`SetupOutcome`)

| Field                 | Rule                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entryPrice`          | For `active` setups: the entry band's first-touched price (conservative: proximal edge). `null` if never activated.                                                                                                                                                                         |
| `initialRisk`         | `                                                                                                                                                                                                                                                                                           | entryPrice − invalidation | ` at activation, in price and in ATR (`riskAtr`). |
| `mfe`                 | Maximum favorable excursion: best price _toward_ the target direction during observation, expressed in R (`mfeR = mfe / initialRisk`).                                                                                                                                                      |
| `mae`                 | Maximum adverse excursion: worst price _against_ it, in R — measured on **extremes** (low for longs), not closes.                                                                                                                                                                           |
| `timeToTarget`        | Bars from confirmation to each `targets[i].reached` (per-target array). `null` if never hit.                                                                                                                                                                                                |
| `timeToInvalidation`  | Bars from confirmation to the invalidating close. `null` if not invalidated.                                                                                                                                                                                                                |
| `rMultiple`           | Final result in R: `+n` per targets hit weighted, `−1` if invalidated at the stop, `0` if expired/cancelled unactivated. Weighting rule: equal thirds across T1–T3; a `partial_target` exit banks reached targets at their prices, remainder exits at the invalidating close or last close. |
| `targetsReached`      | Count of `targets[].reached` at resolution.                                                                                                                                                                                                                                                 |
| `stopReached`         | `true` if invalidated at/through the invalidation price.                                                                                                                                                                                                                                    |
| `expired`             | `true` if the setup expired unresolved.                                                                                                                                                                                                                                                     |
| `regime`              | `RegimeLabel` (19) at `confirmedAt` — answers "which setups work in which conditions."                                                                                                                                                                                                      |
| `scoreAtDetection`    | The score when the setup first became `developing`.                                                                                                                                                                                                                                         |
| `scoreAtConfirmation` | The score at `confirmedAt` — the number the outcome is correlated against.                                                                                                                                                                                                                  |
| `paramsVersion`       | Parameter set — outcomes are only comparable within a version.                                                                                                                                                                                                                              |

## Rules

- **Close-basis resolution:** targets/invalidation resolve at bar close (consistent with the
  lifecycle) — but `mfe`/`mae` record the _extreme_ (wick) prices so excursion is honest.
- **One row per setup instance**, keyed `setupId + confirmedAt` — re-detections after expiry are
  new rows.
- **No survivorship filter:** invalidated and unactivated outcomes are recorded identically.
- Dataset rows are append-only; corrections create new rows with `supersedes` links.

## Dataset schema (for later ML)

```
setup_outcome(
  setupId, symbol, assetClass, timeframe, setupType, direction,
  regime, scoreAtDetection, scoreAtConfirmation, paramsVersion,
  entryPrice, initialRisk, riskAtr,
  mfeR, maeR, rMultiple, targetsReached, stopReached, expired,
  barsToActive, timeToTarget[], timeToInvalidation,
  featureVector JSON,   // flattened inputs — see below
  resolvedAt
)
```

`featureVector` = flattened engine inputs at `confirmedAt` — every normalized feature the spec
defines (swing params context, zone strength components, displacement fᵢ, momentum features,
MTF votes, regime, score contributions). Keys are namespaced (`zone.strength`, `mtf.score`) so the
ML layer consumes a stable schema even as individual features evolve.
