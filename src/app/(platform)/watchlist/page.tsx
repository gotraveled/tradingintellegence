import type { Metadata } from "next";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { DemoNotice } from "@/components/shared/demo";
import { WatchlistWorkspace } from "@/components/watchlist/watchlist-workspace";
import { getNavItem, ROUTES } from "@/lib/constants";
import { getWatchlist } from "@/lib/services/watchlist";

export const metadata: Metadata = { title: "Watchlist" };

export default function WatchlistPage() {
  const watchlist = getWatchlist();

  return (
    <PageContainer>
      <PageHeader module={getNavItem(ROUTES.watchlist)} />
      {watchlist.source === "demo" ? <DemoNotice /> : null}
      <WatchlistWorkspace initialItems={watchlist.data} source={watchlist.source} />
    </PageContainer>
  );
}
