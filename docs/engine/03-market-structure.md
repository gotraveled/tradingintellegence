# 03 — Market Structure

Structure detection classifies confirmed swings (02-swing-detection.md) and detects break events
(BOS, CHOCH). All rules consume **confirmed** swings only — developing swings never participate.
This keeps the whole stage look-ahead-free: at bar `t`, only swings with `confirmedIndex <= t` and
structure events confirmed at or before `t` exist.

## Parameters

| Parameter                        | Default | Meaning                                                                |
| -------------------------------- | ------- | ---------------------------------------------------------------------- |
| `structure.classifyToleranceAtr` | `0.05`  | Swings within this × ATR are equal — not higher/lower.                 |
| `structure.minBreakAtr`          | `0.1`   | A close must exceed the level by this × ATR to break it.               |
| `structure.failedBreakBars`      | `3`     | Bars allowed after a break before a close back inside marks it failed. |
| `structure.minSwingsForTrend`    | `3`     | Confirmed swings required before any trend is asserted.                |

## Swing classification — HH / HL / LH / LL (+ EH / EL)

Each newly **confirmed** swing is compared to the previous confirmed swing **of the same kind**.
`tol = structure.classifyToleranceAtr × ATR` at the pivot.

**Highs.** Against the previous confirmed swing high at price `Pₕ`:

| Condition          | Classification | Meaning     |
| ------------------ | -------------- | ----------- |
| `price > Pₕ + tol` | `HH`           | Higher high |
| `price < Pₕ − tol` | `LH`           | Lower high  |
| `                  | price − Pₕ     | ≤ tol`      | `EH` | Equal high — liquidity cluster, not trend information |

**Lows.** Against the previous confirmed swing low at price `Pₗ`:

| Condition          | Classification | Meaning    |
| ------------------ | -------------- | ---------- |
| `price < Pₗ − tol` | `LL`           | Lower low  |
| `price > Pₗ + tol` | `HL`           | Higher low |
| `                  | price − Pₗ     | ≤ tol`     | `EL` | Equal low |

- EH/EL are real classifications: equal extremes are liquidity pools (04-liquidity.md), and they
  do **not** update trend state.
- If no previous confirmed same-kind swing exists, `classification` is absent — there is no first
  HH or first HL.
- Comparison skips invalidated swings: a swing invalidated by a later close through it is removed
  from the comparison chain.

## Trend state

Derived from the two most recent confirmed swings of each kind (minimum
`structure.minSwingsForTrend` total confirmed swings, otherwise `transition`):

| Last high                                        | Last low | Trend state  |
| ------------------------------------------------ | -------- | ------------ |
| `HH`                                             | `HL`     | `uptrend`    |
| `LH`                                             | `LL`     | `downtrend`  |
| `EH` or `EL` dominant, or price bound by a range | —        | `range`      |
| any other combination                            | —        | `transition` |

`transition` is an honest "between regimes" state — the engine never forces a trend label onto
mixed structure.

## The protected level

At any moment in an `uptrend`, the **protected level** is the most recent confirmed `HL` (the
higher low that produced the last `HH`). In a `downtrend`, it is the most recent confirmed `LH`.
The protected level is the swing whose break would end the current sequence — it is where
opposing traders' stops concentrate and where CHOCH is measured.

## BOS — Break of Structure

A BOS is a **trend-continuing** break: price closes beyond the most recent confirmed extreme
**in the direction of the current trend**.

### Bullish BOS

- **Requires:** trend state `uptrend` and a confirmed swing high `Sₕ` — the one that established
  the current leg (the latest `HH`, or the first confirmed high if no `HH` exists yet).
- **Rule:** a closed bar with `close > Sₕ.price + structure.minBreakAtr × ATR`.
- **Candle-close vs wick:** only the **close** counts. A wick beyond `Sₕ.price` without a
  qualifying close is an _attempted break_ — recorded as a liquidity interaction (04), never a BOS.
- **Confirmed at:** the close of the breaking bar. `StructureBreak.confirmed = true`,
  `time` = that bar's open time.
- **Effect:** emits a BOS event; trend state remains `uptrend`; the swing high becomes a
  _broken level_ (eligible for retest analysis) and a new protected level is established once the
  next `HL` confirms.

### Bearish BOS

Mirror: `close < Sₗ.price − minBreakAtr × ATR` where `Sₗ` is the swing low defining the current
down leg in a `downtrend`.

## CHOCH — Change of Character

A CHOCH is a **counter-trend** break: a close through the **protected level**, signalling the
current sequence has ended.

### Bullish CHOCH (downtrend → potential reversal)

- **Requires:** trend state `downtrend` and a confirmed `LH` — the protected level.
- **Rule:** a closed bar with `close > LH.price + minBreakAtr × ATR`.
- **Close-only**, same as BOS. Wick through the protected high is an attempted break only.
- **Confirmed at:** close of the breaking bar.
- **Effect:** emits a CHOCH event and sets trend state to `transition`. A CHOCH does **not**
  assert a new trend — reversal is confirmed only when the follow-up sequence prints: a confirmed
  `HL` and then a bullish BOS (close beyond the CHOCH high). Until then the market is in
  transition.

