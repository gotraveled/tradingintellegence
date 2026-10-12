import type { Metadata } from "next";
import { ChartWorkspace } from "@/components/charts/chart-workspace";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { DemoNotice } from "@/components/shared/demo";
import { FEATURED_INSTRUMENTS, getNavItem, ROUTES } from "@/lib/constants";
import { getAnalysisSnapshots } from "@/lib/services/intelligence";

export const metadata: Metadata = { title: "Chart Intelligence" };

export default function ChartPage() {
  const snapshots = getAnalysisSnapshots(FEATURED_INSTRUMENTS.map((asset) => asset.symbol));

  return (
    <PageContainer>
      <PageHeader module={getNavItem(ROUTES.chart)} />
      {snapshots.source === "demo" ? <DemoNotice /> : null}
      <ChartWorkspace snapshots={snapshots.data} source={snapshots.source} />
    </PageContainer>
  );
}
