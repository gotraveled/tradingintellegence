import {
  Bell,
  Bot,
  CandlestickChart,
  FileUp,
  FlaskConical,
  Globe2,
  LayoutDashboard,
  LineChart,
  Newspaper,
  Radar,
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
  research: "/research",
  strategyLab: "/strategy-lab",
  alerts: "/alerts",
  watchlist: "/watchlist",
  marketIntelligence: "/market-intelligence",
  assistant: "/ai-assistant",
  settings: "/settings",
} as const;

export const marketSegmentHref = (id: string) => `${ROUTES.markets}/${id}`;
export const scannerViewHref = (id: string) => `${ROUTES.scanner}/${id}`;

export const NAV_ITEMS: NavItem[] = [
  {
    title: "Dashboard",
    href: ROUTES.dashboard,
    icon: LayoutDashboard,
    description: "Market regime, top opportunities, and developing setups at a glance.",
    availability: "preview",
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
        title: segment.label,
        href: marketSegmentHref(segment.id),
      })),
    ],
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
    title: "Chart Intelligence",
    href: ROUTES.chart,
    icon: CandlestickChart,
    description: "Chart workspace with structure, zone, liquidity, and imbalance overlays.",
    availability: "preview",
  },
  {
    title: "Chart Analyst",
    href: ROUTES.chartAnalyst,
    icon: ScanEye,
    description: "Upload a chart screenshot — deterministic pixel analysis, optional local vision model.",
    availability: "preview",
  },
  {
    title: "Data Import",
    href: ROUTES.dataImport,
    icon: FileUp,
    description: "Analyze your own OHLC CSV export with the canonical engine — no data subscription needed.",
    availability: "preview",
  },
  {
    title: "Research Desk",
    href: ROUTES.research,
    icon: Newspaper,
    description: "Official filings, central-bank releases, and economic statistics — attributed and linked.",
    availability: "preview",
  },
  {
    title: "Strategy Lab",
    href: ROUTES.strategyLab,
    icon: FlaskConical,
    description: "Define setup rules and validate them with historical backtests.",
    availability: "planned",
  },
  {
    title: "Alerts",
    href: ROUTES.alerts,
    icon: Bell,
    description: "Notifications when setups develop or qualify.",
    availability: "planned",
  },
  {
    title: "Watchlist",
    href: ROUTES.watchlist,
    icon: Star,
    description: "Instruments you are tracking.",
    availability: "preview",
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

export const SETTINGS_NAV_ITEM: NavItem = {
  title: "Settings",
  href: ROUTES.settings,
  icon: Settings,
  description: "Preferences, data providers, and account.",
  availability: "preview",
};

export const ALL_NAV_ITEMS: NavItem[] = [...NAV_ITEMS, SETTINGS_NAV_ITEM];

export function getNavItem(href: string): NavItem {
  const item = ALL_NAV_ITEMS.find((entry) => entry.href === href);
  if (!item) throw new Error(`Unknown navigation route: ${href}`);
  return item;
}
