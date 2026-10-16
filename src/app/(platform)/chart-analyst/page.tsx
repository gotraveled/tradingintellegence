import type { Metadata } from "next";
import { ChartAnalystWorkspace } from "@/components/chart-analyst/chart-analyst-workspace";

export const metadata: Metadata = {
  title: "Chart Analyst",
  description:
    "Upload a chart screenshot and get a structured technical read — measured locally from pixels, never sent to a third party.",
};

export default function ChartAnalystPage() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 lg:p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Chart Analyst</h1>
        <p className="text-sm text-muted-foreground">
          Screenshot in, structured read out. Candle detection is deterministic —
          an optional local vision model can add a narrative, nothing is uploaded
          anywhere.
        </p>
      </header>
      <ChartAnalystWorkspace />
    </div>
  );
}
