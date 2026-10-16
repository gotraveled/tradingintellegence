# Market Data Integration Design

Status: design — **2026-10-16**. Discovery-only milestone; no code is written here.
Grounded in `MARKET_DATA_COVERAGE_DISCOVERY.md` (what exists + smoke-test
evidence) and `MARKET_DATA_PROVIDER_EVALUATION.md` (vendor facts + licensing).

Goal: the **smallest** architecture that fixes the real gaps — entitlement-aware
capability, honest classification, a second provider for India — without
rebuilding what already works. Engine logic, specs 00–35, and API contracts to
clients stay untouched unless a demonstrated deficiency forces otherwise.

---

## 1. What already works (reuse, don't redesign)

| Existing contract | Location | Reuse verdict |
|---|---|---|
| `HistoricalDataProvider` (`supports`, `getCandles` → `ProviderResponse`) | `src/lib/market-data/provider.ts` | **The routing seam.** New vendors implement it verbatim. |
| `ProviderResponse` / `MarketDataErrorCode` (8 codes) | `types/domain/market.ts` | Reuse; one code addition proposed (§3.3). |
| `normalizeCandles` → `buildQualityReport` → `SessionCalendar` | `market-data/normalize|quality|sessions.ts` | Reuse for every provider; add an NSE session calendar (the `sessionWindowUtc` factory already exists). |
| `CandlesRequest/CandlesResult` + HTTP mapping | `services/candles-service.ts`, `api/candles/route.ts` | Reuse; extend `classification` (§3.2). |
| `observeProviderHealth` passive connectivity | `providers/health.ts` | Reuse per-provider; needs a **per-provider** registry (§3.4). |
| `resolveAsset` catalog-first identity | `services/candles-service.ts` | Reuse; add per-provider ticker maps (§3.1). |
| `FixtureProvider` + determinism/replay tests | `provider.ts`, `market-data/__tests__/` | Reuse as the contract test harness for any new provider. |
| PIT/closed-bar anchoring (`closedIndexAt`, `outcomeRef` drop) | `services/analysis-service.ts` | Reuse — provider-agnostic already. |
| Demo/reference subordination + `dataSource` provenance | chart workspace, `LiveAnalysisPanel` | Reuse; new labels flow through `MarketDataSource`. |

## 2. Target shape

```
CandlesRequest / AnalysisRequest
        │
        ▼
services/candles-service | analysis-service   (unchanged composition)
        │  provider = ProviderRouter
        ▼
ProviderRouter (NEW, ~80 LOC, src/lib/market-data/providers/router.ts)
        │  picks provider by (asset.marketId/assetClass, timeframe) via a
        │  static CapabilityTable — declared, not probed
        ├──► PolygonProvider   (exists)
        ├──► DhanProvider|TrueDataProvider|… (future, same interface)
        └──► undefined → unsupported_symbol (unchanged honesty)
        │
        ▼
normalize → validate → quality → ProviderResponse  (unchanged)
```

One router, one capability table, N vendor adapters behind the existing
interface. No new global state beyond what `providers/index.ts` already holds.

## 3. Design decisions

### 3.1 Capability model — *declared, not probed*

`supports()` today only encodes symbol mapping. Add a static table — per
provider: which asset classes/markets, which timeframes, which classification:

```ts
interface ProviderCapability {
  providerId: string;
  markets: MarketSegmentId[];          // e.g. polygon: us-stocks,indices,forex,commodities,crypto
  timeframes: Timeframe[];             // entitlement-aware: basic tier → ["1D","1W","1M"]
  classification: DataClassification;  // "delayed_eod" for current key
}
```

`Router.supports(req)` = capability check → vendor `supports()`. **Entitlement
is configuration**: `POLYGON_PLAN` env (`basic|starter|…`) selects the
capability row — never inferred from traffic. A 200-with-fragments stays a
valid empty window; the router prevents the request class entirely and the
route can answer `unsupported_timeframe` (422) with an honest message.

### 3.2 Classification — demonstrated contract deficiency

`CandlesResult.classification` is literally typed `"historical"`. Smoke test:
every Polygon response is `status: "DELAYED"` ending Oct 14 — that is *delayed*
data, not merely "historical". Minimal extension (additive, backwards
compatible):

```ts
classification: "historical" | "delayed" | "live";
```

- `"historical"` — provider semantics unknown/purely archival (fixtures, files).
- `"delayed"` — provider-reported delayed/EOD entitlement.
- `"live"` — reserved; nothing emits it today (streaming stays `not_configured`).

Wire it from the capability row → `CandlesResult`/`AnalysisResult.dataSource`.
UI renders the string verbatim — "Delayed" badge next to provenance, never
"live". This is a presentation-honesty fix, not engine semantics.

### 3.3 Error code — one addition, optional

