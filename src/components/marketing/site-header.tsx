import Link from "next/link";
import { Brand } from "@/components/navigation/brand";
import { buttonVariants } from "@/components/ui/button";
import { PUBLIC_ROUTES, ROUTES } from "@/lib/constants";
import { SiteMobileNav } from "./site-mobile-nav";
import { SiteNav, type NavEntry } from "./site-nav";

export const NAV_ENTRIES: readonly NavEntry[] = [
  {
    type: "group",
    label: "Platform",
    items: [
      { href: ROUTES.dataImport, label: "Data Import", note: "Validate & analyze your own OHLC CSVs" },
      { href: ROUTES.chartAnalyst, label: "Chart Analyst", note: "Deterministic screenshot analysis" },
      { href: ROUTES.validation, label: "Historical Validation", note: "Causal scenario evaluation" },
      { href: ROUTES.comparison, label: "Comparison Lab", note: "Frozen strategies, one protocol" },
      { href: ROUTES.research, label: "Research Desk", note: "Official sources, attributed" },
    ],
  },
  { type: "link", href: PUBLIC_ROUTES.features, label: "Features" },
  { type: "link", href: "/#how-it-works", label: "How It Works" },
  { type: "link", href: PUBLIC_ROUTES.methodology, label: "Methodology" },
  {
    type: "group",
    label: "Resources",
    items: [
      { href: "/#faq", label: "FAQ", note: "Uploads, data sources, fingerprints" },
      { href: PUBLIC_ROUTES.riskDisclosure, label: "Risk disclosure" },
      { href: PUBLIC_ROUTES.about, label: "About" },
      { href: PUBLIC_ROUTES.contact, label: "Contact" },
    ],
  },
] as const;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Brand />
        <SiteNav items={NAV_ENTRIES} />
        <div className="ml-auto flex items-center gap-2">
          <Link
            href={ROUTES.dataImport}
            className={buttonVariants({ size: "sm", className: "hidden sm:inline-flex" })}
          >
            Analyze your data
          </Link>
          <SiteMobileNav items={NAV_ENTRIES} />
        </div>
      </div>
    </header>
  );
}
