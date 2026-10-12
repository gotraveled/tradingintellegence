import { SendHorizontal } from "lucide-react";
import type { Metadata } from "next";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { AiExplanationExample } from "@/components/shared/ai-explanation-example";
import { CapabilityList } from "@/components/shared/capability-list";
import { DemoBadge } from "@/components/shared/demo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ConnectionBadge } from "@/components/ui/status";
import { getNavItem, ROUTES } from "@/lib/constants";

export const metadata: Metadata = { title: "AI Assistant" };

const SUGGESTED_PROMPTS = [
  "Explain the current structure on BTCUSDT 4H",
  "Which conditions are still pending on this setup?",
  "Compare higher-timeframe and lower-timeframe bias for EURUSD",
  "What would invalidate this breakout?",
];

const CAPABILITIES = [
  {
    title: "Setup explanations",
    description: "Why a setup qualifies, what is missing, and what would invalidate it.",
  },
  {
    title: "Grounded answers",
    description: "Responses cite the evidence and data they are based on.",
  },
  {
    title: "No trade instructions",
    description: "The assistant explains market context. It does not issue buy or sell calls.",
  },
];

export default function AssistantPage() {
  return (
    <PageContainer>
      <PageHeader module={getNavItem(ROUTES.assistant)} />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card className="flex min-h-[520px] flex-col">
          <CardHeader
            title="Conversation"
            description="The assistant is not connected. The exchange below is an illustrative example."
            action={<ConnectionBadge status="disconnected" />}
          />
          <CardContent className="flex-1 space-y-4">
            <DemoBadge />
            <AiExplanationExample />
          </CardContent>
          <div className="space-y-3 border-t border-border p-4">
            <ul className="flex flex-wrap gap-2" aria-label="Suggested prompts">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <li key={prompt}>
                  <Button variant="outline" size="sm" disabled>
                    {prompt}
                  </Button>
                </li>
              ))}
            </ul>
            <form className="flex items-center gap-2" aria-label="Ask the assistant">
              <label htmlFor="assistant-input" className="sr-only">
                Message
              </label>
              <input
                id="assistant-input"
                disabled
                placeholder="Assistant available in a later phase"
                className="h-10 flex-1 rounded-md border border-border bg-surface-elevated px-3 text-sm placeholder:text-subtle-foreground disabled:cursor-not-allowed"
              />
              <Button type="submit" size="icon" disabled aria-label="Send">
                <SendHorizontal />
              </Button>
            </form>
          </div>
        </Card>
        <CapabilityList capabilities={CAPABILITIES} />
      </div>
    </PageContainer>
  );
}