`unsupported_timeframe` already covers "this plan can't serve intraday". If a
clearer HTTP mapping is wanted later, `"entitlement_limited"` could map 403→
"upgrade required" — **defer until a second provider exists**; `422` today is
honest.

### 3.4 Health — per-provider, same mechanism

`health.ts` holds a single `lastConnectivity`. With N providers, key it by
`source.id` (`Map<string, ProviderConnectivity>`). `getSystemStatus()` reports
one row per configured provider (or a `market-data-india` sibling row) — still
passive, still no probes.

### 3.5 Symbol mapping — per-provider tables, catalog-first

Keep `resolveAsset` unchanged. Each provider owns a mapping module:

- `polygonTickerFor` (exists): `X:`/`C:`/`I:` aliases.
- Future `dhanSecurityIdFor`: `AssetIdentifier` → `{securityId, exchangeSegment,
  instrument}` via Dhan's instrument master (cached daily — it's a CSV).
- Future `trueDataSymbolFor`: catalog → vendor symbol.

`NIFTY 50` mapping lands **only** in the India provider's table — never a
guessable default. `servedTicker` already plumbs the actual ticker to the
client.

### 3.6 Sessions/calendars

Add `nseRegular = sessionWindowUtc("nse-regular", 225, 600)` (09:15–15:30 IST =
03:45–10:00 UTC) in `sessions.ts` usage by the India provider's
`calendarFor`. Holiday calendars remain a known limitation — document, don't
fake.

### 3.7 Caching & rate-limit protection

- **Request-level TTL cache** in the router (not per-vendor):
  `key = provider|ticker|tf|start|end` — historical windows are immutable once
  closed; cache completed daily/weekly windows ~24h, the **open** window
  (contains today's forming bar) TTL ≤ timeframe. Protects the 5 calls/min
  Basic limit and Dhan's per-day caps.
- **Bounded concurrency + backoff**: reuse polygon's single-retry shape;
  router adds a per-provider semaphore when a second provider exists.
- No persistent store yet — in-process `Map` is sufficient for the roadmap's
  first phase; note it doesn't survive cold starts (acceptable: provider is the
  authority, cache is opportunistic).

### 3.8 Streaming — explicitly out of scope now

`live-quotes` stays `not_configured`. Design only reserves: provider adapters
may later expose `streamCandles()` behind a separate interface —
`classification:"live"` is the only contract touchpoint. Nothing implies
streaming exists.

### 3.9 Secrets & error safety

Keys stay server-side (`providers/index.ts` env seam, `.env.local`). India
vendor creds follow the same pattern (`INDIA_DATA_KEY`/`…_BASE_URL` envs).
Provider error `message` is vendor-shaped but safe; `detail` never reaches the
client today — keep it that way.

### 3.10 Redistribution gating — implemented (Phase M2)

The capability row carries `displayRights: authorized | not_authorized |
unknown` (a 3-state rather than the original boolean — "we haven't verified"
is itself an honest state). The **serving scope** contract in
`providers/serving.ts` creates the production boundary the repo lacked:

- `MARKET_DATA_SERVING` (`public`/`internal`, documented in `.env.example`) →
  `NODE_ENV=production` defaults `public` → otherwise `internal`.
- `ProviderRouter.getCandles` calls `displayBlock` before any vendor traffic:
  public scope + non-`authorized` row → `display_not_authorized` (HTTP **451**).
  Internal scope never blocks on rights; all other capability gates still
  apply — a broker's personal-use API stays usable where its terms permit.
- Because enforcement sits at the router, **every** consumer path — candles,
  analysis, backtest, scanner — inherits it; there is no alternate route that
  bypasses the capability row.

**Evidence required to set `authorized`:** a written vendor/exchange
agreement explicitly covering commercial display or redistribution on the
deployed surface, referenced in the row's `note`. A paid subscription, a
working API key, or successful responses are technical access only — none is
display authorization. With no such agreement, Polygon's row stays `unknown`
and a production deployment serves licensing-blocked states rather than
provider data.

## 4. Non-goals

- No changes to engine semantics, spec files, `runBacktest`, anchors, outcomes.
- No new client-visible endpoints; `/api/candles`, `/api/analysis`,
  `/api/backtest` signatures unchanged.
- No streaming, no websockets, no fundamentals surface.
- No persistence/database; no speculative multi-vendor failover beyond routing.
- No demo-data expansion — real coverage only.

## 5. Risks

- **Licensing is the critical path** for public India data; a broker API can't
  be shipped publicly. Mitigation: capability `entitledForPublicDisplay` gate.
- **Polygon plan ambiguity**: smoke test shows Basic-like behavior; confirm the
  actual plan in the vendor dashboard before claiming Starter coverage.
- **Sparse-intraday ≠ entitlement failure**: if Basic is upgraded and intraday
  still fragments, re-audit — don't assume pricing explains everything.
- **Clock/session drift** for NSE quality metrics until real calendars land.
