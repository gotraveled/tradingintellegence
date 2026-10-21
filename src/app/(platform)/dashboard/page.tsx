import { ArrowRight, Radar } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { MarketOverview } from "@/components/markets/market-overview";
import { MarketRegimeCard } from "@/components/markets/market-regime-card";
import { OpportunityCard } from "@/components/opportunities/opportunity-card";
import { DemoNotice, SourceBadge } from "@/components/shared/demo";
import { LocalDateTime } from "@/components/shared/local-date-time";
import { Section } from "@/components/shared/section";
import { buttonVariants } from "@/components/ui/button";
import { getNavItem, marketSegmentHref, ROUTES, scannerViewHref } from "@/lib/constants";
import { getMarketRegimes, getOpportunities } from "@/lib/services/intelligence";

export const metadata: Metadata = { title: "Dashboard" };

function ViewAll({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className={buttonVariants({ variant: "ghost", size: "sm" })}>
      {label}
      <ArrowRight aria-hidden="true" />
    </Link>
  );
}

export default function DashboardPage() {
  const regimes = getMarketRegimes();
  const opportunities = getOpportunities({ status: "confirmed", limit: 3 });
  const developing = getOpportunities({ status: "developing", limit: 3 });
  const isDemo = [regimes, opportunities, developing].some((payload) => payload.source === "demo");

  return (
    <PageContainer className="space-y-10">
      <div className="space-y-5">
        <PageHeader
          module={getNavItem(ROUTES.dashboard)}
          title="Market Intelligence"
          description="Market regime, the highest-quality setups, and what is still developing."
          meta={<LocalDateTime />}
          actions={
            <Link href={ROUTES.scanner} className={buttonVariants({ variant: "secondary" })}>
              <Radar aria-hidden="true" />
              Open Scanner
            </Link>
          }
        />
        {isDemo ? <DemoNotice /> : null}
      </div>

      <Link
        href={marketSegmentHref("crypto")}
        className="group block rounded-lg border border-accent/40 bg-accent/5 p-5 transition-colors hover:bg-accent/10"
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-foreground">
              Live trading desk — Victor · Confluence
            </p>
            <p className="mt-0.5 text-sm text-subtle-foreground">
              Binance Spot and NSE/BSE indices scanned every minute: 1m pin-bar scalps at
              leg–base–leg zones, 5m confluence swings with SMC context — sessions, charts,
              and the live paper journal are on the trading page.
            </p>
          </div>
          <ArrowRight
            aria-hidden="true"
            className="size-5 shrink-0 text-subtle-foreground transition-transform group-hover:translate-x-0.5"
          />
        </div>
      </Link>

      <Section
        title="Market Regime"
        description="Direction, regime, and strength for key benchmarks."
        badge={<SourceBadge source={regimes.source} />}
      >
        <ul
          aria-label="Market regime by benchmark"
          className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:gap-4 sm:overflow-visible sm:px-0 lg:grid-cols-3 2xl:grid-cols-5"
        >
          {regimes.data.map((snapshot) => (
            <li key={snapshot.symbol} className="w-[78%] shrink-0 snap-start sm:w-auto">
              <MarketRegimeCard snapshot={snapshot} className="h-full" />
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Top Opportunities"
        description="Qualified setups ranked by quality score. Scores describe evidence quality, not the probability of profit."
        badge={<SourceBadge source={opportunities.source} />}
        action={<ViewAll href={ROUTES.scanner} label="All opportunities" />}
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {opportunities.data.map((opportunity) => (
            <OpportunityCard
              key={opportunity.id}
              opportunity={opportunity}
              demo={opportunities.source === "demo"}
            />
          ))}
        </div>
      </Section>

      <Section
        title="Developing Setups"
        description="Setups with partial evidence. Not confirmed — conditions are still pending."
        badge={<SourceBadge source={developing.source} />}
        action={<ViewAll href={scannerViewHref("developing")} label="All developing" />}
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {developing.data.map((opportunity) => (
            <OpportunityCard
              key={opportunity.id}
              opportunity={opportunity}
              demo={developing.source === "demo"}
            />
          ))}
        </div>
      </Section>

      <Section
        title="Market Overview"
        description="Coverage by market. Data feeds are not connected yet."
        action={<ViewAll href={ROUTES.markets} label="Global markets" />}
      >
        <MarketOverview />
      </Section>
    </PageContainer>
  );
}
