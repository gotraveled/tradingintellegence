import type { Metadata } from "next";
import { StrategyComparisonWorkspace } from "@/components/validation/strategy-comparison-workspace";
import { ExperimentRegistryPanel } from "@/components/validation/experiment-registry-panel";

export const metadata: Metadata = {
  title: "Strategy Comparison Lab",
  description:
    "Compare frozen engine configurations on your own uploaded data under one shared evaluation protocol — descriptive, causal, reproducible.",
};

export default function ComparisonPage() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 lg:p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Strategy Comparison Lab</h1>
        <p className="text-sm text-muted-foreground">
          Evaluate 2–6 frozen strategy snapshots side-by-side on the same
          uploaded data, under the same horizon, costs, split, and purge rules.
          Rows are descriptive — different opportunity counts are reported, not
          reconciled, and no ordering here is statistically decisive. This is a
          research tool: no optimization and no execution. Past results never
          imply future performance.
        </p>
      </header>
      <ExperimentRegistryPanel />
      <StrategyComparisonWorkspace />
    </div>
  );
}
