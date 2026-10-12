import type { Metadata } from "next";
import { ChartWorkspace } from "@/components/charts/chart-workspace";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { getNavItem, ROUTES } from "@/lib/constants";

export const metadata: Metadata = { title: "Chart" };

export default function ChartPage() {
  return (
    <PageContainer>
      <PageHeader module={getNavItem(ROUTES.chart)} />
      <ChartWorkspace />
    </PageContainer>
  );
}
