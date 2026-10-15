# Unified Market Workspace — Implementation Plan

Ordered phases; each independently testable and shippable. Phase 1 is the
foundation every link depends on — nothing else touches selection plumbing until
it lands. File paths are from the verified working tree (see
`UNIFIED_MARKET_WORKSPACE_DISCOVERY.md`).

---

## Phase 1 — Addressable Selection on `/chart` *(foundation)*

**User-visible outcome** — `/chart?symbol=X&timeframe=Y` loads that selection;
changing symbol/timeframe updates the URL (`router.replace`); refresh/bookmark
restores the exact view; invalid params normalize to defaults.

**Likely changes**
- `src/components/charts/chart-workspace.tsx` — `useSearchParams()` +
  `useRouter()`; init/derive `symbol`/`timeframe` from params; `router.replace` on
  selection change; wrap param-read in `Suspense` boundary (Next requirement) or
  read via the page component and pass as props.
- `src/app/(platform)/chart/page.tsx` — accept `searchParams` if reading
  server-side (page is already a server component — passing initial params as
  props avoids a Suspense wrapper).

**Reuse** — `FEATURED_INSTRUMENTS`, `getInstrument`, `TIMEFRAMES`,
`DEFAULT_TIMEFRAME`, existing keyed candle/live state (unchanged).

**New contracts** — none. A pure helper `parseChartSelection(params)` →
`{symbol, timeframe}` lives in `chart-workspace` or `lib/constants`.

**State/lifecycle** — URL ↔ `useState` mirror; param wins on mount/change; no
fetch lifecycle changes (keys already abort correctly).

**Tests** — `parseChartSelection`: valid pairs, unknown symbol, invalid
timeframe, missing params → defaults; selection change updates URL; stale-result
keying unaffected (existing chart-analysis tests still pass).

**Acceptance** — deep-link loads the right instrument; URL reflects selection;
no regression in candles/analysis flow; suite + tsc + lint + build green.

**Risks/deps** — `useSearchParams` needs `Suspense` in Next 15+ unless params
arrive as page props (preferred path: server page reads `searchParams`, passes
initial values). No dependency risk.

**Non-goals** — no auto-analyze; no new selectors; no persistence beyond URL.

---

## Phase 2 — Scanner → Chart Links + Catalog-Derived Universe

**User-visible outcome** — every scanner row/card has "View on chart"; live
results land analyzing, demo results land viewing; NIFTY 50 appears in `skipped`
instead of being silently absent.

**Likely changes**
- `src/components/scanner/scanner-table.tsx` — action cell → `Link`.
- `src/components/opportunities/opportunity-card.tsx` — footer action → `Link`.
- `src/components/scanner/scanner-live.tsx` — `SCAN_REQUEST.symbols` ←
  `FEATURED_INSTRUMENTS.map(a => a.symbol)`; add `AbortController` parity.
- `src/lib/constants/navigation.ts` (or a small `chart.ts`) —
  `chartHref(symbol, timeframe?, analyze?)` builder next to
  `scannerViewHref`/`marketSegmentHref`.
- `src/components/charts/chart-workspace.tsx` — consume `analyze=1` one-shot:
  fire `analyze()` once after `candleCount > 0`, strip param via `router.replace`.

**Reuse** — `Opportunity.symbol`/`timeframe` (already on every row); `skipped`
rendering (already built); candles/analysis pipeline (unchanged).

**New contracts** — `chartHref()` param builder (the only genuinely new
helper). `analyze=1` is a param convention, not a type.

**State/lifecycle** — auto-analyze effect consumes the flag once; keying/abort
already prevent stale results; scanner mount-fetch gains abort parity.

**Tests** — `chartHref` builds/round-trips params; live source → `analyze=1`
present, demo → absent; universe derives from catalog (8 symbols, NIFTY 50
included); auto-analyze fires once when candles succeed, never on empty/error,
strips param; abort on unmount.

**Acceptance** — scanner row → chart shows same symbol+timeframe; analysis
runs without a second click on live links; NIFTY 50 in `skipped` notice; demo
rows never auto-analyze.

**Risks/deps** — auto-analyze is *link-click initiated* (documented in design);
must not refire on param strip or refresh.

**Non-goals** — no scanner pagination/filters to URL; no scanner-side chart
embed.

---

