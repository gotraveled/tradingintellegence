# 17 â€”€” Historical Outcome Model

Every setup that reaches `confirmed` becomes a measurable case in an outcome dataset. This dataset
is the **entire reason the deterministic engine exists** â€”€” it is what future ML trains on, and it
is what makes the score honest (calibration, not claims).

## Measurement window

- Observation starts at the bar after `confirmedAt` (never the confirmation bar itself â€”€” its close
  is evidence, not outcome).
- Ends at the first terminal event: `target_reached`, `invalidated`, `expired`, or `cancelled`.
- A setup that never reached `active` still produces an outcome row â€”€” "never activated" is a
  measurable, informative result (score quality without fills).

## Recorded fields (`SetupOutcome`)

| Field                 | Rule                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entryPrice`          | For `active` setups: the entry band's first-touched price (conservative: proximal edge). `null` if never activated.                                                                                                                                                                         |
| `initialRisk`         | `                                                                                                                                                                                                                                                                                           | entryPrice âˆ’ˆ’ invalidation | ` at activation, in price and in ATR (`riskAtr`). |
| `mfe`                 | Maximum favorable excursion: best price _toward_ the target direction during observation, expressed in R (`mfeR = mfe / initialRisk`).                                                                                                                                                      |
| `mae`                 | Maximum adverse excursion: worst price _against_ it, in R â€”€” measured on **extremes** (low for longs), not closes.                                                                                                                                                                           |
| `timeToTarget`        | Bars from confirmation to each `targets[i].reached` (per-target array). `null` if never hit.                                                                                                                                                                                                |
| `timeToInvalidation`  | Bars from confirmation to the invalidating close. `null` if not invalidated.                                                                                                                                                                                                                |
| `rMultiple`           | Final result in R: `+n` per targets hit weighted, `âˆ’ˆ’1` if invalidated at the stop, `0` if expired/cancelled unactivated. Weighting rule: equal thirds across â€“1â€“T3; a `partial_target` exit banks reached targets at their prices, remainder exits at the invalidating close or last close. |
| `targetsReached`      | Count of `targets[].reached` at resolution.                                                                                                                                                                                                                                                 |
| `stopReached`         | `true` if invalidated at/through the invalidation price.                                                                                                                                                                                                                                    |
| `expired`             | `true` if the setup expired unresolved.                                                                                                                                                                                                                                                     |
| `regime`              | `RegimeLabel` (19) at `confirmedAt` â€”€” answers "which setups work in which conditions."                                                                                                                                                                                                      |
| `scoreAtDetection`    | The score when the setup first became `developing`.                                                                                                                                                                                                                                         |
| `scoreAtConfirmation` | The score at `confirmedAt` â€”€” the number the outcome is correlated against.                                                                                                                                                                                                                  |
| `paramsVersion`       | Parameter set â€”€” outcomes are only comparable within a version.                                                                                                                                                                                                                              |

## Rules

- **Close-basis resolution:** targets/invalidation resolve at bar close (consistent with the
  lifecycle) â€”€” but `mfe`/`mae` record the _extreme_ (wick) prices so excursion is honest.
- **One row per setup instance**, keyed `setupId + confirmedAt` â€”€” re-detections after expiry are
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
  featureVector JSON,   // flattened inputs â€”€” see below
  resolvedAt
)
```

`featureVector` = flattened engine inputs at `confirmedAt` â€”€” every normalized feature the spec
defines (swing params context, zone strength components, displacement fáµ¢µ¢, momentum features,
MTF votes, regime, score contributions). Keys are namespaced (`zone.strength`, `mtf.score`) so the
ML layer consumes a stable schema even as individual features evolve.

## Implementation notes (Phase 6)

- **Entry points.** `measureOutcome({setup, candles, scoreAtConfirmation?, scoreAtDetection?,
  contributions?, regime?, paramsVersion?, supersedes?})` is the pure path;
  `createOutcomeEngine()` adapts the spec-20 contract (`{setup, opportunity, series, regime,
  scoreAtDetection?, paramsVersion?}` — the last two are additive-optional).
- **Timeline = lifecycle stamps, not re-simulation.** The detection engines replay the
  universal lifecycle causally and stamp `metadata`: `confirmBar`/`candidateBar` (pre-existing),
  `activeBar`, `partialTargetBar`, `targetReachedBar`, `invalidatedBar`, `expiredBar`,
  `cancelledBar`, and `targetBars` (CSV of per-target hit bars). The outcome engine reads those
  stamps — terminal/activation bars are whatever the causal replay decided — then derives
  entry/excursion/R metrics from candles in `[confirmBar+1, terminalBar]` (or series end when
  unresolved). This keeps per-family activation semantics (band overlap vs breakout
  acceptance/retest) single-sourced in the detectors.
