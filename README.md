# AI Trading Intelligence

Evidence-based market intelligence platform. Identifies market opportunities by combining
independent pieces of market evidence, explains why a setup qualifies, and validates it
historically. The platform never implies guaranteed profits or predictions.

**Phase 1 (current):** application foundation and product shell only. No trading algorithms,
signals, prediction models, broker integrations, or automated trading.

## Stack

- Next.js 16 (App Router, Cache Components, Partial Prefetching) + React 19
- TypeScript (strict)
- Tailwind CSS v4 with CSS-variable design tokens
- shadcn-style primitives (`class-variance-authority`, `clsx`, `tailwind-merge`)
- Lucide icons
- ESLint (`eslint-config-next`) + Prettier (with Tailwind class sorting)

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000
npm run build
npm run lint
npm run typecheck
npm run format
```

## Structure

```
src/
  app/
    page.tsx                 Landing page
    (platform)/              Route group sharing the app shell (sidebar + topbar)
      dashboard/             "Market Intelligence" overview
      markets/ [segment]/    Global Markets + crypto, forex, commodities, indices, us-stocks, indian-markets
      scanner/ [view]/       All Opportunities + reversals, breakouts, continuations, developing
      chart/ strategy-lab/ alerts/ watchlist/ market-intelligence/ assistant/ settings/
  components/
    ui/                      Design-system primitives (button, card, badge, status, field, table)
    layout/                  App shell, topbar, page header/container
    navigation/              Brand, sidebar, nav list, mobile nav
    marketing/               Landing page sections
    dashboard/ scanner/ charts/ opportunities/ markets/ shared/
  lib/
    constants/               Site copy, navigation/routes, markets, evidence taxonomy
    types/domain/            Central domain model (Asset, Market, Candle, MarketStructure, LiquidityEvent,
                             Zone, Setup, Opportunity, Signal, Alert, BacktestResult, AnalysisSnapshot)
    types/                   UI-only types (status tones, navigation)
    services/                Contracts for external systems + `intelligence.ts` data access layer
    mock/                    DEMO DATA ONLY — importable from `services/` alone (ESLint-enforced)
    utils/                   `cn`, number formatting
```

## Architecture principles

- **Engine independence.** The UI depends only on the interfaces in `src/lib/services`
  (`MarketDataProvider`, `AnalysisEngineClient`) and the types in `src/lib/types`. Detection
  logic will live in a separate service (planned: Python/FastAPI) and never inside components.
- **Honest states.** Modules show real connection state and empty states until their backing
  service exists. Demo values (regimes, opportunities, chart analysis) live in
  `src/lib/mock/`, are served through `src/lib/services/intelligence.ts` with
  `source: "demo"`, and are always rendered with a visible **Demo** badge. Landing-page examples
  are labelled illustrative. To go live, replace the service function bodies; the UI is unchanged.
- **Backend-shaped domain model.** `src/lib/types/domain` uses ID / ISO-timestamp fields and
  optional engine-produced values (e.g. `Opportunity.entry`, `confidence`) so records can map
  directly onto API/database rows. Extensible via `metadata` and discriminated unions.
- **Pluggable chart.** `src/components/charts/price-chart.tsx` is the only place a candlestick
  library needs to be integrated; it receives `PriceChartProps` (candles + library-agnostic
  `ChartOverlay[]`), so the Chart Intelligence page does not change.
- **Single source of truth for navigation.** `src/lib/constants/navigation.ts` drives the sidebar
  (including Markets/Scanner submenus), in-page sub-navigation, and page headers.

## Design system

- Dark-first. Tokens live in `src/app/globals.css` under `:root` / `[data-theme="dark"]`, with a
  complete `[data-theme="light"]` set ready for a future theme switch (`<html data-theme>`).
- Semantic tones: **bullish** (green), **bearish** (red), **developing** (amber),
  **neutral** (blue, information), **inactive** (gray, unavailable).
- Status is never conveyed by color alone: `StatusBadge`, `ConnectionBadge`, and
  `AvailabilityBadge` (`src/components/ui/status.tsx`) always pair an icon with text.
- Numeric values use the `numeric` utility (mono, tabular figures).

## Roadmap (not in this phase)

Market-data providers, analysis engine (structure, BOS/CHOCH, zones, liquidity, FVG), opportunity
scoring, backtesting, AI explanations, alerts, authentication, PostgreSQL/Redis, paper trading,
and eventually broker integrations.

## Disclaimer

This software is an analytical tool. It does not provide financial advice, and no analysis,
score, or historical result guarantees future outcomes. Trading involves substantial risk of loss.
