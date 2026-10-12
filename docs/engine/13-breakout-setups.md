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
