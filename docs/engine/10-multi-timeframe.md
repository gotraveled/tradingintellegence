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
