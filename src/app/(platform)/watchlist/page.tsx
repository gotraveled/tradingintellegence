import { Star } from "lucide-react";
import type { Metadata } from "next";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { TableShell } from "@/components/ui/table-shell";
import { getNavItem, ROUTES } from "@/lib/constants";

export const metadata: Metadata = { title: "Watchlist" };

const COLUMNS = [
  { key: "symbol", label: "Instrument" },
  { key: "last", label: "Last", align: "right" as const },
  { key: "change", label: "Change", align: "right" as const },
  { key: "bias", label: "HTF bias" },
  { key: "setups", label: "Active setups", align: "right" as const },
];

export default function WatchlistPage() {
  return (
    <PageContainer>
      <PageHeader module={getNavItem(ROUTES.watchlist)} />
      <Card>
        <CardHeader title="Tracked instruments" />
        <TableShell
          caption="Watchlist"
          columns={COLUMNS}
          empty={
            <EmptyState
              icon={Star}
              title="Your watchlist is empty"
              description="Instrument search and watchlists require a market-data provider and user accounts, which arrive in a later phase."
            />
          }
        />
      </Card>
    </PageContainer>
  );
}
