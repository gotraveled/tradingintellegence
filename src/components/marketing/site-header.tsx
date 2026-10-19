import Link from "next/link";
import { Brand } from "@/components/navigation/brand";
import { buttonVariants } from "@/components/ui/button";
import { PUBLIC_ROUTES, ROUTES } from "@/lib/constants";
import { SiteMobileNav } from "./site-mobile-nav";

const LINKS = [
  { href: PUBLIC_ROUTES.features, label: "Features" },
  { href: PUBLIC_ROUTES.methodology, label: "Methodology" },
  { href: PUBLIC_ROUTES.markets, label: "Markets" },
  { href: PUBLIC_ROUTES.pricing, label: "Pricing" },
  { href: PUBLIC_ROUTES.about, label: "About" },
] as const;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Brand />
        <nav aria-label="Marketing" className="hidden items-center gap-5 md:flex">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Link
            href={ROUTES.dataImport}
            className={buttonVariants({ size: "sm", className: "hidden sm:inline-flex" })}
          >
            Analyze your data
          </Link>
          <SiteMobileNav links={LINKS} />
        </div>
      </div>
    </header>
  );
}
