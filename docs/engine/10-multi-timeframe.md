# 10 — Multi-Timeframe Engine

Three timeframes play three different roles. They are **never averaged into a mush** — each has a
defined job, and disagreement produces a named conflict state, not a guessed bias.

## Roles

| Role               | Timeframe | What it provides                                                                                |
| ------------------ | --------- | ----------------------------------------------------------------------------------------------- |
| HTF (context)      | e.g. 4H   | Trend state, bias, HTF zones, HTF liquidity pools — the frame the opportunity lives in.         |
| ITF (structure)    | e.g. 1H   | Structure inside the HTF context: which HTF zone price is in, whether ITF structure agrees.     |
| ETF (confirmation) | e.g. 15M  | Confirmation: sweeps, displacement, CHOCH on the entry timeframe — evidence timing, never bias. |

- One symbol's default set is `(4H, 1H, 15M)` — parameterised as `mtf.set`, not hard-coded.
- Each timeframe runs the **full** earlier pipeline independently (swings → structure → liquidity
  → zones → momentum). MTF only _combines_ those outputs — it computes nothing new about price.

## Alignment model

Each timeframe contributes a **signed vote** on direction, `v ∈ {−1, 0, +1}`:

- `v = +1`: `bias = bullish` (structure trend or momentum bias — the stage that defined it is
  recorded as `source`).
- `v = −1`: bearish. `v = 0`: `neutral`/`transition`/insufficient data.

`alignmentScore = 0.5·v_htf + 0.3·v_itf + 0.2·v_etf` — HTF dominant because context dominates
confirmation; weights are `mtf.weights` params.

## Confluence/conflict truth table

The 27 sign-combinations reduce to named states. **Mixed signs are never silently resolved.**

| HTF | ITF | ETF | State                    | Interpretation                                                                                                                                                                                                          |
| --- | --- | --- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| +1  | +1  | +1  | `aligned_bull`           | Full agreement — strongest context.                                                                                                                                                                                     |
| −1  | −1  | −1  | `aligned_bear`           |                                                                                                                                                                                                                         |
| +1  | +1  | −1  | `pullback_in_trend_bull` | ETF pullback inside aligned uptrend — wait for ETF realignment (sweep/CHOCH bullish) into ITF/HTF demand.                                                                                                               |
| −1  | −1  | +1  | `pullback_in_trend_bear` | Mirror.                                                                                                                                                                                                                 |
| +1  | −1  | +1  | `realigning_bull`        | **The example case.** ETF re-aligns with HTF while ITF still shows the pullback — a _developing_ continuation watch, **not bullish**. Requires an ITF-level event (bullish BOS/CHOCH or ITF momentum flip) to graduate. |
| −1  | +1  | −1  | `realigning_bear`        | Mirror.                                                                                                                                                                                                                 |
| +1  | −1  | −1  | `countertrend_bear`      | Lower frames voting against HTF — HTF bias intact but challenged; setups in ETF direction are flagged countertrend.                                                                                                     |
| −1  | +1  | +1  | `countertrend_bull`      | Mirror.                                                                                                                                                                                                                 |
| ±1  | 0   | ±1  | `htf_dominant`           | ITF neutral: HTF bias holds, ETF may confirm entries.                                                                                                                                                                   |
| 0   | ±1  | ±1  | `ltf_directed`           | No HTF context — lower frames can only produce `developing` setups, never `confirmed`.                                                                                                                                  |
| 0   | 0   | ±1  | `no_context`             | ETF alone cannot create a setup.                                                                                                                                                                                        |
| 0   | 0   | 0   | `neutral`                | Nothing is asserted.                                                                                                                                                                                                    |

Two rules that protect honesty:

1. **`realigning_*` is never bullish/bearish.** It maps to `transition` bias — the UI and scoring
   treat it as a watch state until ITF structure agrees (BOS/CHOCH/confirmed momentum flip).
2. **ETF can only confirm, never set, direction.** A `+1` ETF vote inside `−1` HTF produces
   `countertrend_*` or `realigning_*` — never a bullish bias.

## HTF elements consumed

- **HTF zones:** an ITF/ETF setup whose entry sits inside an HTF same-direction zone gets the
  `htfAligned` flag — a scoring input (05). Opposing HTF zone = `htfConflict` penalty.
- **HTF liquidity:** an ETF sweep of an HTF pool is stronger evidence than an ETF sweep of a local
  level (`liquidityContext` in scoring).
- **HTF structure:** `htfProtectedHigh`/`htfProtectedLow` bound the current trade context; an ITF
  break of the HTF protected level is an HTF CHOCH and ends the aligned state immediately
  (re-evaluation, not assumption).

## Conflict handling rules (deterministic)

- Re-evaluation at every ETF/ITF/HTF bar close that confirms new structure — votes are snapshots,
  and `alignmentScore` is recomputed, never persisted as truth.
