# Spec 27 — Market Regime Engine

## Status

Draft (reconciled) — implementation-closure specification for the deferred
`MarketRegimeEngine` contract. The **behavioral model is Spec 19**
(`docs/engine/19-regime.md`); this document defines the engine surface, causal contract,
and audit surface — it does not redefine the model.

## Purpose

Implement the documented-but-unimplemented `MarketRegimeEngine` (contract: `services/engine.ts`),
producing the 6-state `RegimeLabel` whose consumers already exist:

- `ScoringSnapshot.regime` → `REGIME_FAMILY` → `regimeMatrix` dimension modulation (spec 15)
- `StatisticalDecision.regime` → spec-24 regime cohort axis (absent-axis rule already defined)
- `SetupOutcome.regime` → spec-17 outcome record field (declared, unpopulated)

## Scope

One deterministic producer. Spec 27 owns classification only — it produces `RegimeLabel`
from caller-supplied point-in-time inputs and changes nothing downstream.

## Dependencies

| Dependency        | Status                                                        |
| ----------------- | ------------------------------------------------------------- |
| Spec 03 structure | `MarketStructure.trend` — `uptrend`/`downtrend`/`range`/`transition` |
| Spec 09 momentum  | `MomentumFeatures.atrTrend` — produced by `analyzeMomentum` (`momentum.ts`) |
| Spec 21 config    | `RegimeConfig` — exists                                       |
| Spec 20 contract  | `MarketRegimeEngine` — exists                                  |

## Inputs

`classifyRegime(input)` consumes a point-in-time view — the caller is responsible for
causality (same philosophy as `scoreOpportunity`'s `ScoringSnapshot`). The signature is
the existing `MarketRegimeEngine.classify` contract, verbatim:

- `structure: MarketStructure` — the **PIT** structure at the evaluation bar (i.e. the
  `structureStateAt(t)` output, not the final-series artifact). Only `trend` is read.
- `features: MomentumFeatures | undefined` — the bar's momentum features (i.e.
  `momentumStateAt(t).features`, or `featuresByBar[t]`). Only `atrTrend` is read.
- `config: RegimeConfig` — thresholds only (see Configuration).

No further inputs. `EngineMeta.paramsVersion` is derived from the consumed config fields
(`e{expandAtrTrend}|c{compressAtrTrend}`) — the contract carries no explicit version
input, so versioning follows the `statistics.ts` convention of deriving the stamp from
configuration. `barsConsumed` uses the snapshot-consumer convention `{from: -1, to: -1}`
(as in `statistics.ts`) — classification reads a snapshot, not a bar range.

## Regime Model

`RegimeLabel` (existing type, `types/domain/structure.ts`) — lowercase values; the uppercase
names in spec 19's table are the same six states:

`trending_bullish`, `trending_bearish`, `ranging`, `high_volatility`, `low_volatility`, `transition`

## Classification Rules

Deterministic precedence — **first match wins** (spec 19, verbatim semantics):

| # | Label              | Rule                                                       |
| - | ------------------ | ---------------------------------------------------------- |
| 1 | `high_volatility`  | `atrTrend ≥ expandAtrTrend` (default 1.5)                  |
| 2 | `low_volatility`   | `atrTrend ≤ compressAtrTrend` (default 0.7)                |
| 3 | `trending_bullish` | `trend = uptrend` AND `atrTrend > compressAtrTrend`        |
| 4 | `trending_bearish` | `trend = downtrend` AND `atrTrend > compressAtrTrend`      |
| 5 | `ranging`          | `trend = range` (EQ-dominant swings inside a bounded band) |
| 6 | `transition`       | anything else — honest "don't know"                        |