- **Same-bar resolution.** Spec 11 already defines it: invalidation is checked BEFORE target
  touches in every family's lifecycle loop, and invalidation is close-only while target hits
  are wick-touches. A bar that wicks a target but closes through invalidation therefore
  stamps `invalidatedBar` and no `targetBars` entry — the measurement layer inherits that
  ordering without ever assuming intrabar OHLC sequencing.
- **`entryPrice` = proximal edge, unconditionally.** "The entry band's first-touched price
  (conservative: p—oximal edge)" resolves via specs 05/06, where proximal is a structural
  property of the zone/band — demand-side entries (bullish): `band.high`; supply-side
  (bearish): `band.low`. No inference from the activation bar's open: deriving which edge
  was touched first is an intrabar-order assumption — the same kind the spec's same-bar
  rule forbids— Proximal edge is –lso the conservative choic· both ways (larger initialRisk,
  smaller R). Gap-through (bar opens beyond the band/invalidation yet overlaps) books the
  same proximal edge — the convention, not a simulated fill.
- **`rMultiple`.** Equal weights 1/n over the setup's n targets (spec'— "equal thirds"
  generalized — breakout emits T1–T2). Hit targets bank `sgn·(T_i - E)/risk`; the un-hit
  remainder exits at the invalidating close (invalidated) or the last window close
  (expired/unresolved mark-to-market). Precedence: the weighting sentence is the operative
  rule; "−1 if invali—ated at the stop" is its degenerate case (k=0, close == stop). A
  gapping invalidating close may yield |R| > 1.
- **Unactivated terminal outcomes.** A setup invalidated while still `confirmed` (close-through
  before any entry) records `stopReached: true`, `entryPrice`/`initialRisk`/`mfeR`/`maeR` absent,
  and `rMultiple: 0` — no fill m—ans no risk existed to lose; spec's "0 if expired/cancelled
  unactivated" generalizes to all unactivated terminals.—
- **Excursion needs an entry.** `mfeR`/`maeR` are only emitted when the setup activated (they
  are normalized by `initialRisk`); both measured on extremes over `[confirmBar+1, resolvedBar]`,
  including pre-activation bars — spec's "during observation".
- **`riskAtr`** = `initialRisk /etection`. `candidateBar` is the authoritative detection bar
  by spec definition — "the score when the setup first became `developing`" and the engines
  emit status `developing` exactly at `candidateBar` (all three families).
- **Stamp causality vs measurement window.** The lifecycle stamps are written only by the
  causal d atrAt(c replay — prefix-vs-full replay over bar T reproduces every stamp known by
  T identically (test: reversal suite, "lifecycle stamps are causal"). The outcome row itself
  legitimately reads candles through aresolvedBar`; what must never leak is *which* stamps
  exist and *where* — and those are fixed at detection timendles, activeBar)` — reuses the shared ATR helper.
- **`scoreAtDetection`/`scoreAtConfirmation`** are caller-supplied: the pip—line computes them
  on the causal scoring path (`scoreOpportunity(..., provenance: "at_bar")`) at `candidateBar`
  and `confirmBar` respectively; the adapter falls back to `opportunity.score` /
  `opportunity.metadata.scoreAtDetection`.
- **`featureVector`** = `score.<dimension>` feature values +—`score.total` — the normalized f?
  the scorer produced, namespaced for the stable ML schema.
- **Unresolved rows.** A setup with no terminal stamp resolves at the last candle;
  `meta.diagnostics.unresolved = true` flags it (the row stays typed-valid for the dataset).
- **Identity.** Row key = `setupId + confirmedAt` (spec 17) — fully deterministic; re-detections
  after expiry produce new setup ids ? new rows; corrections link via `supersedes`.
- **Upstream additions (additive metadata only, zero semantic change)**: `TRANSITION_BAR` map +
  transition-bar stamps in all three engines' `transit()`; `targetBars` CSV in their target
  loops; `imbStatusAt` export (Phase 5) reused unchanged.
- **Not implemented here**: dataset persistence/aggregation (spec 17 defines the row, not the
  store), `BacktestEngine` orchestration, feature calibration, anything probabilistic.
