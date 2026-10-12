# 02 — Swing Detection

Swings are the atomic building blocks of structure, liquidity, and zones. This spec defines how
swing highs/lows are found, when they become _confirmed_, and how revisions are handled — without
look-ahead bias in backtesting.

## Terminology

- A **swing high** is a pivot bar whose high exceeds its neighbours within defined windows.
- A **swing low** is the mirror image on lows.
- `HH / HL / LH / LL` are _classifications_ applied later by structure detection, comparing a
  confirmed swing to the previous confirmed swing of the same kind. They are not properties of the
  swing itself.
- **Pivot index** `p`: the bar where the extreme occurred. **Confirmation index** `c`: the first
  bar at which the pivot is knowable without future data.

## Parameters

| Parameter                  | Default | Meaning                                                                 |
| -------------------------- | ------- | ----------------------------------------------------------------------- |
| `swing.leftBars`           | `3`     | Bars to the left of the pivot that must be below/above it.              |
| `swing.rightBars`          | `3`     | Bars to the right required for confirmation (the lookforward).          |
| `swing.atrLength`          | `14`    | ATR window (Wilder) used for significance tests.                        |
| `swing.minSignificanceAtr` | `0.25`  | Pivot must exceed its opposite neighbours by ≥ this × ATR at the pivot. |
| `swing.equalToleranceAtr`  | `0.05`  | Highs/lows within this × ATR are treated as equal.                      |
| `swing.mergeEqual`         | `true`  | Equal-extreme policy (see below).                                       |

All thresholds are multiples of ATR — never raw price or fixed percentages — so the rule scales
across instruments and regimes. Percentage thresholds are explicitly rejected: 2% means something
entirely different on a stable forex pair and a volatile crypto asset.

## Candidate detection

A closed bar `p` is a **candidate swing high** iff, for all `i` in `p-leftBars … p-1` and
`p+1 … p+rightBars` that exist and are closed:

```
high[i] < high[p]  OR  |high[i] − high[p]| ≤ equalToleranceAtr × ATR[p]
```

and the significance test passes:

```
high[p] − max(high[p−leftBars … p−1]) ≥ minSignificanceAtr × ATR[p]
```

Swing lows mirror this on `low`.

Only closed bars participate; a still-forming bar can neither be a candidate nor confirm one.

## Equal highs/lows

- Two extremes within `equalToleranceAtr × ATR` are **equal**.
- If `mergeEqual`, a run of equal candidate bars collapses to one swing anchored at the bar with
  the extreme value (ties → earliest bar). The merged swing's `metadata.equalCount` records how
  many bars participated — structure rules need this (equal highs/lows are liquidity pools).
- Equality is measured on the _extreme price_, not the bar index.

## Noisy markets

`leftBars`/`rightBars` are the primary noise filter. Additional rules:

- **Significance gate.** `minSignificanceAtr` rejects micro-pivots inside flat noise.
- **Dominance rule.** If a new candidate high forms while a _developing_ swing high is active and
  its price is higher, the new candidate supersedes the old — the old is discarded, never
  confirmed. This prevents two swing highs inside one advance.
- **Isolation rule.** Two confirmed same-kind swings must have an opposite-kind swing between
  them. A higher high before an intervening confirmed swing low replaces the developing/prior
  high rather than producing a second consecutive high.

## Lifecycle states

```
developing ──(candidate passes all tests, rightBars not yet closed)──→
   ├──→ confirmed   when `rightBars` closed bars after the pivot exist and pass the tests
   ├──→ superseded  a stronger/dominating candidate appears before confirmation (discarded)
   └──→ invalidated later price action breaks the level (see below)
```

- **Developing swing.** A candidate where `rightBars` bars have not yet closed. Not usable by
  structure classification; usable by liquidity rules flagged `unconfirmed`.
- **Confirmed swing.** Confirmation occurs at the **close** of bar `p + rightBars`. The
  confirmation index `c` is recorded — backtests may only "know" the swing from bar `c` onward.
- **Superseded swing.** Replaced by a dominating candidate pre-confirmation. Not an output
  entity; only visible in engine diagnostics.
- **Invalidated swing.** A _confirmed_ swing high is invalidated when a **closed** bar closes
  above `price + equalToleranceAtr × ATR` (mirror for lows). Intrabar wicks beyond the level do
  not invalidate — only closes count, keeping invalidation deterministic and wick-immune.
  Invalidation of a swing does not retroactively remove it from history; its `status` changes.

