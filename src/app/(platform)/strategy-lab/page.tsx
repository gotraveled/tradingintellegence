import { FlaskConical } from "lucide-react";
import type { Metadata } from "next";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { CapabilityList } from "@/components/shared/capability-list";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { getNavItem, ROUTES } from "@/lib/constants";

export const metadata: Metadata = { title: "Strategy Lab" };

const CAPABILITIES = [
  {
    title: "Rule builder",
    description: "Compose setups from evidence conditions across timeframes.",
  },
  {
    title: "Historical backtesting",
    description: "Run rules against historical data with realistic costs and slippage assumptions.",
  },
  {
    title: "Robustness checks",
    description: "Out-of-sample periods, parameter sensitivity, and sample-size warnings.",
  },
  {
    title: "Paper trading",
    description: "Forward-test strategies in simulated conditions before any live use.",
  },
];

export default function StrategyLabPage() {
  return (
    <PageContainer>
      <PageHeader module={getNavItem(ROUTES.strategyLab)} />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader title="Backtests" description="Saved strategies and their validation runs." />
          <EmptyState
            icon={FlaskConical}
            title="No strategies yet"
            description="Past performance of a strategy does not guarantee future results. Validation here is designed to expose weaknesses, not to promise returns."
          />
        </Card>
        <CapabilityList capabilities={CAPABILITIES} />
      </div>
    </PageContainer>
  );
}
