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
import { getNavItem, ROUTES, scannerViewHref } from "@/lib/constants";
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

      <Section
        title="Market Regime"
        description="Direction, regime, and strength for key benchmarks."
        badge={<SourceBadge source={regimes.source} />}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          {regimes.data.map((snapshot) => (
            <MarketRegimeCard key={snapshot.symbol} snapshot={snapshot} />
          ))}
        </div>
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
