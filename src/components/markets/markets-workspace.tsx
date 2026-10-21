import { CandlestickChart, LineChart } from "lucide-react";
import Link from "next/link";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { SubNav } from "@/components/navigation/sub-nav";
import { Section } from "@/components/shared/section";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ConnectionBadge } from "@/components/ui/status";
import { TableShell, type TableColumn } from "@/components/ui/table-shell";
import {
  DEFAULT_TIMEFRAME,
  FEATURED_INSTRUMENTS,
  getMarketSegment,
  getNavItem,
  instrumentsBySegment,
  marketSegmentHref,
  ROUTES,
  type MarketSegment,
} from "@/lib/constants";
import { getMarketDataStatus } from "@/lib/services/system-status";
import type { Asset } from "@/lib/types";
import { chartHref } from "@/lib/utils";
import { CryptoMarketsWorkspace } from "./crypto-workspace";
import { MarketOverview } from "./market-overview";
import { MarketSessionsPanel } from "./market-sessions-panel";

const COLUMNS: TableColumn[] = [
  { key: "symbol", label: "Instrument" },
  { key: "market", label: "Market" },
  { key: "last", label: "Last", align: "right" },
  { key: "change", label: "Change", align: "right" },
  { key: "structure", label: "Structure" },
  { key: "regime", label: "Regime" },
  { key: "setups", label: "Active setups", align: "right" },
  { key: "chart", label: "Chart", align: "right" },
];

/** Catalog rows are identity only — quote-derived cells stay explicitly empty. */
const unavailable = (
  <span className="text-subtle-foreground" title="No quote data available">
    —
  </span>
);

function InstrumentRow({ asset }: { asset: Asset }) {
  const href = chartHref(asset.symbol, DEFAULT_TIMEFRAME);
  const market = getMarketSegment(asset.marketId);
  return (
    <tr className="border-b border-border last:border-b-0">
      <th scope="row" className="px-5 py-3 text-left">
        <div className="numeric font-semibold">{asset.symbol}</div>
        <div className="text-xs font-normal text-subtle-foreground">{asset.name}</div>
      </th>
      <td className="px-5 py-3 text-muted-foreground">{market?.label ?? asset.marketId}</td>
      <td className="px-5 py-3 text-right">{unavailable}</td>
      <td className="px-5 py-3 text-right">{unavailable}</td>
      <td className="px-5 py-3">{unavailable}</td>
      <td className="px-5 py-3">{unavailable}</td>
      <td className="px-5 py-3 text-right">{unavailable}</td>
      <td className="px-5 py-3 text-right">
        {href ? (
          <Link
            href={href}
            aria-label={`View ${asset.symbol} on chart`}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <CandlestickChart className="size-3.5" aria-hidden="true" />
            Chart
          </Link>
        ) : (
          <span
            className="text-xs text-muted-foreground"
            title="This instrument is not supported by the chart"
          >
            Not chartable
          </span>
        )}
      </td>
    </tr>
  );
}

/** Shared layout for "Global Markets" and each market segment. */
export function MarketsWorkspace({ segment }: { segment?: MarketSegment }) {
  const markets = getNavItem(ROUTES.markets);
  // Crypto and NSE/BSE India run on live public feeds — not provider-gated
  // previews like the catalog segments.
  const liveFeed = segment?.id === "crypto" || segment?.id === "indian-markets";
  const module_ = liveFeed ? { ...markets, availability: "available" as const } : markets;
  const current = segment ? marketSegmentHref(segment.id) : ROUTES.markets;
  const label = segment?.label ?? "Global Markets";
  // Server-derived provider status — one call per render, no client fetch.
  const marketData = getMarketDataStatus();
  const configured = marketData.status !== "not_configured";
  const instruments = segment ? instrumentsBySegment(segment.id) : FEATURED_INSTRUMENTS;

  return (
    <PageContainer>
      <PageHeader
        module={module_}
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

      {segment?.id === "crypto" ? (
        // Live public feed — Binance/Kraken crypto venues only.
        <CryptoMarketsWorkspace venues={["binance", "kraken"]} initialVenue="binance" />
      ) : segment?.id === "indian-markets" ? (
        // Live NSE/BSE index feed — a separate market from crypto.
        <CryptoMarketsWorkspace venues={["india"]} initialVenue="india" />
      ) : (
      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader
            title={segment ? `${segment.label} instruments` : "Instrument universe"}
            description={
              configured
                ? "Catalog instruments. Provider status is shown above — quotes, structure, and regime require data this feed does not supply. Per-instrument availability is verified on the chart."
                : "Quotes, structure, and regime per instrument — requires a configured market-data provider."
            }
            action={<ConnectionBadge status={marketData.status} />}
          />
          <TableShell
            caption={`${label} instruments`}
            columns={COLUMNS}
            empty={
              configured ? (
                <EmptyState
                  icon={LineChart}
                  title="No catalog instruments"
                  description={`The instrument catalog has no entries for ${label}.`}
                />
              ) : (
                <EmptyState
                  icon={LineChart}
                  title="No market data provider configured"
                  description={
                    segment
                      ? `Connect a ${segment.label.toLowerCase()} data provider to populate instruments such as ${segment.examples.slice(0, 3).join(", ")}.`
                      : "Connect a market-data provider to populate instruments, quotes, and structural state."
                  }
                />
              )
            }
          >
            {configured
              ? instruments.map((asset) => <InstrumentRow key={asset.id} asset={asset} />)
              : undefined}
          </TableShell>
        </Card>
        <MarketSessionsPanel />
      </div>
      )}
    </PageContainer>
  );
}
