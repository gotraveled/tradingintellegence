import { LineChart } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { SubNav } from "@/components/navigation/sub-nav";
import { Section } from "@/components/shared/section";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ConnectionBadge } from "@/components/ui/status";
import { TableShell } from "@/components/ui/table-shell";
import { getNavItem, marketSegmentHref, ROUTES, type MarketSegment } from "@/lib/constants";
import { MarketOverview } from "./market-overview";
import { MarketSessionsPanel } from "./market-sessions-panel";

const COLUMNS = [
  { key: "symbol", label: "Instrument" },
  { key: "last", label: "Last", align: "right" as const },
  { key: "change", label: "Change", align: "right" as const },
  { key: "structure", label: "Structure" },
  { key: "regime", label: "Regime" },
  { key: "setups", label: "Active setups", align: "right" as const },
];

/** Shared layout for "Global Markets" and each market segment. */
export function MarketsWorkspace({ segment }: { segment?: MarketSegment }) {
  const markets = getNavItem(ROUTES.markets);
  const current = segment ? marketSegmentHref(segment.id) : ROUTES.markets;
  const label = segment?.label ?? "Global Markets";

  return (
    <PageContainer>
      <PageHeader
        module={markets}
        eyebrow={segment ? "Markets" : undefined}
        title={label}
        description={segment?.description ?? markets.description}
        meta={segment ? <>Trading hours: {segment.hours}</> : undefined}
      />
      <SubNav label="Market segments" items={markets.children ?? []} current={current} />

      {segment ? null : (
        <Section title="Coverage" description="Markets the platform is designed to analyse.">
          <MarketOverview />
        </Section>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader
            title={segment ? `${segment.label} instruments` : "Instrument universe"}
            description="Quotes, structure, and regime per instrument."
            action={<ConnectionBadge status="not_configured" />}
          />
          <TableShell
            caption={`${label} instruments`}
            columns={COLUMNS}
            empty={
              <EmptyState
                icon={LineChart}
                title="No market data provider configured"
                description={
                  segment
                    ? `Connect a ${segment.label.toLowerCase()} data provider to populate instruments such as ${segment.examples.slice(0, 3).join(", ")}.`
                    : "Connect a market-data provider to populate instruments, quotes, and structural state."
                }
              />
            }
          />
        </Card>
        <MarketSessionsPanel />
      </div>
    </PageContainer>
  );
}