`transition` covers: `trend = transition` (including insufficient confirmed swings — the
structure engine's `minSwingsForTrend` gate already encodes this), missing/undefined
`atrTrend`, and no other rule firing. Spec 19's "confirmed-swing count" input is honored
**through** `trend` — no separate swing-count read is required.

## Precedence Rules

Volatility dominates direction: expanding (`atrTrend ≥ 1.5`) overrides every directional
state including `ranging`; collapsing (`atrTrend ≤ 0.7`) likewise. A quiet-but-not-collapsed
uptrend (`0.7 < atrTrend < 1.5`) remains `trending_bullish`. Boundary values are inclusive
as written: `1.5` → `high_volatility`, `0.7` → `low_volatility` (rules 3–4 require strict `> 0.7`).

| trend \ atrTrend | ≤ 0.7           | (0.7, 1.5)         | ≥ 1.5           | absent        |
| ---------------- | --------------- | ------------------ | --------------- | ------------- |
| uptrend          | low_volatility  | trending_bullish   | high_volatility | transition    |
| downtrend        | low_volatility  | trending_bearish   | high_volatility | transition    |
| range            | low_volatility  | ranging            | high_volatility | ranging       |
| transition       | low_volatility  | transition         | high_volatility | transition    |

Every cell resolves to exactly one label — exhaustive and non-ambiguous.

## Causal StateAt Contract

Two exported functions plus the existing engine adapter — same shape as every engine:

- `classifyRegime(input) → EngineResult<{ regime: RegimeLabel }>` — pure classifier over
  snapshot inputs; **no candle access, no derivation** — causality is inherited from inputs.
- `regimeStateAt(structure, features, cfg) → RegimeLabel` — thin composer over the
  contract: delegates to `classifyRegime`, returns `result.data.regime` when `ok`, else
  `transition` (invalid config degrades to the honest "don't know" label — never throws,
  never fabricates a directional state). Used by the future backtest `at(t)` join when
  fed `structureStateAt(t)` + `momentumStateAt(t).features`.
- `createMarketRegimeEngine() → MarketRegimeEngine` — adapter wrapping `classifyRegime`.

`regimeStateAt(t)` cannot see: future candles, future swings, future structure, future
regime classifications, final-series state, or setup outcomes — because its inputs are
upstream `*StateAt(t)` outputs and the function itself holds no state and reads nothing else.
Per-bar classification; **no hysteresis** (spec 19 explicitly defers `minBars`).

## Outputs

`EngineResult<{ regime: RegimeLabel }>` — the label plus standard `EngineMeta`
(`stage: "regime"`, `paramsVersion`, `barsConsumed`, `events: []`, diagnostics carrying the
evaluated `trend`, `atrTrend`, and fired rule index). No domain artifact, no event stream,
no IDs — a label is the entire output; spec-19 defines no transitions or lifecycle events.

## Configuration

`RegimeConfig` audit — `expandAtrTrend` and `compressAtrTrend` are the only active fields:

- `expandAtrTrend` (1.5) — rule-1 threshold, `>`
- `compressAtrTrend` (0.7) — rule-2 threshold, `≥` negation for rules 3–4
- `atrLength` / `atrLookback` — **dead fields**: `atrTrend` arrives pre-computed under
  `MomentumConfig.atrLen`/`trendShift`. Reserved; MUST NOT be re-read to recompute ATR.
  Flagged as an open question (config duplication).
- `minBars` — **reserved for the deferred hysteresis** spec 19 names as `regime.minBars`.
  Present in config, not consumed in this phase; classification is per-bar.

Validation — `invalid_config` unless `compressAtrTrend` is finite and `> 0` AND
`expandAtrTrend` is finite and `> compressAtrTrend`: **`expand > compress > 0`, strict.**
Equality collapses the middle band — rules 3–5 become unreachable — so `expand ==
compress` is rejected. NaN/±∞ rejected by the finiteness requirement (a bare `≤`
comparison lets NaN through). Defaults (1.5 > 0.7 > 0) are valid. Missing
`features`/`atrTrend` is **not** an error — it is `transition`.

## Determinism

No randomness, no wall clock, no network, no mutable global state, no locale-sensitive
formatting. `classifyRegime` is a pure function; identical inputs → identical label.
First-match precedence makes ties impossible by construction.

## Insufficient Data

Early bars produce `features === undefined` or `atrTrend === undefined` → `transition`.
`trend = transition` (insufficient swings) → `transition`. `trend = range` with absent
`atrTrend` → `ranging` (rule 5 doesn't need volatility — see table).

## Edge Cases

- `atrTrend === expandAtrTrend` → `high_volatility`; `=== compressAtrTrend` → `low_volatility`.
- `atrTrend` strictly between → directional/ranging rules apply.
- `features` present but `atrTrend` absent (early bars before ATR baseline) → `transition`/`ranging`.
- Config `expand ≤ compress` → `invalid_config` error, never a label.
- `NaN`/`Infinity` in `atrTrend` → treated as absent → `transition` (numeric guard, no throw).

## Downstream Consumers

| Consumer                          | Consumption                                        | Status after Spec 27     |
| --------------------------------- | -------------------------------------------------- | ------------------------ |
| `ScoringSnapshot.regime` (15)     | `REGIME_FAMILY` → `regimeMatrix` multipliers       | producer exists; wiring = spec-29 composition |
| `StatisticalDecision.regime` (24) | cohort axis at `confirmBar`                        | producer exists; wiring = spec-29/30         |
| `SetupOutcome.regime` (17)        | label at confirmation on the outcome row           | producer exists; wiring = spec-29            |
| `MarketRegimeSnapshot` (UI)       | unchanged — separate 4-state `MarketRegime` enum   | out of scope             |

## Integration Boundary

Spec 27 modifies **nothing** in scoring, statistics, scanner, or backtest. Consumers already
accept `RegimeLabel`; wiring it in is the later composition phase (Spec 29 per discovery).
`OutcomeEngine.measureOutcome` already accepts `regime?: RegimeLabel` — untouched.

## Test Requirements

- Classification: all six labels, constructed inputs.
- Precedence: volatility overrides direction/range in both directions.
- Boundaries: `atrTrend` exactly `0.7`/`1.5`/`>0.7` strictness on rules 3–4.
- Missing data: `features` undefined, `atrTrend` undefined, `trend` transition/range combos.
- Causality: `regimeStateAt` fed `structureStateAt(t)`/`momentumStateAt(t)` — label at `t`
  identical under truncated vs full series (prefix/full equivalence).
- Determinism: same inputs → same label; no ordering effects.
- Contract: `createMarketRegimeEngine()` adapter returns the same result as `classifyRegime`.
- Config: `expand ≤ compress` → `invalid_config`.

## Non-Goals

No MTF composition, scoring/statistics wiring, TradePlan, scanner/backtest changes,
walk-forward, probability estimation, ML, alerts, signals, paper trading, live data,
broker APIs, execution, Auto Sniper, UI, hysteresis (`minBars` reserved), regime strength
scores, or regime lifecycle events.

## Acceptance Criteria

1. All six labels deterministically classifiable from `(trend, atrTrend)` alone.
2. Precedence is exhaustive and unambiguous (truth table above).
3. Boundaries inclusive exactly as spec-19 rules state.
4. Missing inputs → `transition`, never an error or fabricated label.
5. `regimeStateAt` output equals classification on a historical prefix (causality).
6. Existing contracts preserved: `MarketRegimeEngine`, `RegimeConfig`, `RegimeLabel` unchanged.
7. Pure deterministic function; `EngineMeta.diagnostics` exposes trend/atrTrend/rule fired.
8. No downstream wiring — consumers untouched.

## Open Questions

None outstanding. All four design-phase questions were resolved by reconciliation:

1. `RegimeConfig.atrLength`/`atrLookback` — RESOLVED: dead duplicates of
   `MomentumConfig.atrLen`/`trendShift`; kept as reserved contract fields — Spec 27 must
   never re-read them to recompute ATR.
2. `RegimeConfig.minBars` — RESOLVED: reserved hysteresis slot per spec 19's explicit
   deferral ("if it proves noisy in backtesting, a `regime.minBars` is the documented
   place to add it"); not consumed in this phase — classification stays per-bar.
3. Numbering — RESOLVED: Option A confirmed; spec-19 remains the behavioral authority,
   spec-27 is the implementation-closure phase (matches repository convention).
4. `MarketRegimeSnapshot.strength` — RESOLVED: display-only per spec 19 ("stays a display
   value, not an engine input"); Spec 27 never produces it.
