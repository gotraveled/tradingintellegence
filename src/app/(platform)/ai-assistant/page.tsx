import type { Metadata } from "next";
import { AssistantWorkspace } from "@/components/assistant/assistant-workspace";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { CapabilityList } from "@/components/shared/capability-list";
import { Notice } from "@/components/ui/notice";
import { getNavItem, ROUTES } from "@/lib/constants";

export const metadata: Metadata = { title: "Market Intelligence Assistant" };

const SOURCES = [
  {
    title: "Scanner results",
    description: "Current developing and confirmed setups across markets.",
  },
  { title: "Market structure", description: "Trend state, swings, BOS and CHOCH per timeframe." },
  { title: "Zones & liquidity", description: "Demand/supply zones, liquidity pools, and sweeps." },
  {
    title: "Score breakdown",
    description: "Which conditions contributed to a setup's quality score.",
  },
  { title: "Historical validation", description: "How comparable setups behaved in backtests." },
];

const BOUNDARIES = [
  {
    title: "Explains, does not instruct",
    description: "No buy or sell calls, position sizing advice, or guarantees.",
  },
  { title: "Cites its evidence", description: "Every answer references the data it is based on." },
  {
    title: "States uncertainty",
    description: "Missing conditions and small samples are called out.",
  },
];

export default function AiAssistantPage() {
  return (
    <PageContainer>
      <PageHeader
        module={getNavItem(ROUTES.assistant)}
        title="Market Intelligence Assistant"
        description="Ask why setups qualify, how they were scored, and what the market structure shows. Not a general-purpose chatbot."
      />
      <Notice tone="warning" title="Live intelligence will be connected in a later phase">
        The interface is ready; the AI backend is not. Messages you send will not be analysed yet.
      </Notice>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <AssistantWorkspace />
        <div className="space-y-6">
          <CapabilityList
            title="What it will draw on"
            description="Answers will be grounded in platform data."
            capabilities={SOURCES}
          />
          <CapabilityList
            title="Boundaries"
            description="How the assistant behaves."
            capabilities={BOUNDARIES}
          />
        </div>
      </div>
    </PageContainer>
  );
}
