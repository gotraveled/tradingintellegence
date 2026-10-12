# 13 — Breakout Setups

A breakout setup trades the _acceptance_ of price beyond a well-defined range boundary — not the
cross itself. A wick through a level is never a breakout (spec 04 makes the same distinction for
pools).

## Parameters

| Parameter                   | Default | Meaning                                                                                 |
| --------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `breakout.rangeMinBars`     | `15`    | Bars the compression must span.                                                         |
| `breakout.rangeMaxWidthAtr` | `2.5`   | `max(high) − min(low)` of the range ≤ this × ATR.                                       |
| `breakout.compressionRatio` | `0.7`   | Mean range of last `compressionBars` ÷ full-range mean ≤ this — contracting volatility. |
| `breakout.compressionBars`  | `10`    | Tail window for the compression test.                                                   |
| `breakout.breakAtr`         | `0.15`  | Close beyond boundary by this × ATR = breakout attempt.                                 |
| `breakout.dispMinScore`     | `60`    | Breakout leg `displacementScore` required.                                              |
| `breakout.holdBars`         | `5`     | Bars price must stay beyond (acceptance).                                               |
| `breakout.retestWindow`     | `10`    | Bars in which a retest is valid.                                                        |
| `breakout.volumeMinRatio`   | `1.3`   | Breakout-bar volume ≥ this × median(20) — optional when volume exists.                  |

## Definitions

| Term                  | Deterministic rule                                                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `range`               | Last `rangeMinBars`+ bars where `max(high) − min(low) ≤ rangeMaxWidthAtr × ATR` and structure state is `range`. Boundaries: `resistance = max(high)`, `support = min(low)` over the range — each is also a `range_high`/`range_low` pool (04). |
| `compression`         | `mean(range of last compressionBars) ÷ mean(range of range) ≤ compressionRatio` — contraction measured on the range tail.                                                                                                                      |
| `breakout attempt`    | A closed bar with `close > resistance + breakAtr × ATR` (bullish) or `close < support − breakAtr × ATR` (bearish). **Close only — a wick beyond the boundary is nothing.**                                                                     |
| `displacement`        | The breakout bar or the next `dispBars` bars produce `displacementScore ≥ dispMinScore`.                                                                                                                                                       |
| `volume confirmation` | Breakout-bar volume ≥ `volumeMinRatio ×` median 20-bar volume — where volume exists; skipped with redistribution otherwise.                                                                                                                    |
| `acceptance`          | `holdBars` consecutive bars after the break with **no close back inside** the range.                                                                                                                                                           |
| `retest`              | After acceptance (or in lieu of it, within `retestWindow`), a bar returns to the boundary (`low ≤ resistance + 0.1×ATR` for bullish) and **closes back on the breakout side** — the broken resistance holds as support.                        |
| `continuation`        | After acceptance/retest, a bar closes further beyond (higher high than breakout bar for bullish) — follow-through.                                                                                                                             |

## Lifecycle (spec 18 machine)

| State                               | Trigger                                                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `developing`                        | Range identified + compression true — before any close beyond.                                                                      |
| `confirmed`                         | Breakout attempt + displacement (+ volume where available). `confirmed` ≠ traded — the level is not yet accepted.                   |
| `active`                            | Acceptance (`holdBars` clean) **or** a successful retest — the setup is tradeable. Entry band = the broken boundary ± `0.25 × ATR`. |
| `partial_target` / `target_reached` | T1 = `range height` projected from the boundary (measured move); T2 = nearest opposing pool/zone.                                   |
| `invalidated`                       | Close back inside the range beyond `support`/`resistance` by `invalidateAtr` — the "successful breakout" assessment fails (04).     |
| `expired`/`cancelled`               | `retestWindow` elapses without acceptance or retest → `expired`; an opposing CHOCH before confirmation → `cancelled`.               |

## Breakout vs the lookalikes (cross-referenced to spec 04)

|                    | Wick only         | Close beyond                 | Reclaim inside         | Holds/follows through            |
| ------------------ | ----------------- | ---------------------------- | ---------------------- | -------------------------------- |
| Liquidity sweep    | yes (penetration) | no — or if so, reclaims fast | **required**           | displacement _against_ the level |
| Breakout attempt   | **no**            | yes                          | —                      | pending                          |
| False breakout     | —                 | yes                          | yes, within `holdBars` | —                                |
| Confirmed breakout | —                 | yes                          | no                     | acceptance or retest-hold        |

The setup machine consumes the liquidity-stage labels directly — a bar cannot be both a sweep and
a breakout attempt (sweep classification wins when reclaim follows).

## Bullish vs bearish

Mirror across `support`/`resistance`: bullish breaks `resistance` toward buy-side liquidity;
bearish breaks `support` toward sell-side. Measured-move targets project the range height from
the boundary in the break direction.

