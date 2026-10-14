# 26 — System-Level Historical Backtesting & Validation

> Status: **Approved** — Phase 9 implementation target. Depends on 00–25. Implemented in
> `src/lib/engines/backtest.ts` behind the `BacktestEngine` contract (20).

The system backtest answers: **"over a historical universe, what did the system observe at
each closed bar, and what happened to those observations afterwards?"** It is a thin
orchestration + recording + aggregation layer — **not a trade simulator**. It owns no
detection, scoring, lifecycle, or outcome semantics; every rule it applies is delegated to the
spec that owns it.

```text
cells[] (CandleSeries per symbol×timeframe) + window + selection + EngineConfig
   │
   ├─ batch upstream artifacts once per cell (swings→structure→pools→zones→imbalances)
   │
   ├─ EVALUATION PASS — per bar t ∈ window (causality-bounded):
   │     at(t) join  →  detectors (11–14)  →  status-at-t from setup_transition events
   │     →  score (15)  →  scanUniverse (25) at asOf = candle.time[t]
   │     →  BacktestOpportunity[] (ranked) + BacktestDeveloping[] — frozen at emit
   │
   ├─ OUTCOME PASS (Model B) — strictly after evaluation:
   │     measureOutcome (17) per unique observed setup over the FULL series
   │     →  SetupOutcome[] + outcomeRef stamped on matching records
   │
   └─ AGGREGATION — observation counts, unique setups, resolved outcomes,
         outcome buckets, rates, expectancy/median/total R
```

## Terminology

| Term | Definition |
| ---- | ---------- |
| cell | One `symbol × timeframe` evaluation unit holding a `CandleSeries`. |
| window | `BacktestWindow {startIndex, endIndex}` — bounds **observation generation** only (Model B). |
| observation | One frozen record: a ranked `BacktestOpportunity` or unranked `BacktestDeveloping`, emitted for one setup at one evaluation bar. |
| selection | `BacktestSelection` — run-level grammar (`topK`, `filters`) marking ranked observations `selected`; absent ⇒ field absent. |
| outcome row | One `SetupOutcome` (spec 17) per unique measurable setup — the ONLY thing that may consume post-`endIndex` candles. |
| outcomeRef | Optional join `BacktestOpportunity.setupId → SetupOutcome.setupId`. Never fabricated. |
| evaluation pass | The per-bar loop inside `window`; produces all evaluation-time fields. |
| outcome pass | The strictly-subsequent measurement loop; bounded by spec-17 eligibility, not by `window`. |

## Rules

### Cells & ordering

- Cells run in canonical order: `symbol` ascending → `timeframe` canonical (1m…1M).
- A cell whose series is empty or fails spec-01 validation is **skipped** — the run continues;
  skipped keys appear in `meta.diagnostics.cellsSkipped`. `cells[]` in the result echoes the
  canonical order (names only — never re-sorted by input order).
- `window.startIndex`/`endIndex` clamp to `[0, candles.length−1]`; a vacuous window skips the
  cell. `window` absent ⇒ full series.

### Evaluation pass — strict causality

- Upstream artifacts (02–08) are computed once per cell; every per-bar input is reconstructed
  through the causal `*StateAt(t)` providers — the same objects the spec-18 replay path uses,
  plus upstream `events` filtered to `atBar ≤ t`.
- Status-at-t derives ONLY from `setup_transition` events: last transition `≤ t`, else
  `developing`. A setup exists at `t` iff `metadata.candidateBar ≤ t` (else first transition,
  else `createdAt ≤ close[t]`).
- Candidates are scored (15) only in `SCOREABLE` states (`confirmed`, `active`,
  `partial_target`); the result feeds the candidate's `score` unchanged.
- `scanUniverse` runs once per bar with `asOf = candle.time[t]` (UnixMs — never the index),
  a one-cell universe, and the cell's `ScannerConfig`. Ranked output → `BacktestOpportunity`;
  `developing` bucket → `BacktestDeveloping` (never ranked, never selected).
- No cross-bar deduplication: dedup is spec-25's business **within one scan invocation**; a
  setup may legitimately repeat across evaluation bars.
- Records are **frozen at emit**: `setupId`, dims, `status` (at-t), `evaluatedAt`,
  `evaluatedIndex`, `rank`, `selected`, `score`, `scoreContributions`, `plan`,
  `statisticalEvidence`. Nothing written later may touch them — the ONLY post-emit field is
  `outcomeRef`, stamped by the outcome pass.

### Outcome pass — Model B

