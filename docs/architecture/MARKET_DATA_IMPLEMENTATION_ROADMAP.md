# Market Data Implementation Roadmap

Status: roadmap — **2026-10-16**. Companion to
`MARKET_DATA_COVERAGE_DISCOVERY.md` (evidence),
`MARKET_DATA_PROVIDER_EVALUATION.md` (vendor/licensing facts),
`MARKET_DATA_INTEGRATION_DESIGN.md` (target shape).

Ordering principle: **honesty fixes before new vendors** — the product must
stop presenting entitlement-limited data as available before we add coverage.
Phases are independently shippable; each ends with the suite green.

---

## Phase M1 — Truthful classification + entitlement gates (no new deps)

**Goal:** the UI can never show delayed-EOD as if it were fresh, and
plan-unsupported timeframe classes fail closed instead of returning fragments.

| Change | File |
|---|---|
| Extend union to `"historical" \| "delayed" \| "live"` | `src/lib/types/domain/market.ts` (`CandlesResult.classification`) |
| Capability table + plan env (`POLYGON_PLAN`, default `basic`) + `entitledForPublicDisplay` flag | `src/lib/market-data/providers/capabilities.ts` (new) |
| `ProviderRouter` (single-provider composition root first) | `src/lib/market-data/providers/router.ts` (new) |
| `createConfiguredProvider()` returns router; health keyed by `source.id` | `src/lib/market-data/providers/index.ts`, `providers/health.ts` |
| Set `classification` from capability row | `src/lib/services/candles-service.ts` |
| Render `classification` in provenance line ("Delayed" label; never "live") | `src/components/charts/chart-workspace.tsx`, `chart-capability-strip.tsx` |
| `.env.example` + `POLYGON_PLAN` documented | `.env.example` |

**Tests:** router picks correct capability row per `marketId`/timeframe;
`supports` false for intraday under `basic`; `classification` propagates to
`CandlesResult`; health map keyed per provider; `extended classification`
typecheck through `analysis-service`.

**Acceptance:** `POST /api/candles {symbol:"AAPL", timeframe:"4h"}` under a
`basic` plan → 422 `unsupported_timeframe` (not a 200 fragment);
`{timeframe:"1D"}` → 200 with `classification:"delayed"`.
**Rollback:** revert router; `createConfiguredProvider` falls back to direct
Polygon construction.

## Phase M2 — Coverage truth surfacing (small UX honesty)

**Goal:** catalog promises match serveable data.

| Change | File |
|---|---|
| Per-segment serveable flag derived from capability rows → disable/dim
  intraday TF buttons under `basic`, tooltip "delayed EOD plan" | `chart-toolbar.tsx` (capability prop), `chart-workspace.tsx` |
| "Data availability" line in capability strip: delayed/EOD wording | `chart-capability-strip.tsx` |
| Timeframe-honest default: product may prefer `1D` when intraday isn't
  entitled — via capability, not hardcode | `chart-workspace.tsx` |

**Tests:** toolbar renders disabled TFs per capability; strip text includes
"delayed". **Rollback:** component-level only.

## Phase M3 — India provider adapter (licensing-gated)

**Precondition (blocking):** a written entitlement — NSE-authorized vendor
agreement (TrueData/GDFL/etc.) or confirmed internal-only broker-API scope.
**Without it, `entitledForPublicDisplay: false` stays and the adapter serves
nothing publicly.**

| Change | File |
|---|---|
| `IndiaProvider` (Dhan or authorized vendor — same `HistoricalDataProvider`
  interface): securityId/instrument-key mapping, IST→UTC, `nseRegular`
  calendar, chunking per vendor limits (Dhan ≤90d/intraday call) | `src/lib/market-data/providers/india/` (new dir) |
| Instrument-master cache (daily CSV → `securityId` map) | `providers/india/instrument-map.ts` |
| Capability row: `indian-markets`, `1m…1M` as entitled, `delayed`/`historical`
  per vendor terms | `providers/capabilities.ts` |
| Env: `INDIA_DATA_*` server-only | `.env.example`, `providers/index.ts` |

**Tests:** contract suite reused — feed a `FixtureProvider`-shaped India
adapter; UTC conversion tests (IST bar-open alignment); NSE session gap
classification; `NIFTY 50` resolves only via India row. **Rollback:** remove
capability row — NIFTY 50 returns to `unsupported_symbol` cleanly.

## Phase M4 — Caching + rate protection

In-process TTL cache in the router (closed windows ~24h, open window ≤ TF);
per-provider concurrency bound. Files: `providers/router.ts`,
`providers/cache.ts` (new). **Tests:** cache-hit avoids second vendor call;
open-window TTL; concurrent fan-out bounded. **Rollback:** cache is a no-op
passthrough flag.

## Phase M5 (later, design-reserved) — Streaming

Separate `StreamingProvider` interface, `classification:"live"` finally
populated, `live-quotes` status becomes real. Not started here.

## Cross-cutting rules

- Engine/specs 00–35 untouched; provider work stays behind
  `HistoricalDataProvider`.
- Every phase: `npx vitest run`, `tsc --noEmit`, `eslint`, `next build` green.
- No key values in code/docs/tests; env names only.
- Each phase is revertible independently — capability rows are data.
