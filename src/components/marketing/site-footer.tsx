import Link from "next/link";
import { BrandMark } from "@/components/navigation/brand";
import { PUBLIC_ROUTES, RISK_DISCLAIMER, ROUTES, SITE } from "@/lib/constants";

const COLUMNS: { heading: string; links: { href: string; label: string }[] }[] = [
  {
    heading: "Platform",
    links: [
      { href: ROUTES.dataImport, label: "Data Import" },
      { href: ROUTES.chartAnalyst, label: "Chart Analyst" },
      { href: ROUTES.validation, label: "Historical Validation" },
      { href: ROUTES.comparison, label: "Comparison Lab" },
    ],
  },
  {
    heading: "Product",
    links: [
      { href: PUBLIC_ROUTES.features, label: "Features" },
      { href: PUBLIC_ROUTES.methodology, label: "Methodology" },
      { href: "/#how-it-works", label: "How it works" },
      { href: "/#faq", label: "FAQ" },
      { href: PUBLIC_ROUTES.markets, label: "Markets" },
      { href: PUBLIC_ROUTES.pricing, label: "Pricing" },
    ],
  },
  {
    heading: "Company",
    links: [
      { href: PUBLIC_ROUTES.about, label: "About" },
      { href: PUBLIC_ROUTES.contact, label: "Contact" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { href: PUBLIC_ROUTES.riskDisclosure, label: "Risk disclosure" },
      { href: PUBLIC_ROUTES.terms, label: "Terms of use" },
      { href: PUBLIC_ROUTES.privacyPolicy, label: "Privacy policy" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-6xl space-y-8 px-4 py-10 sm:px-6">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-2.5">
            <div className="flex items-center gap-2.5">
              <BrandMark className="size-5" />
              <span className="text-sm font-medium">{SITE.name}</span>
            </div>
            <p className="text-xs text-subtle-foreground">{SITE.tagline}</p>
          </div>
          {COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={`Footer — ${column.heading}`}>
              <h3 className="text-xs font-medium tracking-wide text-subtle-foreground uppercase">
                {column.heading}
              </h3>
              <ul className="mt-3 space-y-2">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <p className="max-w-3xl text-xs leading-relaxed text-subtle-foreground">
          {RISK_DISCLAIMER}
        </p>
      </div>
    </footer>
  );
}
