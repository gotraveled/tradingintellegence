import type { Metadata } from "next";
import Link from "next/link";
import { Check } from "lucide-react";
import { PublicPage } from "@/components/marketing/public-page";
import { buttonVariants } from "@/components/ui/button";
import { PUBLIC_ROUTES, ROUTES } from "@/lib/constants";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Planned access tiers for AI Trading Intelligence.",
};

const TIERS = [
  {
    name: "Explorer",
    summary: "Preview the platform while it is in development.",
    points: [
      "Market intelligence dashboard",
      "Scanner with developing & confirmed setups",
      "Watchlist (session only)",
    ],
  },
  {
    name: "Analyst",
    summary: "Planned for active retail traders.",
    points: [
      "Everything in Explorer",
      "Saved alerts and persistent watchlists",
      "Strategy lab with backtesting",
      "Market Intelligence Assistant",
    ],
  },
  {
    name: "Desk",
    summary: "Planned for small teams and systematic traders.",
    points: [
      "Everything in Analyst",
      "API access to the intelligence engine",
      "Webhooks and higher limits",
    ],
  },
] as const;

export default function PricingPage() {
  return (
    <PublicPage
      eyebrow="Pricing"
      title="Early access is free while we build"
      description="Pricing is not final. The platform is in development and the tiers below describe planned access levels, not a purchasable product."
    >
      <div className="grid gap-4 sm:grid-cols-3">
        {TIERS.map((tier) => (
          <section
            key={tier.name}
            aria-label={`${tier.name} tier`}
            className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5"
          >
            <div className="space-y-1">
              <h2 className="text-base font-semibold">{tier.name}</h2>
              <p className="text-xs text-muted-foreground">{tier.summary}</p>
            </div>
            <p className="text-lg font-semibold">
              Coming soon
              <span className="sr-only"> — pricing to be announced</span>
            </p>
            <ul className="space-y-2">
              {tier.points.map((point) => (
                <li key={point} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-bullish" aria-hidden="true" />
                  {point}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Link href={ROUTES.dashboard} className={buttonVariants()}>
          Explore the platform
        </Link>
        <Link href={PUBLIC_ROUTES.contact} className={buttonVariants({ variant: "secondary" })}>
          Contact us
        </Link>
      </div>
    </PublicPage>
  );
}
