import {
  DEMO_DEVELOPING_SETUPS,
  DEMO_MARKET_REGIMES,
  DEMO_OPPORTUNITIES,
} from "@/lib/mock/demo-data";
import type {
  AssetClass,
  DevelopingSetup,
  MarketRegimeSnapshot,
  OpportunitySummary,
  SetupType,
} from "@/lib/types";

export type DataSource = "demo" | "live";

/** Every payload declares its source so the UI can label demo content. */
export interface DataEnvelope<T> {
  source: DataSource;
  data: T;
}

interface SetupFilter {
  setupType?: SetupType;
  assetClass?: AssetClass;
  limit?: number;
}

function applyFilter<T extends { setupType: SetupType; assetClass: AssetClass; score: number }>(
  items: T[],
  { setupType, assetClass, limit }: SetupFilter = {},
) {
  const filtered = items
    .filter((item) => (setupType ? item.setupType === setupType : true))
    .filter((item) => (assetClass ? item.assetClass === assetClass : true))
    .sort((a, b) => b.score - a.score);
  return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
}

/*
 * Until a market-data provider and the analysis engine are connected, these functions return
 * demo data. Replace the bodies with real clients; callers and UI stay unchanged.
 */

export function getMarketRegimes(): DataEnvelope<MarketRegimeSnapshot[]> {
  return { source: "demo", data: DEMO_MARKET_REGIMES };
}

export function getOpportunities(filter?: SetupFilter): DataEnvelope<OpportunitySummary[]> {
  return { source: "demo", data: applyFilter(DEMO_OPPORTUNITIES, filter) };
}

export function getDevelopingSetups(filter?: SetupFilter): DataEnvelope<DevelopingSetup[]> {
  return { source: "demo", data: applyFilter(DEMO_DEVELOPING_SETUPS, filter) };
}
