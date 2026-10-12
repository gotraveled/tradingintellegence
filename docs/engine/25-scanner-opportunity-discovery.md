# 25 — Scanner: Opportunity Discovery & Ranking

> Status: **Approved** — Phase 8 implementation target. Depends on 11–17, 19–24.

The scanner answers: **"given a declared universe of symbols and timeframes, which currently
valid trading opportunities surface, in what deterministic order?"** It is a discovery/ranking
engine — not the system-wide pipeline orchestrator. It receives no `CandleSeries`, performs no
detection, no scoring, no probability estimation, and no outcome measurement. It consumes
caller-produced point-in-time `ScanCandidate` artifacts and returns a totally-ordered
`ScanResult`.

```text
Market Data → Replay/Pipeline Runner → Detection (11–14) → Scoring (15) → Stats (24)
                                        │  produces PIT-anchored ScanCandidates per cell
                                        ↓
        Scanner (25): validate → canonicalize → dedup → eligibility → filters → rank → topK
                                        ↓
                          ScanResult { ranked[], developing[], diagnostics }
```

## Terminology

| Term | Definition |
| ---- | ---------- |
| universe | Declared `symbols × timeframes` — the caller owns universe population; the scanner never discovers it. |
| scan | One `scan()` evaluation of the universe at `asOf`. |
| candidate | A caller-produced PIT record: `setup` + `score` + optional plan fields + cell + declared provenance + optional statistical evidence. |
| provenance | The declared causal anchor `evaluatedAt` (UnixMs, required) — what the caller claims about *when* the candidate was evaluated. |
| eligible opportunity | A candidate whose `setup.status ∈ {confirmed, active, partial_target}` (spec 16: scores/plans exist only there) **and** whose `scoreResult` carries a `score`. |
| ranked | The ordered list of eligible opportunities; `rank` = 1-based position. |
| developing | Informational, unranked setup references — never scored, never given probabilities. |
| snapshot | A `ScanResult` bound to `{asOf, universe, config, versions}` — comparable only within its versions. |

## Point-in-time validation (causality preservation, not construction)

Causality ownership is split:

- **Construction** — upstream: `at_bar` evaluation (specs 15/18), `resolvedAt < τ` gating (24).
- **Preservation** — scanner: validates declared provenance against `asOf`. No candles, no
  re-derivation, no attempt to verify provenance is *true* — only that it is declared and
  consistent. A lying caller is unverifiable by design.
- **Reconstruction** — never the scanner's job.

Rules (per-candidate, exclusion-not-failure, all counted in diagnostics):

| Condition | Action |
| --------- | ------ |
| `provenance.evaluatedAt > asOf` | Exclude candidate → `excluded.futureCandidate` |
| `provenance` missing / `evaluatedAt` absent | Exclude candidate → `excluded.missingProvenance` |
| `statisticalEvidence.decisionTime > asOf` | **Strip the evidence only** — candidate stays on its setup/score → `excluded.futureEvidence` |

## Canonical processing order

```text
1. Validate      config + input shape + provenance rules → exclusions + counters
2. Canonicalize  sort by (setupId asc, evaluatedAt desc, score desc, serial asc)
3. Deduplicate   first-per-setupId in canonical order
4. Eligibility   terminal → excluded; developing → developing bucket; gated → excluded;
                 no score → excluded.unrankable; rest → rankable
5. Filters       request dims narrow membership — never reorder
6. Rank          total order + rank assignment
7. topK          slice (0 = unbounded, still fully ranked)
```

### Canonicalization

Sort key over validated candidates, all deterministic and locale-free (code-unit string
comparison only): `setupId` ascending → `evaluatedAt` descending → `score` descending
(absent = below all scores) → stable serialized candidate representation ascending
(JSON.stringify with recursively sorted object keys). Input array order is irrelevant by
construction — canonicalization precedes any stateful operation.

### Deduplication

`setupId` is the detection-instance identity (family-namespaced upstream). After
canonicalization, the first record per `setupId` wins — i.e. **freshest `evaluatedAt`, then
higher `score`, then serialization**. Losers are counted in `duplicatesDropped` with the
affected ids listed. Different `setupId`s on the same cell (e.g. `BTC/USD 15m` reversal +
continuation) are distinct opportunities — no per-cell cap; `topK` bounds the whole result.

## Eligibility

Existing semantics only — `SetupStatus` (11) and `ScoreGate` (15) are authoritative:

- `target_reached | invalidated | expired | cancelled` → `excluded.terminal` (spec 11 immutability)
- `developing` → the `developing[]` bucket iff `config.includeDeveloping`, else `excluded.unrankable`
- `score.gate` present on an otherwise rankable status → `excluded.gated`
- Rankable status without a `score` and without a `gate` → `excluded.unrankable`
- `confirmed | active | partial_target` **with** `score` → rankable

## Request filters

