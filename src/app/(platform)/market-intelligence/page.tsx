import { Globe2, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { EvidenceFrameworkPanel } from "@/components/dashboard/evidence-framework-panel";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { MarketSessionsPanel } from "@/components/markets/market-sessions-panel";
import { CapabilityList } from "@/components/shared/capability-list";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { getNavItem, ROUTES } from "@/lib/constants";

export const metadata: Metadata = { title: "Market Intelligence" };

const CAPABILITIES = [
  {
    title: "Cross-asset overview",
    description: "Indices, rates, currencies, and commodities in one view.",
  },
  { title: "Economic calendar", description: "Scheduled events with expected volatility context." },
  {
    title: "AI market explanations",
    description: "Plain-language summaries grounded in the underlying data, with sources.",
  },
  {
    title: "Regime detection",
    description: "Trending, ranging, and high-volatility regime classification.",
  },
];

export default function MarketIntelligencePage() {
  return (
    <PageContainer>
      <PageHeader module={getNavItem(ROUTES.marketIntelligence)} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Global overview" description="Cross-asset context." />
          <EmptyState
            icon={Globe2}
            title="No market data"
            description="Global context will populate once a market-data provider is connected."
          />
        </Card>
        <MarketSessionsPanel />
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader
            title="AI market briefing"
            description="Generated explanations will cite the evidence they are based on."
          />
          <EmptyState
            icon={Sparkles}
            title="Briefings not available"
            description="AI explanations describe market conditions. They are not predictions or recommendations."
          />
        </Card>
        <CapabilityList capabilities={CAPABILITIES} />
      </div>
      <EvidenceFrameworkPanel />
    </PageContainer>
  );
}
