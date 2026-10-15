import type { Metadata } from "next";
import { ChartWorkspace } from "@/components/charts/chart-workspace";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { DemoNotice } from "@/components/shared/demo";
import { FEATURED_INSTRUMENTS, getNavItem, ROUTES } from "@/lib/constants";
import { getAnalysisSnapshots } from "@/lib/services/intelligence";
import { getSystemStatus } from "@/lib/services/system-status";
import type { ChartQuery } from "@/lib/utils";

export const metadata: Metadata = { title: "Chart Intelligence" };

interface ChartPageProps {
  /** Next.js delivers search params as a promise; the workspace resolves selection from them. */
  searchParams: Promise<ChartQuery>;
}

export default async function ChartPage({ searchParams }: ChartPageProps) {
  const snapshots = getAnalysisSnapshots(FEATURED_INSTRUMENTS.map((asset) => asset.symbol));
  // Server-derived dependency status — no client fetch, no polling.
  const services = getSystemStatus();
  const query = await searchParams;

  return (
    <PageContainer>
      <PageHeader module={getNavItem(ROUTES.chart)} />
      {snapshots.source === "demo" ? <DemoNotice /> : null}
      <ChartWorkspace
        snapshots={snapshots.data}
        source={snapshots.source}
        services={services}
        searchParams={query}
      />
    </PageContainer>
  );
}
