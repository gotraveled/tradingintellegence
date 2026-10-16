import type { Metadata } from "next";
import { ResearchDesk } from "@/components/research/research-desk";

export const metadata: Metadata = {
  title: "Research Desk",
  description:
    "Official public feeds — SEC filings, central-bank releases, and economic statistics, attributed and linked.",
};

export default function ResearchPage() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 lg:p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Research Desk</h1>
        <p className="text-sm text-muted-foreground">
          Official sources only — filings, central-bank releases, and statistics.
          Headlines link out to the source; nothing is editorialized.
        </p>
      </header>
      <ResearchDesk />
    </div>
  );
}
