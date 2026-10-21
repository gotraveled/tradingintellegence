import {
  Bell,
  Bitcoin,
  Bot,
  CandlestickChart,
  FileUp,
  FlaskConical,
  History,
  Globe2,
  LayoutDashboard,
  LineChart,
  Newspaper,
  Radar,
  Scale,
  ScanEye,
  Settings,
  Star,
} from "lucide-react";
import type { NavItem } from "@/lib/types";
import { MARKET_SEGMENTS } from "./markets";
import { SCANNER_VIEWS } from "./scanner";

export const ROUTES = {
  home: "/",
  dashboard: "/dashboard",
  markets: "/markets",
  scanner: "/scanner",
  chart: "/chart",
  chartAnalyst: "/chart-analyst",
  dataImport: "/import",
  validation: "/validation",
  comparison: "/comparison",
  research: "/research",
  strategyLab: "/strategy-lab",
  alerts: "/alerts",
  watchlist: "/watchlist",
  marketIntelligence: "/market-intelligence",
  assistant: "/ai-assistant",
  settings: "/settings",
} as const;

export const marketSegmentHref = (id: string) => `${ROUTES.markets}/${id}`;
export const cryptoMarketsHref = marketSegmentHref("crypto");
export const scannerViewHref = (id: string) => `${ROUTES.scanner}/${id}`;

export const NAV_ITEMS: NavItem[] = [
  // Live markets — the primary surface.
  {
    title: "Crypto Markets",
    href: cryptoMarketsHref,
    icon: Bitcoin,
    description: "Live Binance and Kraken quotes, candles, and signals — venue-specific public data, no credentials.",
    availability: "available",
  },
  // Upload-driven analysis — separate from the live chart surface.
  {
    title: "Chart Analyst",
    href: ROUTES.chartAnalyst,
    icon: ScanEye,
    description: "Upload a chart screenshot — deterministic pixel analysis, optional local vision model.",
    availability: "available",
  },
  {
    title: "Research Desk",
    href: ROUTES.research,
    icon: Newspaper,
    description: "Official filings, central-bank releases, and economic statistics — attributed and linked.",
    availability: "available",
  },
  {
    title: "Markets",
    href: ROUTES.markets,
    icon: LineChart,
    description: "Instrument universe across global asset classes.",
    availability: "preview",
    children: [
      { title: "Global Markets", href: ROUTES.markets },
      ...MARKET_SEGMENTS.map((segment) => ({
        title:
          segment.id === "crypto" || segment.id === "indian-markets"
            ? `${segment.label} (live)`
            : segment.label,
        href: marketSegmentHref(segment.id),
      })),
    ],
  },
];

export const SETTINGS_NAV_ITEM: NavItem = {
  title: "Settings",
  href: ROUTES.settings,
  icon: Settings,
  description: "Preferences, data providers, and account.",
  availability: "preview",
};

/**
 * Routes that exist and keep working on direct visits but are deliberately
 * hidden from the sidebar — the user-facing nav is kept small on purpose.
 */
const HIDDEN_NAV_ITEMS: NavItem[] = [
  {
    title: "Data Import",
    href: ROUTES.dataImport,
    icon: FileUp,
    description: "Analyze your own OHLC CSV export with the canonical engine.",
    availability: "available",
  },
  {
    title: "Historical Validation",
    href: ROUTES.validation,
    icon: History,
    description: "Measure how engine scenarios played out on uploaded candles.",
    availability: "available",
  },
  {
    title: "Comparison Lab",
    href: ROUTES.comparison,
    icon: Scale,
    description: "Compare frozen engine configurations side-by-side.",
    availability: "available",
  },
  {
    title: "Chart Intelligence",
    href: ROUTES.chart,
    icon: CandlestickChart,
    description: "Chart workspace with structure, zone, liquidity, and imbalance overlays.",
    availability: "preview",
  },
  {
    title: "Scanner",
    href: ROUTES.scanner,
    icon: Radar,
    description: "Scan the universe for setups that meet evidence criteria.",
    availability: "preview",
    children: [
      { title: "All Opportunities", href: ROUTES.scanner },
      ...SCANNER_VIEWS.map((view) => ({ title: view.label, href: scannerViewHref(view.id) })),
    ],
  },
  {
    title: "Strategy Lab",
    href: ROUTES.strategyLab,
    icon: FlaskConical,
    description: "Define setup rules and validate them with historical backtests.",
    availability: "preview",
  },
  {
    title: "Dashboard",
    href: ROUTES.dashboard,
    icon: LayoutDashboard,
    description: "Sample regime, opportunity, and setup panels — synthetic data for layout evaluation.",
    availability: "sample",
  },
  {
    title: "Watchlist",
    href: ROUTES.watchlist,
    icon: Star,
    description: "Watchlist layout on sample instruments — synthetic data, not live tracking.",
    availability: "sample",
  },
  {
    title: "Alerts",
    href: ROUTES.alerts,
    icon: Bell,
    description: "Sample alert configurations and events — synthetic data, no live notifications yet.",
    availability: "sample",
  },
  {
    title: "Market Intelligence",
    href: ROUTES.marketIntelligence,
    icon: Globe2,
    description: "Global context, sessions, and AI-generated market briefings.",
    availability: "planned",
  },
  {
    title: "AI Assistant",
    href: ROUTES.assistant,
    icon: Bot,
    description:
      "Market Intelligence Assistant — ask why setups qualify, how they were scored, and what the structure shows.",
    availability: "planned",
  },
];

export const ALL_NAV_ITEMS: NavItem[] = [
  ...NAV_ITEMS,
  ...HIDDEN_NAV_ITEMS,
  SETTINGS_NAV_ITEM,
];

export function getNavItem(href: string): NavItem {
  const item = ALL_NAV_ITEMS.find((entry) => entry.href === href);
  if (!item) throw new Error(`Unknown navigation route: ${href}`);
  return item;
}
