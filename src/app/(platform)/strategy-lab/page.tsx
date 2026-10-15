import type { Metadata } from "next";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { CapabilityList } from "@/components/shared/capability-list";
import { StrategyLabWorkspace } from "@/components/strategy-lab/strategy-lab-workspace";
import { Notice } from "@/components/ui/notice";
import { getNavItem, ROUTES } from "@/lib/constants";
import { getDemoBacktestResult, getStrategies } from "@/lib/services/backtesting";

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
  const strategies = getStrategies();

  return (
    <PageContainer>
      <PageHeader module={getNavItem(ROUTES.strategyLab)} />
      <Notice tone="warning" title="Market-data provider required">
        Backtests run on the real engine (spec 26) over provider-supplied history. No historical
        market-data provider is connected yet, so runs report as unavailable — never demo data
        presented as real.
      </Notice>
      <StrategyLabWorkspace strategies={strategies.data} demoResult={getDemoBacktestResult()} />
      <CapabilityList capabilities={CAPABILITIES} />
    </PageContainer>
  );
}