- Runs strictly after the evaluation pass, per cell, over the setups the system **actually
  observed** (existed at `endIndex`).
- `measureOutcome` consumes the **full series** — post-`endIndex` candles are legal here and
  only here (Model B: the window bounds observation generation, never outcome measurement).
- Spec 17 owns eligibility: a setup without `confirmBar` is declined (`insufficient_data`),
  producing **no row and no ref**. Developing→cancelled/expired setups end outcome-free by
  rule, not by exception.
- On success, `outcomeRef = SetupOutcome.setupId` is stamped on every record of that setup —
  ranked and developing alike.

### Aggregation

| Metric | Population | Definition |
| ------ | ---------- | ---------- |
| `observationCount` | `opportunities` | count of ranked observations. |
| `developingObservationCount` | `developing` | count of developing observations. |
| `uniqueSetupCount` | union of both | distinct `setupId`s observed. |
| `selectedObservationCount` | `opportunities` | `selected === true` count (0 when grammar absent). |
| `resolvedOutcomeCount` | unique setups | rows whose terminal bucket ∈ {target, stop, expired, cancelled}. |
| `outcomeCounts` | unique setups | terminal `SetupStatus` → bucket: `target_reached→target`, `invalidated→stop`, `expired→expired`, `cancelled→cancelled`; everything else (incl. `unresolved:true` or no row) → `unresolved`. |
| `targetOutcomeRate`/`stopRate`/`expiredRate` | resolved | bucket ÷ `resolvedOutcomeCount`; **absent when 0** (never NaN). |
| `expectancyR`/`totalR` | resolved | mean / sum of `rMultiple` over rows where defined; absent when empty. |
| `medianR` | resolved | median of defined `rMultiple`s; absent when empty. |
| `bySetupType`/`byDirection` | same rules | partitioned by existing dims only — present only when non-empty. |

### Versions & metadata

- `versions.methodVersion` ← `config.backtest.methodVersion` (**required** — absent ⇒
  `invalid_config`, fail loud).
- `versions.configVersion` ← `config.version`; `versions.paramsVersion` stamps the selection
  grammar only (scanner-owned params live in the scanner's own versioning).
- `runId` is caller-supplied and optional — echoed, never generated.
- `meta.barsConsumed` echoes the declared window; `meta.diagnostics` carries cell-skip keys,
  empty/skip counters, score-failure counts, and `evaluationsAllEmpty`.

## Failure modes

| Condition | Result |
| --------- | ------ |
| `config.backtest.methodVersion` absent | `ok:false`, `invalid_config` — loud, never defaulted. |
| Cell series empty / fails spec-01 | cell skipped; run continues (`cellsSkipped`). |
| Vacuous window (`t0 > t1`) | cell skipped; `ok:true` with empty records. |
| Scanner error at one bar | that bar skipped (`evaluationsSkipped`); run continues. |
| `scoreOpportunity` fails at one bar | candidate kept scoreless (`scoreFailures`) — spec-25 eligibility decides. |
| `measureOutcome` declines | no `SetupOutcome`, no `outcomeRef` — never fabricated. |
| All evaluations empty | `ok:true`, empty records, zeroed aggregates, `evaluationsAllEmpty`. |

## Exclusions

No execution, fills, slippage, costs, sizing, equity, or P&L. No trade simulation, no ML,
no live data, no broker, no alerts, no Auto Sniper, no paper trading. `plan` and
`statisticalEvidence` fields are recorded verbatim — never synthesized or re-computed here.

## Required tests (22 matrix)

- **Determinism** — identical inputs → byte-identical results; permuted `cells[]` → identical
  (canonical ordering).
- **Causality** — truncated series: evaluation-time fields of records inside the shared window
  are identical to the full-series run; `evaluatedAt === candle.time[evaluatedIndex]` always.
- **Model B** — window-bound runs still produce identical outcome rows to full-window runs;
  `outcomeRef` reaches early-window observations.
- **Eligibility** — never-confirmed setups: no `SetupOutcome`, no `outcomeRef`, no exceptions.
- **Aggregation** — bucket sums, rate denominators (never NaN), expectancy/median/total over
  defined `rMultiple`s only.
- **Ordering** — records sorted `(symbol, timeframe, evaluatedIndex, rank | setupId)`.
- **Insufficiency** — empty cells, vacuous window, malformed series, missing methodVersion.
- **Scanner integration** — contiguous `1..k` ranks per bar, status-at-t on records,
  `includeDeveloping` bucket semantics, no cross-T dedup, `selected` grammar.
