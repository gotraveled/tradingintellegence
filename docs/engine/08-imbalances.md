# 08 — FVG / Imbalance Engine

> **This is the canonical FVG/Imbalance definition for the platform.** `src/lib/engines/imbalances.ts`
> is the only authoritative implementation — other engines must not re-implement FVG detection;
> they reference canonical `Imbalance` entities via the deterministic `fvgId` format.

A fair value gap is a 3-candle displacement pattern that leaves an unfilled price range — evidence
of urgency. Not every 3-candle gap matters: size relative to volatility is the filter.

## Parameters

| Parameter            | Default | Meaning                                                                   |
| -------------------- | ------- | ------------------------------------------------------------------------- |
| `fvg.minGapAtr`      | `0.15`  | Gap size must be ≥ this × ATR at the middle bar — tiny gaps are noise.    |
| `fvg.minMidBodyAtr`  | `0.3`   | Middle candle body ≥ this × ATR — gap without displacement is not an FVG. |
| `fvg.partialFillPct` | `50`    | Penetration ≥ this % of gap height → `partially_filled`.                  |
| `fvg.invalidateAtr`  | `0.1`   | Close beyond the far boundary by this × ATR → `invalidated`.              |
| `fvg.expiryBars`     | `200`   | Bars without fill progress → `expired` (diagnostic).                      |

## The exact three-candle relationship

**Bullish FVG** at bars `(i, i+1, i+2)`, all closed:

```
low[i+2] > high[i]                        — strict: no overlap between candle 1 top and candle 3 bottom
gap = low[i+2] − high[i]                  — the unfilled band
gap ≥ fvg.minGapAtr × ATR[i+1]
|close[i+1] − open[i+1]| ≥ fvg.minMidBodyAtr × ATR[i+1]
close[i+1] > open[i+1]                    — middle candle is bullish (displacement)
```

- `upperPrice = low[i+2]` (top of the gap), `lowerPrice = high[i]` (bottom).
- **Bearish FVG** mirrors: `high[i+2] < low[i]`, `gap = low[i] − high[i+2]`, middle candle bearish;
  `upperPrice = low[i]`, `lowerPrice = high[i+2]`.

## Why the middle-candle rule

A gap between candles 1 and 3 with a flat middle candle is a data artifact (illiquid print, bad
tick), not displacement. Requiring `minMidBodyAtr` + direction means the FVG is always produced
by a bar with range — which is also what makes it measurable evidence. ATR normalization (not
percentage) keeps thresholds meaningful across BTC, gold, forex, and stocks; gap size is always
recorded in ATR units (`gapAtr`).

## Fill tracking (mitigation)

`fillPct` = deepest penetration into the gap as % of gap height, monotonic while open.

| State              | Definition                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `open`             | `fillPct < partialFillPct`. No bar has traded halfway through the gap.                                           |
| `partially_filled` | `fillPct ≥ 50%` — price entered the gap significantly but has not crossed the far boundary.                      |
| `filled`           | A bar **trades through** the far boundary (bullish FVG: `low ≤ lowerPrice`). Wick counts — the gap is delivered. |
| `invalidated`      | A bar **closes** through the far boundary by `invalidateAtr` — stronger than filled: the gap failed as a level.  |
| `expired`          | `fvg.expiryBars` without progress — diagnostic removal.                                                          |

- `partially_filled` is a threshold state: penetration below 50% leaves it `open` (with
  `fillPct` still recorded — the UI can show progress without flipping status early).
- `filled` and `invalidated` differ by **wick vs close**: a wick through delivers the gap
  (filled), a close through invalidates it (the imbalance offered no defence). A close through
  always implies `fillPct = 100`.

## Relationship to zones and sweeps

- An FVG created on a zone's departure leg links via `zone.fvgId` (05) and is a zone-strength
  input while `open`.
- A standalone FVG is a valid zone-of-interest even without a formal zone — it is recorded as an
  `Imbalance` entity; setup detection may use it as a refinement level inside a larger zone.
- FVGs inside a swept-pool's reclaim leg are the highest-signal kind (sweep + displacement +
  imbalance) — recorded in `metadata` for setup scoring.

## Point-in-time rules

- An FVG is **knowable** at the close of bar `i+2` — that is its `createdAt` and the first bar a
  backtest may see it.
- `fillPct` and `status` update on every subsequent closed bar only.

## Edge cases

- **Overlapping FVGs:** consecutive FVGs in the same direction are separate entities — never
  merged (each records its own 3-bar evidence).
- **Gap at session boundary:** in sessioned markets, an overnight gap followed by two qualifying
  candles is a valid FVG — the mechanics are identical; `metadata.spansSession` records it.
- **Nested FVG:** a smaller FVG inside a larger one is emitted separately (confluence, not error).

## Test requirements

- Fixtures: textbook bullish FVG (minGap just met), bullish with oversized gap, middle-candle
  flat (rejected), gap below `minGapAtr` (rejected — the tiny-gap filter), 49% wick (stays open),
  51% wick (partially_filled), wick through far boundary (filled), close through (invalidated).
- Property: `gap ≥ minGapAtr × ATR` holds for every emitted FVG — no exceptions.
- Property: `fillPct` monotonic while `open`/`partially_filled`.
- Property: mirroring bullish fixtures produces identical bearish lifecycle.

## Implementation notes (Phase 4E — `src/lib/engines/imbalances.ts`)

- **Config gap resolved.** The spec's `ATR[i+1]` thresholds presuppose an ATR series but no
  window parameter existed in `FVGConfig` — added `fvg.atrLength` (typed; caller-injected,
  same convention as `liquidity.range.lookbackBars` and `zone.leg`). `ATR[i+1]` = mean TR of
  the `atrLength` bars ending at the middle candle; frozen at formation and reused for the
  `invalidateAtr` margin.
- **Events.** `fvg_created` at candle C's close; `fvg_filled` at the wick-through bar.
  `partially_filled`, `invalidated`, `expired` have no `DetectionEventKind` — status +
  diagnostics only, consistent with pool/zone conventions.
- **Expiry reference.** "No fill progress" = `fillPct` has not increased since
  `lastProgressBar` (creation or latest deeper dip). A shallower dip is not progress.
- **Invalidation wins over fill** — a close through the far boundary is the stronger signal
  (spec 08: close rules). `fillPct` is recorded as 100 on both terminal states.
- **`Imbalance.metadata` added** — the spec requires `spansSession` and relationship hints
  "recorded in metadata for setup scoring"; the field was absent from the domain type.
- **Sweep/structure relationships.** The `ImbalanceEngine` contract is `{ series, config }`
  only — no pools or structure input — so sweep/BOS/CHOCH associations are left to
  downstream consumers (they hold all upstream outputs). `spansSession` is computed from
  `candle.sessionId` when present.
- **Phase 4D compatibility.** `zones.ts` now imports the canonical `fvgId` (identical string
  format — pure de-duplication of the ID template). The zone-side **link heuristic** is the
  literal spec-05 three-bar predicate — a superset match with no ATR thresholds, since
  `FVGConfig` is not in the `ZoneEngine` contract. A `zone.fvgId` is therefore a *candidate*
  link: consumers must verify membership against the canonical `Imbalance[]` output — a
  linked id may not exist there if the gap fails `minGapAtr`/`minMidBodyAtr`. Documented,
  not silently reconciled (per Phase 4E §0).
