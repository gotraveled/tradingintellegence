# Unified Market Workspace — Design

Target architecture for one consistent journey: select instrument → view historical
candles → run engine analysis → inspect plan on chart → arrive from scanner /
watchlist / markets without losing context.

Design principles held throughout: **the URL is the source of truth for selection**;
requests are keyed and abortable; historical data is never presented as live; nothing
is fabricated.

---

## 1. Architecture

```
┌ /scanner ─────────────┐   ┌ /watchlist ─┐   ┌ /markets ─────────┐
│ ScannerLive → results  │   │ items table │   │ instrument rows    │
│   "View on chart" ─────┼───┼─────────────┼───┼───────────────────┼──► /chart?symbol=X&timeframe=Y
└───────────────────────┘   └─────────────┘   └───────────────────┘            │
                                                                             ▼
                                    ┌──────────── ChartWorkspace ────────────┐
                                    │ URL params → selection state            │
                                    │  POST /api/candles   (keyed, aborted)   │
                                    │  Analyze ▶ POST /api/analysis           │
                                    │  live overlays replace demo overlays    │
                                    │  LiveAnalysisPanel + capability banner  │
                                    └─────────────────────────────────────────┘
```

- **`/chart` is the inspection hub.** No new route, no new endpoint, no global
  state library. Other surfaces link into it with a fully-specified selection.
- **Selection = URL params.** `symbol` + `timeframe` are read from the query string
  on mount and written back with `router.replace` (history stays clean; the
  selection is shareable/bookmarkable). Invalid params fall back to catalog
  defaults and are normalized in the URL.
- **`analyze=1` opt-in flag.** A link that says "Analyze on chart" *is* the
  explicit user action — the flag triggers one analysis run after candles load,
  then is stripped from the URL so a refresh doesn't re-run silently. Manual
  "Analyze" remains the default path.

## 2. State Ownership and Request Lifecycle

### `/chart` (ChartWorkspace — already client-side)

| State | Owner | Lifecycle |
|---|---|---|
| `symbol`, `timeframe` | URL query ↔ local `useState` mirror | URL wins on mount/param change; local changes `router.replace` |
| candles fetch | keyed `{key, state}` + `AbortController` (existing) | abort on selection change; `symbol|timeframe|retry` key prevents stale render |
| live analysis | keyed `{key, state}` + `analyzeAbort` (existing) | key `symbol|timeframe|window.end`; abort on selection change or re-analyze |
| overlays | derived | live-matching result → engine overlays; else demo overlays (unchanged rules) |
| auto-analyze | one-shot effect on `analyze=1` + `candleCount>0` | consumes the flag once, strips param |

### `/scanner` (ScannerLive — client)

- Keep the mount-once fetch; derive `SCAN_REQUEST.symbols` from
  `FEATURED_INSTRUMENTS` so NIFTY 50 is included and honestly surfaces via
  `skipped` (already rendered) instead of being silently absent.
- Add `AbortController` for parity with the candles runner (unmount safety).
- Each result row/card gains **"View on chart"** →
  `/chart?symbol={opportunity.symbol}&timeframe={opportunity.timeframe}&analyze=1`
  for live sources only. Demo rows get "View on chart" **without** `analyze=1`
  (demo opportunities aren't engine results; the chart opens the matching
  selection for real inspection instead of implying the demo plan exists live).

### `/markets`, `/watchlist`

- Instrument rows become `Link`s to `/chart?symbol=X` (markets: catalog rows by
  segment; watchlist: symbol cell). Timeframe omitted → workspace default.
- Markets page replaces the hardcoded `not_configured` badge with the real
  `getSystemStatus()` market-data status (server component — already available).
- Watchlist stays session-local (documented limitation, unchanged).

### Capability surface

- `/chart` page (server component) calls `getSystemStatus()` and passes the
  market-data `ServiceStatus` into `ChartWorkspace` → a compact capability line
  above the toolbar: `Historical data · connected` / `degraded` / `unverified` /
  `not configured` + the honest "streaming quotes not implemented" note only when
  relevant. Mirrors what `/api/candles` would return, so no false affordance.

## 3. User Journeys

