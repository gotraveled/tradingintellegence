# AI Trading Intelligence

## Project purpose

Evidence-based market intelligence platform. It identifies market opportunities by combining
independent pieces of market evidence — market structure, liquidity, supply/demand zones,
momentum, multi-timeframe confirmation, and historical validation — explains why a setup
qualifies, and states what would invalidate it. The product is market analysis software: it never
implies guaranteed profits or predictions.

**Phase 1 (current):** application foundation and product shell only. No trading algorithms,
signals, prediction models, broker integrations, or automated trading.

## Technology stack

- Next.js 16 (App Router, Cache Components, Partial Prefetching) + React 19
- TypeScript (strict)
- Tailwind CSS v4 with CSS-variable design tokens
- shadcn-style primitives (`class-variance-authority`, `clsx`, `tailwind-merge`)
- Lucide icons
- ESLint (`eslint-config-next`) + Prettier (with Tailwind class sorting)

## Local setup

```bash
npm install
npm run dev        # http://localhost:3000
npm run build
npm run lint
npm run typecheck
npm run format
```

## Folder structure

```
src/
  app/
    (site)/                  Public pages sharing the marketing header/footer
      page.tsx               Landing page
      about/ features/ pricing/ methodology/ risk-disclosure/
      privacy-policy/ terms/ contact/
    (platform)/              App pages sharing the app shell (sidebar + topbar)
      dashboard/             "Market Intelligence" overview
      markets/ [segment]/    Public Markets overview + segment pages
      scanner/ [view]/       All Opportunities + reversals, breakouts, continuations, developing
      chart/ strategy-lab/ alerts/ watchlist/ market-intelligence/ ai-assistant/ settings/
      loading.tsx error.tsx  Route-group loading skeleton and error boundary
  components/
    ui/                      Design-system primitives (button, card, badge, status, field, table, notice)
    layout/                  App shell, topbar, page header/container
    navigation/              Brand, sidebar, nav list, mobile nav
    marketing/               Landing + public page sections, site header/footer
    dashboard/ scanner/ charts/ opportunities/ markets/ strategy-lab/ alerts/
    watchlist/ assistant/ shared/
  lib/
    constants/               Site copy, navigation/routes, markets, evidence taxonomy
    types/domain/            Central domain model (Asset, Market, Candle, MarketStructure,
                             LiquidityEvent, Zone, Setup, Opportunity, Signal, Alert, AlertEvent,
                             Strategy, BacktestRequest, BacktestResult, WatchlistItem,
                             AnalysisSnapshot)
    types/                   UI-only types (status tones, navigation)
    services/                Contracts for external systems + data access layer
    mock-data/               Development/demo data — must be replaced by the market
                             intelligence API; importable from `services/` alone (ESLint-enforced)
    utils/                   `cn`, number/date formatting, opportunity filters
```

## Current implementation

- **UI shell only.** Every module renders real interface with demo-labelled data or honest
  "not connected" states. Nothing is calculated: no structure, zone, liquidity, or scoring logic
  exists in the UI.
- **Platform routes:** `/dashboard`, `/markets` (+ segments), `/scanner` (+ views), `/chart`,
  `/strategy-lab`, `/alerts`, `/watchlist`, `/market-intelligence`, `/ai-assistant`, `/settings`.
- **Public routes:** `/`, `/about`, `/features`, `/methodology`, `/pricing`, `/risk-disclosure`,
  `/privacy-policy`, `/terms`, `/contact`. `/markets` doubles as the public markets page.
- **Data flow today:** `mock-data` → `services` (return `DataEnvelope<T>` with `source`) → server
  components → workspace client components. Every demo value carries a visible Demo label.
- **Interactive already:** scanner filtering/sorting, chart symbol/timeframe/overlay controls,
  alert rule create/pause/delete (in memory), watchlist add/remove (in memory), backtest form with
  loading + "engine not connected" error handling and a clearly labelled demo preview.

## Future architecture

```
Frontend (this app)
  ↓
API
  ↓
Trading Intelligence Engine      ← replaceable, independently testable
  ↓
Market Data
  ↓
Database
```

- **Engine independence.** The UI depends only on the interfaces in `src/lib/services`
  (`MarketDataProvider`, `AnalysisEngineClient`) and the types in `src/lib/types`. Detection logic
  (demand/supply, BOS/CHOCH, liquidity, FVG, scoring) will live in a separate service — planned as
  Python/FastAPI — and must never enter React components.
- **API-shaped mock data.** `src/lib/mock-data` mirrors the eventual API responses. To go live,
  replace the service function bodies; UI stays unchanged.
- **Backend-shaped domain model.** `src/lib/types/domain` uses ID / ISO-timestamp fields and
  optional engine-produced values so records map onto API/database rows; extensible via
  `metadata` and discriminated unions.
- **Pluggable chart.** `src/components/charts/price-chart.tsx` is the only place a chart library
  is integrated; it consumes `PriceChartProps` (candles + library-agnostic `ChartOverlay[]`).
- **Single source of truth for navigation.** `src/lib/constants/navigation.ts` drives the sidebar,
  in-page sub-navigation, and page headers.

## Next recommended development phase

**Market Intelligence Engine domain specification** — pin down the exact contracts for
demand/supply zones, market structure (BOS/CHOCH), liquidity events, and scoring inputs, then
build the engine as a separate, independently testable service behind `src/lib/services`
interfaces. Followed by: market-data provider integration, backtesting service, alert delivery,
then accounts/persistence.

Not yet implemented (separate phases): real broker APIs, live trading, automated execution, Dhan
or TradingView integrations, real-time market data, ML models, LLM API, detection algorithms,
signal generation, financial advice engine.

## Disclaimer

This software is an analytical tool. It does not provide financial advice, and no analysis,
score, or historical result guarantees future outcomes. Trading involves substantial risk of loss.