### Bearish CHOCH (uptrend → potential reversal)

Mirror: `close < HL.price − minBreakAtr × ATR` on the protected `HL` in an `uptrend`.
Reversal requires a subsequent confirmed `LH` and a bearish BOS.

## Required swing sequences

| Event                      | Minimum structure                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Bullish BOS                | uptrend (confirmed `HL` + `HH`) or an established up leg with a confirmed high to break |
| Bearish BOS                | downtrend (confirmed `LH` + `LL`) or established down leg                               |
| Bullish CHOCH              | downtrend with a confirmed `LH` as protected level                                      |
| Bearish CHOCH              | uptrend with a confirmed `HL` as protected level                                        |
| Full reversal (post-CHOCH) | CHOCH + opposite-class swing confirmed (`HL`/`LH`) + BOS in new direction               |

## Break invalidation — the failed break

A confirmed BOS/CHOCH is an immutable historical fact — it happened. What can change is the
**assessment** of it:

- If price closes back inside the broken level within `structure.failedBreakBars` of the break
  (bullish: `close < level − minBreakAtr × ATR`; bearish mirror), the break is marked
  `failed = true` with `failedAt` recorded.
- A failed BOS downgrades trend state to `transition`. A failed CHOCH cancels the pending
  reversal and restores the prior trend state (the sequence is intact again).
- `failed` is metadata on the `StructureBreak`, not deletion — outcomes and audit trails keep the
  full record.

## Edge cases

- **Break at the exact level:** `close = level` is not a break. The `minBreakAtr` margin must be
  exceeded.
- **Gap through the level:** in gapped markets the first candle may open and close beyond the
  level — a valid break; penetration is measured from the close, not the gap size.
- **Multiple consecutive closes:** only the first qualifying close emits the event; subsequent
  closes beyond are follow-through, not new breaks.
- **Equal extremes:** breaking an `EH`/`EL` cluster is treated as breaking one level (the cluster
  representative), not two.
- **Insufficient swings:** fewer than `minSwingsForTrend` confirmed swings → trend `transition`,
  no BOS/CHOCH detection (nothing is "protected").
- **Simultaneous break and swing confirmation:** swing confirmation takes priority — the engine
  processes bars in order: confirm swings first, then test breaks, so a break is always measured
  against the state at the start of that bar.

## Test requirements

- Fixtures: clean uptrend (HL→HH→HL→HH), clean downtrend, CHOCH-and-fail (bearish CHOCH, close
  back inside within 3 bars), wick-only penetration (must emit **no** event), equal-highs break
  (single event), gap-through (first close counts).
- Property: at bar `t`, no `StructureBreak` is emitted whose confirmation bar is `> t`.
- Property: a BOS can never occur while trend state is `transition` or `range`.

## Implementation notes (Phase 4B — `src/lib/engines/structure.ts`)

Points where the spec left room for interpretation — recorded, not silently changed:

- **ATR source.** `StructureConfig` has no `atrLength`; the spec writes `× ATR` unqualified.
  The implementation uses the **reference swing's `metadata.atrAtPivot`** (computed by the
  Swing Engine at its own `atrLength`) for both `classifyToleranceAtr` and `minBreakAtr`
  margins. Deterministic, scale-free, and consistent — a level's margin was already measured
  at its own formation volatility. Missing `atrAtPivot` degrades to a pure close beyond the
  level (margin 0).
- **"State at the start of that bar."** Read as: at bar `t`, swing confirmations are applied
  first (spec's own priority), then BOS/CHOCH are evaluated against the updated state — a bar
  may confirm the trend and break a pre-existing level on the same close. Only information
  knowable at `t` is ever used; `structureStateAt(t)` truncates identically.
- **"EH or EL dominant."** Implemented as: if the most recent confirmed high classifies `EH`
  or the most recent confirmed low classifies `EL`, trend is `range`. Any single equal
  classification flags range until a non-equal swing arrives — deterministic and honest about
  bound markets.
- **Protected level.** Most recent confirmed `HL` in an uptrend / `LH` in a downtrend —
  tracked as classification-time state, never re-derived from closes.
- **Swing output is point-in-time.** `structure.swings` contains only swings whose
  `confirmedIndex ≤ end` — a truncated snapshot cannot leak later confirmations.
- **Failed-break window.** Assessment runs on bars `breakIndex+1 … breakIndex+failedBreakBars`;
  expiry without a close back inside leaves the break standing. Failed CHOCH restores the
  `structureBefore` trend; failed BOS forces `transition`.
- **`swings` ingestion order.** Swings confirming on the same bar ingest in `pivotIndex` order;
  invalidations apply before ingestions on the same bar (a dead reference never classifies).
- **`MarketStructure.swings`** includes confirmed and invalidated swings that participated;
  developing/superseded swings are excluded by contract (confirmed-only input).
- **Event ids** `sb:{symbol}:{tf}:{type}:{dir}:{refSwingId}:{breakTime}` — a `break_failed`
  event reuses its break's refId intentionally (it annotates the same event).