## Phase 3 — Capability Surface + Markets/Watchlist Links

**User-visible outcome** — `/chart` shows honest provider/capability status
before interaction; markets instrument rows and watchlist symbols link into the
chart; markets badge reflects real provider state, not a hardcoded
`not_configured`.

**Likely changes**
- `src/app/(platform)/chart/page.tsx` — `getSystemStatus()` → pass market-data
  `ServiceStatus` to `ChartWorkspace`.
- `src/components/charts/chart-workspace.tsx` — compact capability strip above
  toolbar (status + "historical aggregates" + live-quotes honesty).
- `src/components/markets/markets-workspace.tsx` — real `ConnectionBadge`
  status (component is server-rendered via `getSystemStatus()`); catalog
  instrument rows per segment with `/chart?symbol=` links; keep empty-state
  framing when unconfigured.
- `src/components/watchlist/watchlist-workspace.tsx` — symbol cell → `Link` to
  `/chart?symbol=`.
- `src/lib/constants/instruments.ts` — optional `instrumentsBySegment(marketId)`
  helper for markets rows (catalog already carries `marketId`).

**Reuse** — `getSystemStatus()`/`ServiceStatus`/`ConnectionStatus` (already
server-side and honest), `ConnectionBadge`, `marketSegmentHref`,
`FEATURED_INSTRUMENTS` (`marketId` per asset), `chartHref` from Phase 2.

**New contracts** — none (service status flows as a prop).

**State/lifecycle** — none new; status is server-rendered, links are static.

**Tests** — capability strip renders each `ConnectionStatus`; markets badge
matches `getSystemStatus()` (mock); segment rows link correct symbols; watchlist
link builds right href.

**Acceptance** — `/chart` tells a user up front whether provider is configured
and that data is historical; `/markets` badge is truthful in both states; every
catalog surface can reach the chart in ≤2 clicks.

**Risks/deps** — markets page is a server component — `getSystemStatus()` is
already called server-side on `/dashboard`; zero new fetch cost.

**Non-goals** — no live quotes claim; no markets-table quote data (provider
doesn't serve quotes); no watchlist persistence.

---

## Phase 4 — Demo Subordination + Polish

**User-visible outcome** — when a matching live analysis exists, the demo
`AnalysisPanel` visibly defers (collapses behind "Reference snapshot · demo")
so demo levels can't read as corroboration; toolbar groups instruments by
segment for faster recovery from unsupported symbols.

**Likely changes**
- `src/components/charts/chart-workspace.tsx` — wrap `AnalysisPanel` in a
  collapsible/disclosure element when `liveView` exists; label "Reference
  snapshot (demo)".
- `src/components/charts/chart-toolbar.tsx` — `<optgroup>` by market segment in
  the symbol `<Select>` (uses `marketId` → `getMarketSegment`).
- Optional: `LiveAnalysisPanel` gains a compact "evaluated N min ago" line
  using its own `evaluatedAt` (no new data).

**Reuse** — existing live/demo swap logic, `getMarketSegment`, `AnalysisPanel`
(unchanged internally).

**New contracts** — none.

**Tests** — demo panel collapsed iff matching live result; optgroup labels
match segments; unsupported-symbol path unchanged.

**Acceptance** — demo snapshot can't be mistaken for engine output when live
exists; no demo content removed; all disclosures intact.

**Risks/deps** — small; lowest-risk phase, shippable independently or folded
into Phase 3.

**Non-goals** — no demo deletion; no snapshot regeneration.

---

## Phase Order Rationale

1. **Phase 1 first** — every cross-surface link needs an addressable selection;
   it's the smallest change with zero contract impact and unblocks everything.
2. **Phase 2** delivers the core journey (scanner → analyze) once links have a
   target.
3. **Phase 3** widens entry points + truthfulness (capability strip, markets
   badge) on the same plumbing.
4. **Phase 4** is presentation polish, safe to reorder or defer.

## Validation Baseline (applies to every phase)

- `npx vitest run` — full suite green (currently 911).
- `npx tsc --noEmit`, `npx eslint .`, `npx next build` — clean.
- Targeted tests per phase listed above; no test weakening.
- No changes to `src/lib/engine*`, `src/lib/services/analysis-service.ts`,
  `src/lib/services/candles-service.ts` behavior, or Specs 00–35.
