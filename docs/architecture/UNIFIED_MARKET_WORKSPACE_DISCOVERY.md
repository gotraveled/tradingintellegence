# Unified Market Workspace — Discovery

Current-state audit of the instrument → chart → analysis → scanner journey. Every
claim references an actual file and contract; anything inferred is marked as such.

Scope: platform routes under `src/app/(platform)/`, the services they call, and the
shared contracts in `src/lib`. Verified against the working tree (post chart-analysis
integration).

---

## 1. Route Map

| Route | Page | Workspace component | Data path |
|---|---|---|---|
| `/chart` | `src/app/(platform)/chart/page.tsx` | `src/components/charts/chart-workspace.tsx` (client) | `POST /api/candles` + `POST /api/analysis` |
| `/scanner`, `/scanner/[view]` | `src/app/(platform)/scanner/{page,[view]/page}.tsx` | `src/components/scanner/scanner-workspace.tsx` → `scanner-live.tsx` | `POST /api/analysis` |
| `/markets`, `/markets/[segment]` | `src/app/(platform)/markets/{page,[segment]/page}.tsx` | `src/components/markets/markets-workspace.tsx` | none — static shell |
| `/watchlist` | `src/app/(platform)/watchlist/page.tsx` | `src/components/watchlist/watchlist-workspace.tsx` | `getWatchlist()` demo service |
| `/dashboard` | `src/app/(platform)/dashboard/page.tsx` | `system-status-panel.tsx`, `evidence-framework-panel.tsx` | `getSystemStatus()` (server, in-process) |

`useSearchParams`, `searchParams`, and `/chart?…` links do **not** exist anywhere in
`src/` — no route currently accepts or produces an instrument/timeframe selection.

---

## 2. Instrument Catalog, Search, Selection

- **Catalog** — `src/lib/constants/instruments.ts`: `FEATURED_INSTRUMENTS` (8 static
  `Asset` records: BTCUSDT, ETHUSDT, XAUUSD, EURUSD, GBPUSD, NAS100, AAPL, NIFTY 50)
  + `getInstrument(symbol)`. Reference metadata only (asset class, market, precision).
- **Timeframes** — `src/lib/constants/markets.ts`: `TIMEFRAMES` (1m…1M, 8 values),
  `DEFAULT_TIMEFRAME = "4h"`.
- **Chart selection** — `chart-workspace.tsx` local `useState`: `symbol`
  (default `FEATURED_INSTRUMENTS[0]` = BTCUSDT) and `timeframe` (default `"4h"`).
  UI is a `<Select>` over the catalog in `chart-toolbar.tsx`; no search, no
  free-text symbol.
- **Scanner universe** — `scanner-live.tsx` `SCAN_REQUEST` hardcodes **7** of the 8
  catalog symbols at `"4h"` (NIFTY 50 omitted) — a duplicated, drift-prone copy of
  the catalog.
- **Watchlist selection** — `watchlist-workspace.tsx` add-form over catalog
  symbols; session-local `useState` only (documented in-file).
- **Markets page** — renders an empty `TableShell` with a **hardcoded**
  `ConnectionBadge status="not_configured"` regardless of real provider state.

## 3. Historical Candles Path

- **Route** — `src/app/api/candles/route.ts`: `POST /api/candles` →
  `candles-service` → provider `getCandles` → `CandlesResult`.
- **Client runner** — `src/lib/services/candles-runner.ts` `fetchCandles(request,
  {signal})`, typed HTTP errors, abort support.
- **Contract** — `CandlesResult` (`src/lib/types/domain/market.ts`): requested
  symbol, resolved `asset`, `window:{start,end}` (exclusive end), `candles`,
  `quality` (incl. `status`, `missingBarCount`), `source` (provider provenance),
  `classification: "historical"`, `retrievedAt`, `servedTicker`, `warnings`,
  `candleCount`.
- **Workspace fetch** — `chart-workspace.tsx`: keyed state
  `symbol|timeframe|retryCount`; `AbortController` cancels on selection change;
  `loading | success | empty | unsupported | unconfigured | error` states each
  rendered honestly; provenance strip shows source label, bar count, retrieved
  time, quality-gap note.

## 4. Chart Analysis Path

- **Route** — `src/app/api/analysis/route.ts`: `POST /api/analysis` →
  `analysis-service` → provider `getCandles` → engine anchored by `closedIndexAt`
  (last bar closed at-or-before `asOf`) → `AnalysisResult`. Server-side
  `ANALYSIS_MAX_LOOKBACK_DAYS = 180`.
- **Client runner** — `src/lib/services/analysis-runner.ts`:
  `runAnalysis(request, {signal})`; `chartAnalysisRequest({symbol,timeframe,
  windowStart,windowEnd})` → `asOf = window.end` ISO, `lookbackDays = clamp(1..180)`,
  `windowClamped` flag; `pickCell` / `pickOpportunities` match results by exact
  symbol+timeframe; `toOpportunities` for the scanner projection.
- **Workspace action** — `chart-toolbar.tsx` explicit **Analyze** button (disabled
  until `candleCount > 0`, `analyzing` state); `chart-workspace.tsx` runs the
  request, keys results `symbol|timeframe|window.end`, renders:
  - `LiveAnalysisPanel` (`src/components/charts/live-analysis-panel.tsx`) —
    evaluatedAt (engine anchor, not `asOf`), bar count, quality status,
    methodVersion, window-clamp disclosure, skipped reasons, developing records as
    watch-state (`!r.met` reasons only), `TradePlan` for the top matched record.
  - Loading skeleton / `unavailable` (503/`ServiceUnavailableError`) / `error`+Retry
    panels in the right column.
  - Overlay swap: live plan → `toChartPlanOverlays` (entry/stop/targets as
    `"Engine …"` levels) **replaces** `demoOverlays` for a matching result;
    success-with-no-plan → empty overlay set (demos suppressed, not mixed).