```ts
type SwingStatus = "developing" | "confirmed" | "superseded" | "invalidated";

interface SwingPoint {
  id: ID;
  symbol: string;
  timeframe: Timeframe;
  kind: "high" | "low";
  price: Price; // extreme price
  pivotIndex: number; // bar index of the extreme
  pivotAt: ISODateTime; // its open time
  confirmedIndex?: number; // first bar at which it was knowable
  confirmedAt?: ISODateTime;
  status: SwingStatus;
  invalidatedAt?: ISODateTime;
  metadata?: Metadata; // equalCount, atrAtPivot, paramsVersion
}
```

## Look-ahead control

- Every swing output carries `confirmedIndex`. A backtest at bar `t` must filter swings to
  `confirmedIndex <= t` (or `pivotIndex <= t` for developing swings where the consuming rule
  explicitly allows them).
- The engine exposes `state(atIndex)` — the exact set of swings and their statuses knowable at
  that bar. Tests replay history bar-by-bar and assert no output references a later bar.

## Revision handling

- Before confirmation: replacement via the dominance rule (cheap, frequent).
- After confirmation: no replacement. A confirmed swing is immutable except for `status`
  transitions to `invalidated`. If a "better" pivot was missed, it remains missed — confirmed
  history does not rewrite. Structure rules must cope via the isolation rule and key levels.

## Edge cases

- **Series start/end:** candidates need `leftBars` closed bars before them; the last `rightBars`
  bars can only ever produce developing candidates.
- **Flat runs:** equal extremes merge per `mergeEqual`; below-tolerance flatness cannot create
  candidates at all because the significance test fails.
- **Session gaps:** windows count **bars**, not clock time, so gaps neither shrink nor stretch
  the windows. `metadata.barsAroundGap` flags swings whose window spans a gap for downstream
  rules that distrust them.

## Test requirements

- Golden fixtures: trending, ranging, V-reversal, equal-highs pair, gap across a session open,
  and a noise-only series that must produce zero swings.
- Property: `state(t)` for `t < p + rightBars` never contains the swing as `confirmed`.
- Property: truncating the series at any bar yields the identical confirmed prefix.
- Sensitivity: `minSignificanceAtr` ↑ ⇒ swing count ↓; `leftBars`/`rightBars` ↑ ⇒ count ↓ and
  confirmation latency ↑.

## Implementation notes (Phase 4A — `src/lib/engines/swing.ts`)

Points where the spec left room for interpretation — recorded, not silently changed:

- **ATR startup.** Wilder ATR is defined for `i ≥ atrLength` (seed = SMA of `TR[1..atrLength]`,
  then smoothed). For `i < atrLength` — where early pivots live — `atr[i]` is the **mean of the
  available true ranges** `TR[1..i]`. Fully causal; never uses bars after `i`.
- **Equal-merge vs significance.** The significance gate uses the literal left-window maximum.
  A second equal bar inside the window has near-zero margin and is usually not a candidate —
  so `mergeEqual` effectively merges equal peaks separated by ≥ `leftBars` (the "equal highs
  as liquidity pool" case) plus any adjacent equal bars that do pass the gate. This is the
  literal-spec reading; tests cover both.
- **Dominance vs confirmed history.** The isolation rule says a higher high replaces "the
  developing/prior high". Reconciled with "confirmed history does not rewrite" as:
  a _developing_ open swing yields to any more-extreme candidate; a _confirmed_ open yields
  **only to a confirmed candidate** — a still-developing candidate may die and must never kill
  confirmed history. Less-extreme/absorbed candidates are diagnostics (`superseded`), never
  emitted. Confirmed pivots/prices are never rewritten — supersession is a status transition.
- **Merge into a confirmed open** (equal bar arriving after the first member confirmed) updates
  `equalCount`, anchor and `confirmedIndex` — the merged entity's `confirmedIndex` is the
  **max** of its members, so the merged data was never knowable earlier. Point-in-time safe.
- **`state(atIndex)`** is implemented by re-detection on the `0..t` prefix — guaranteed to match
  what a live pass knew at `t`. O(n·w) per call; backtests should batch-detect once and filter
  by `confirmedIndex <= t`.
- **Swing id**: `sw:{symbol}:{timeframe}:{kind}:{pivotTime}` — deterministic, never random.
- **Invalidation index** is additionally stored in `metadata.invalidatedIndex` alongside
  `invalidatedAt` for point-in-time filtering.