## MTF rule

`htf_aligned` bonus when the break direction agrees with HTF bias; `countertrend` when it fights
HTF — never auto-confirmed.

## Test requirements

- Fixtures: compressing range → close-beyond + displacement → 5 clean bars (confirmed → active);
  same but re-entry at bar 3 (false breakout — no setup, liquidity event only); wick-through
  (nothing emitted); retest at bar 7 that holds (active via retest); measured-move target hit.
- Property: no `developing` state before a range qualifies (`rangeMinBars` + width + compression).
- Property: a setup can never reach `confirmed` on a wick.

## Implementation notes (Phase 4I)

- **Canonical consumption.** `detectBreakouts({ candles, at(idx) })` walks closed bars
  chronologically; `at(idx)` supplies per-bar `*StateAt` snapshots (structure/pools/zones/
  momentum) plus the 4G `causalAlignAt` alignment and `FrameSnapshot.events`. The range itself
  is measured on candles per this spec's definition — it is a setup-level entity, not an
  upstream one. `createBreakoutSetupEngine()` satisfies the `SetupDetectionEngine` contract.
- **Developing is emitted as a pair.** Direction is unknowable pre-break, so a qualifying range
  creates a bullish (resistance-anchored) and a bearish (support-anchored) `developing` setup.
  The untaken side expires (`range_lost`/`stalled`) or is cancelled by an opposing CHOCH —
  it can never "confirm" from the opposite direction's evidence.
- **Anchors.** The boundary pool (`sources` includes `range_high`/`range_low`, matching side)
  is the anchor within `breakout.anchorNearAtr`×ATR — **source: config** (spec ties the
  boundary to a pool but defines no match tolerance; the value is caller-supplied, not a
  hidden constant). Id `bo:{symbol}:{tf}:{dir}:{anchorPoolId|rng:rangeStart}`; nearest pool
  wins, ties by id. A missing pool is explicit (`B3` unmet, `anchorPoolId: null`).
- **Sweep classification wins.** An attempt is disqualified when the boundary pool is
  sweep-tagged (`poolStatusAt === "swept"` or a knowable `sweep_*`/`false_breakout` event on
  the anchor). Post-attempt, that classification invalidates the setup (`boundary_*` reason).
- **False breakout / acceptance — source: spec.** Any inside-close before acceptance →
  `invalidated` (`false_breakout`, lookalikes table: "reclaim inside, within `holdBars`");
  a close exactly ON the boundary is outside. After `active`, only a close past
  `boundary ∓ lifecycle.invalidateAtr×ATR` invalidates (`close_through_invalidation`) —
  shallow inside-closes are permitted retest depth, never a retroactive false breakout.
  Wicks never trigger either rule — close-only throughout.
- **`dispBars` window — `breakout.dispBars`, source: config (spec-required).** Spec 13's
  "breakout bar or the next `dispBars` bars" is a setup-side detection window — semantically
  distinct from `holdBars` (acceptance) and `momentum.disp.bars` (leg-scoring window in 09).
  The setup contract lacked the parameter, so it was added to `BreakoutConfig` as the
  smallest additive typed change; callers should pass `momentum.disp.bars`-consistent values.
  Window is `[attemptBar, attemptBar+dispBars]` inclusive; expiry precedes confirm so a late
  score can never confirm outside it.
- **Volume.** Evaluated once at the attempt bar; `median(20)` needs 20 volume-carrying bars —
  otherwise skipped (spec: "skipped with redistribution otherwise"), `B6` marked accordingly.
- **Retest/entry band constants.** The `0.1×ATR` retest touch and `0.25×ATR` entry band are
  spec-literal constants (same convention as spec 04's `approachAtr`), not config.
- **MTF.** `htfBias` = `votes.htf` sign (state-label fallback); a fighting HTF blocks
  `confirmed` while it persists — "never auto-confirmed". Missing alignment is explicit
  (`B7` unmet) but not a veto.
- **`expired` paths.** `range_lost` (range ceases to qualify / suffix start shifts),
  `stalled` (`lifecycle.expiryBars`), `attempt_unconfirmed` (disp window elapsed),
  `retest_window` (spec's named expiry for confirmed setups).
- **Targets — source: spec.** T1 = range height projected from the boundary (measured move);
  T2 = the single nearest opposing pool/zone level beyond the boundary in the break direction
  (resting pools, active zones; snapshot-derived at candidate bar). Ordered by distance;
  equal levels dedupe (float-normalized). Missing opposition → T1 only — explicit, never
  fabricated.
- **`score: 0`** placeholder — spec 15; targets/entry band in `metadata` are lifecycle
  evidence, not a trade plan (doc 16).