**A. Selection → chart → analysis**
User opens `/chart` → capability line shows provider state → picks symbol/timeframe
(URL updates, candles refetch, old request aborted) → provenance strip shows
source/bars/retrieved/quality → clicks **Analyze** → loading skeleton →
`LiveAnalysisPanel` (evaluatedAt, bars, quality, version) + engine overlays; or
no-setup / developing-watch / skipped / unavailable / error states.

**B. Scanner → chart**
User filters scanner results → clicks "View on chart" on a row → lands on
`/chart?symbol&timeframe&analyze=1` → candles load → analysis auto-runs (the click
*was* the explicit action) → panel + overlays match the scanned opportunity's
anchor semantics (evaluatedAt shown; not asserted identical to the scan's).

**C. Unsupported instrument/timeframe**
Catalog symbol provider can't serve (e.g. NIFTY 50) → candles `unsupported`
state names the symbol and reason; analysis stays disabled (no candles → no
`asOf` anchor; never fabricated). Recovery: instrument selector groups by market
segment; capability line explains provider scope. Unknown/invalid `symbol` param
normalizes to catalog default with a quiet notice.

**D. Provider down / request failure / empty / zero-opportunity**
`degraded`/`unconfigured` capability line; candles `unconfigured|error|empty`
states with Retry; analysis `unavailable` (503) / `error` (typed) / honest
"no qualifying setup" — all existing states, now reachable via links without
surprise.

**E. Mid-flight selection changes**
URL param or selector change → new request key → both fetches abort → stale
results can never render (key mismatch renders loading/idle — already enforced).

## 4. UX Hierarchy (`/chart`)

1. **Page header** — Chart Intelligence (existing `PageHeader`).
2. **Capability strip** — provider status + "historical aggregates" classification
   + live-quotes honesty note (new, server-derived).
3. **Toolbar** — instrument selector grouped by market segment (search within
   catalog if list grows), timeframe, layers, view controls, **Analyze**.
4. **Chart region** — candles + overlays + provenance strip + legend; engine
   overlays labeled `Engine *` replace demo overlays only on matching live result.
5. **Right rail** — `LiveAnalysisPanel` (evaluatedAt, bars, quality, version,
   clamp disclosure, watch-state, plan) → loading/unavailable/error surfaces →
   demo `AnalysisPanel` (collapses/de-emphasizes when a matching live result
   exists — labeled "Reference snapshot (demo)" and default-collapsed, not
   removed; the `DemoNotice` at page level already covers page-scope disclosure).
6. **Mobile** — existing 3-panel switcher (chart/analysis/plan) unchanged.

## 5. Data-Integrity Rules (binding)

- Historical ≠ delayed ≠ live ≠ simulated — `classification: "historical"` is
  shown verbatim; "Live quotes not implemented" stays until a real feed exists.
- `servedTicker`/`source.label`/`retrievedAt`/quality warnings render unchanged.
- `analyze=1` is user-initiated by click; it never fires on plain navigation,
  never re-fires on refresh, and requires `candleCount > 0`.
- Analysis `asOf` = displayed window's exclusive end; displayed anchor = engine's
  `evaluatedAt` (closed bar). Window clamp ≥180d disclosed.
- Scanner-linked analysis is a *fresh* point-in-time run — the panel shows its
  own `evaluatedAt`; we never claim it equals the scanner's evaluation time.
- Zero-opportunity, developing-only, skipped, and error outcomes never get
  demo fallback (demo requires explicit user opt-in and badging — scanner already
  does this; chart's `AnalysisPanel` stays visibly demo).
- Overlays come only from the matching live result keyed
  `symbol|timeframe|window.end`; demo overlays suppressed on any matching live
  result (including no-plan), never merged.
- No changes to engine, candle semantics, `closedIndexAt`, `skipped`, or quality.

## 6. Explicit Non-Goals

- No new API routes, providers, streaming/live feeds, subscriptions, or broker
  integrations.
- No global state library (URL + component keys suffice; no demonstrated need).
- No changes to Specs 00–35, engine behavior, provider contracts, or
  `analysis-service`/`candles-service` semantics.
- No removal of demo content — only labeling, subordination, and gating.
- No dependency changes; the documented `braces` audit exception stays as-is.
- No auto-analysis on plain symbol selection (explicit action only).
