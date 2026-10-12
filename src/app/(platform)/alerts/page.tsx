import { Bell } from "lucide-react";
import type { Metadata } from "next";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { CapabilityList } from "@/components/shared/capability-list";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { getNavItem, ROUTES } from "@/lib/constants";

export const metadata: Metadata = { title: "Alerts" };

const CAPABILITIES = [
  {
    title: "Setup lifecycle alerts",
    description: "Notify when a setup starts developing, qualifies, or is invalidated.",
  },
  {
    title: "Level alerts",
    description: "Price interaction with zones, liquidity pools, or imbalances.",
  },
  { title: "Delivery channels", description: "In-app, email, and webhook delivery." },
];

export default function AlertsPage() {
  return (
    <PageContainer>
      <PageHeader module={getNavItem(ROUTES.alerts)} />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader title="Active alerts" />
          <EmptyState
            icon={Bell}
            title="No alerts configured"
            description="Alert rules will be available once the analysis engine and a delivery channel are connected."
          />
        </Card>
        <CapabilityList capabilities={CAPABILITIES} />
      </div>
    </PageContainer>
  );
}