Reuses the existing `ScanRequest` vocabulary — `symbols`, `timeframes`, `setupTypes`,
`directions`, `statuses`, `minScore` (absent dim = unconstrained; `statuses` filters
`setup.status`). Filters narrow membership only, applied after eligibility, before ranking.
A filtered-out candidate is counted as `filtered`, never reordered.

## Ranking

Primary key is **Opportunity Score only** — `score DESC`. Spec 15 is the sole quality
ordering; spec 24 forbids merging score and probability ("side by side, never merged"), and a
scanner-ranking score would be a second scoring system. Total order:

```text
score DESC → symbol ASC → timeframe ASC (canonical Timeframe declaration order) → setupId ASC
```

`setupId` uniqueness makes the order strict-total: input permutation cannot change it.

## Statistical evidence

Caller-produced only — the scanner never invokes spec 24's estimator (spec 20: compose, don't
embed; per-candidate decision construction would make the scanner a hidden stats orchestrator).
Evidence arrives attached to the candidate and passes through verbatim; the estimate's own
`methodVersion`/`paramsVersion` ride along untouched. `unavailable: "insufficient_data"` →
evidence flagged absent, item remains ranked on its score. Future-dated evidence is stripped
(§point-in-time validation). Evidence is informational — it never reorders the ranked list.

## Versioning

- `methodVersion` — scanner methodology: provenance rules, eligibility set, dedup winner rule,
  tie-break tuple, ranked/developing semantics.
- `paramsVersion` — scanner-owned versioned params only, grammar **`tk<k|*>|dev<0|1>`**
  (`tk25|dev1`, `tk*|dev0`). No composite with spec-24 params — the scanner produces no
  estimates, so it must not imply it pins upstream domains. Upstream versions stay attached to
  their artifacts verbatim.

## Developing semantics

`developing[]` = minimal `SetupRef`: `setupId`, `symbol`, `timeframe`, `setupType`,
`direction`, unmet-condition `reasons` (`met === false` — "what's missing", spec 11),
`evaluatedAt`. Emitted only when `config.includeDeveloping`; ordered
`symbol asc → timeframe asc → setupId asc`. No rank, no score, no probability — ever.

## Insufficient data / diagnostics

Empty universe and zero candidates are **valid successful results** (`ok: true`, empty lists) —
"no opportunities" is a finding, not a failure. `meta.diagnostics` reports: `cellsEvaluated`
(universe size), `candidatesIn`, `excluded.{missingProvenance, futureCandidate, futureEvidence,
terminal, gated, unrankable}`, `filtered`, `duplicatesDropped`, `duplicateSetupIds` (CSV).
Engine-level failure is reserved for `invalid_config`/`invalid_input`.

## Configuration

`ScannerConfig { topK: number ≥ 0 (0 = unbounded, default 0); includeDeveloping: boolean
(default false) }` — nothing else is config; universe/filters are request-scope.

## Engine contract

`ScannerEngine.scan(input): EngineResult<ScanResult>` — `input = {asOf, universe, candidates,
filters?, config}`; no candle access; pure and `O(n log n)`.

`ScannedOpportunity` (ranked item): `rank, setupId, symbol, timeframe, setupType, direction,
status, score, scoreContributions?, entry?, stopLoss?, targets?, riskReward?,
statisticalEvidence?` — projections of produced artifacts, never re-derived.

## Determinism

Identical `{asOf, universe, candidates, filters, config}` → bit-identical `ScanResult` under
any candidate-array permutation. No clocks, randomness, I/O, or locale-dependent comparison.

## Historical / replay semantics

The scanner is temporally inert: given PIT-correct inputs it adds no look-ahead surface —
history lives only inside caller-attached evidence, itself validated by `decisionTime ≤ asOf`.
Prefix-vs-full equivalence reduces to upstream causal guarantees plus §point-in-time validation.
A snapshot is a replay at `asOf` with live-produced candidates — one contract, one code path.

## Explicit non-goals

This spec does **not** implement or design: candle access of any kind, detection, scoring,
probability estimation, outcome measurement, scanner/ranking/expected-value/AI scores, live
market data, provider selection, universe population, alerts, execution, broker APIs, paper
trading, portfolio logic, persistence, ML/AI, calibration, or UI internals.

## Test requirements (extends spec 22)

Basic (single/multiple/empty candidates, empty universe); eligibility (all lifecycle states,
gated, unrankable); filters (every dim); ranking (score desc + each tie-break); dedup (winner
rule, diagnostics, permutation-independence); developing (on/off, never ranked/scored);
provenance (future candidate, missing provenance, future-evidence strip, valid pass-through);
statistics (verbatim pass-through, versions preserved, insufficient_data keeps candidate,
never reorders); topK (0/1/overflow/rank-then-slice); determinism (repeat, permutations,
serial tie); replay equivalence; regression (all prior suites).