## 5. Scanner Path

- `ScannerWorkspace` (server) renders `ScannerLive` (client) + `OpportunityAnatomy`.
- `ScannerLive` fetches `SCAN_REQUEST` on mount (module-level `fetchScan`,
  cancelled flag on unmount; no abort signal — mount-once so not exposed to
  staleness), maps through `toOpportunities`, renders `skipped` notices, error →
  Retry + explicit "Preview demo data" action (badged; never default).
- `ScannerResults` → `ScannerFilterBar` (view-locked filters) + `ScannerTable`
  (desktop, expandable detail rows with `ReasonList` + `TradePlan`) +
  `OpportunityCard` (mobile). **No outbound links** — rows expand in place; there
  is no route to a matching chart.
- `Opportunity` type (`src/lib/types/domain/opportunity.ts`): `symbol`,
  `timeframe`, `setupType`, `direction`, `status`, `score`, `entry`, `stopLoss`,
  `targets`, `riskReward`, `reasons`, `pricePrecision`, `assetClass`, `market` —
  every field needed to deep-link into the chart workspace exists.

## 6. Service Status / Capability Surface

- `src/lib/services/system-status.ts` `getSystemStatus()` — server-side, reads
  `isProviderConfigured()` + `getLastProviderConnectivity()`. Statuses:
  `not_configured | unverified | connected | degraded`. Services: market-data,
  live-quotes (always `not_configured` — honest), analysis-engine, backtesting,
  alerts.
- Rendered only on `/dashboard` (`SystemStatusPanel`). **The chart and scanner
  pages — the surfaces where capability matters most — do not display it.** The
  markets page shows a hardcoded `not_configured` badge disconnected from this
  source of truth.
- Per-request data sufficiency is deliberately out of scope for system status
  (documented in-file); `skipped` + `quality` carry that instead.

## 7. Demo / Preview Surface

- `intelligence.ts`: `getAnalysisSnapshots`, `getOpportunities`, `getMarketRegimes`
  — return `DataEnvelope<T>` with `source`; current data is `source === "demo"`.
- `/chart` page wraps workspace in `DemoNotice`; `AnalysisPanel` (demo snapshot)
  renders alongside `LiveAnalysisPanel`; demo overlays carry layer disclosure and
  are **replaced** by engine overlays when a live result exists.
- Scanner demo path is opt-in only (explicit button on error).

## 8. Gaps and Conflicts

1. **No addressable selection** — `/chart` owns `symbol`/`timeframe` in local
   `useState`; nothing can deep-link a selection. This blocks journeys
   scanner→chart, watchlist→chart, markets→chart, and shareable views.
2. **Scanner→chart disconnected** — `ScannerTable`/`OpportunityCard` have no
   "inspect on chart" action despite `Opportunity` carrying `symbol`+`timeframe`.
3. **Duplicated universe** — `SCAN_REQUEST` in `scanner-live.tsx` hardcodes 7
   symbols instead of deriving from `FEATURED_INSTRUMENTS`; NIFTY 50's honest
   `skipped` result never surfaces in the scanner.
4. **Hardcoded capability badge** — `markets-workspace.tsx` shows
   `not_configured` unconditionally; contradicts `getSystemStatus()` when a
   provider is configured.
5. **Capability surface absent where needed** — `getSystemStatus()` exists but
   `/chart` and `/scanner` don't consume it; users can't tell live-capable from
   not-configured before clicking.
6. **Demo-vs-live coexistence on `/chart`** — `AnalysisPanel` (demo snapshot)
   remains visible beside live results by design; correct but worth tightening:
   when a matching live result exists the demo panel should be visually
   subordinated/collapsed so it can't be read as corroboration.
7. **No selection recovery on `/chart`** — an unsupported symbol (e.g. NIFTY 50)
   shows the candles `unsupported` state, which is honest; the missing piece is a
   fast path back to a supported instrument (list/segment grouping in selector).
8. **`scanner-live.tsx` retry is not abortable** — no `AbortController`; a
   navigation away during retry can still `setState` after unmount (React
   handles this benignly, but the pattern diverges from the candles runner).
9. **Timeframe mismatch on scanner links** — scanner fixes 4h; chart default is
   also 4h, consistent today, but only by coincidence — the link must carry the
   timeframe explicitly.

## 9. Existing Contracts Reusable As-Is

- `CandlesResult`, `CandlesRequest`, `fetchCandles` (abortable) — window + quality
  + provenance.
- `AnalysisRequest`, `AnalysisResult`, `runAnalysis`, `chartAnalysisRequest`,
  `pickCell`, `pickOpportunities`, `toOpportunities`.
- `ChartOverlay`, `toChartOverlays` (demo), `toChartPlanOverlays` (live),
  `PriceChart`/`CandlestickChart` overlay pipeline.
- `LiveAnalysisPanel` + `LiveAnalysisView` — all analysis presentation states.
- `TradePlan`, `ReasonList`, `SetupStatusBadge`, `BiasBadge`, `EmptyState`,
  `Notice`, `Skeleton`, `ConnectionBadge`.
- `getSystemStatus()`, `ServiceStatus`, `ConnectionStatus`.
- `FEATURED_INSTRUMENTS`, `getInstrument`, `TIMEFRAMES`, `DEFAULT_TIMEFRAME`,
  `marketSegmentHref`, `scannerViewHref`.
