import type { Metadata } from "next";
import { AlertsWorkspace } from "@/components/alerts/alerts-workspace";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { DemoNotice } from "@/components/shared/demo";
import { getNavItem, ROUTES } from "@/lib/constants";
import { getAlertEvents, getAlerts } from "@/lib/services/alerts";

export const metadata: Metadata = { title: "Alerts" };

export default function AlertsPage() {
  const alerts = getAlerts();
  const events = getAlertEvents();

  return (
    <PageContainer>
      <PageHeader module={getNavItem(ROUTES.alerts)} />
      {alerts.source === "demo" ? <DemoNotice /> : null}
      <AlertsWorkspace initialAlerts={alerts.data} events={events.data} source={events.source} />
    </PageContainer>
  );
}