- `alignmentScore ≥ 0.8` required for `confirmed` setups; `0.5–0.8` caps setups at `developing`;
  `< 0.5` or mixed states → countertrend/watch only.
- Tie-breaks are impossible by construction — there are no floating comparisons that can tie;
  votes are discrete.

## Point-in-time

HTF state at bar `t` (entry timeframe) is the HTF output as of the **last HTF bar whose close
precedes `t`** — the engine never uses an HTF bar that is still forming relative to the entry
timeframe. This is the MTF version of the no-look-ahead rule and is enforced by carrying each
timeframe's `lastConfirmedBarTime` forward.

## Test requirements

- Fixtures: the (+,−,+) example must yield `realigning_bull`, not `aligned_bull`; (+,+,−) →
  `pullback_in_trend_bull`; full disagreement (−,+,+) → `countertrend_bull`; ITF neutral →
  `htf_dominant`; insufficient HTF history → `no_context`.
- Property: `realigning_*` never produces a directional `bias` output.
- Property: HTF bar not yet closed relative to ETF never contributes.

## Implementation notes (Phase 4G — `src/lib/engines/mtf.ts`)

> **MTF alignment is contextual analysis, not a trading signal.** The engine emits a
> snapshot (`MultiTimeframeAlignment`) — no events, no scores beyond the spec's weighted vote.

- **Vote precedence.** `voteOf` takes `structure.bias` first, `momentum.bias` only when
  structure is neutral — the spec's "(structure trend or momentum bias)" without an order;
  structure is the primary stage. The supplying stage is recorded in `sources` (added to
  `MultiTimeframeAlignment` — the spec requires "the stage that defined it is recorded").
- **ETF-silent rows.** The spec table lists 23 of 27 combos; the four `ETF = 0` rows with
  HTF≠0 and ITF≠0 follow spec rule 2 ("ETF confirms, never sets direction"):
  `(±,±,0)` same-sign → `aligned_*`; `(±,∓,0)` → `countertrend_*`. Documented, not silent.
- **Temporal join.** `closedIndexAt(candles, tf, asOf)` returns the last bar whose
  `barCloseTime ≤ asOf` (binary search). A bar closing exactly at `asOf` IS visible (bar
  data is knowable at close — consistent with every engine's confirmation model). `1M`
  closes at the next UTC month start — `alignFloor` calendar semantics, never a fixed ms.
- **Contract scope.** `MultiTimeframeEngine` receives snapshot inputs
  (`{ structure, momentum }` per frame) — causality is enforced at the join: consumers take
  each frame's `stateAt(closedIndexAt(candles, tf, asOf))`. The engine itself can't leak —
  it only sees the snapshots it's given. `meta.barsConsumed` is `{-1,-1}` (no direct bars).
- **Missing data.** A frame with neutral structure + neutral momentum votes 0 — the named
  states (`no_context`, `ltf_directed`, `htf_dominant`) represent insufficiency explicitly;
  nothing is fabricated.
- **`computedAt`** = `max(structure.updatedAt)` across frames — deterministic, never
  wall-clock.
- **Validation.** `mtf.weights` ≥0 sum to 1.0; `mtf.set` must equal the supplied frames'
  timeframes (caller bug otherwise → `invalid_config`).

### Reconciliation (Phase 4G patch)

- **Canonical causal join.** `causalFramesAt(roles, asOf)` is the canonical path — each role
  supplies `{ timeframe, candles, at(idx) }` where `at` wraps the `*StateAt` functions of
  phases 4B–4F; the join enforces `barCloseTime ≤ asOf` internally (`closedIndexAt` binary
  search) and returns `{ timeframe, barIndex, snapshot }` per role. `barIndex` is the causal
  boundary recorded for audit. No closed bar → `null` frame — never fabricated.
- **`causalAlignAt(symbol, roles, weights, asOf)`** composes join → votes → alignment in one
  call; missing frames vote 0 (insufficient → `no_context`/`ltf_directed`/`neutral`).
- **Liquidity/zones/FVG are MTF context, not votes.** Spec "HTF elements consumed" targets
  *setup scoring* (05: `htfAligned`, `htfConflict`, `liquidityContext`, `htfProtected*`) —
  downstream consumers, not this alignment contract. `FrameSnapshot` carries them
  (`liquidity`, `zones`, `imbalances`) through the causal join so consumers get the legally
  visible sets **without** recomputing or touching `MultiTimeframeAlignment`. No new fields
  on the alignment type — the vote model is unchanged.
- **`barsConsumed = {-1,-1}`** retained and now documented: this stage consumes computed
  snapshots, not candle bars.
- **Replay equivalence**: `causalAlignAt` at T over a full series ≡ the same over a
  truncated prefix ≡ `stateAt(idx)` per frame — verified at ±1ms around close boundaries.
- **`1M`** joins via `barCloseTime` → next UTC month boundary (Dec→Jan, Jan→Feb,
  Feb-leap/non-leap→Mar) — calendar, never fixed ms.
