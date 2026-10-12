import { DEMO_ANALYSIS, DEMO_MARKET_REGIMES, DEMO_OPPORTUNITIES } from "@/lib/mock";
import type { AnalysisSnapshot, MarketRegimeSnapshot, Opportunity } from "@/lib/types";
import {
  filterOpportunities,
  sortOpportunities,
  type OpportunityFilter,
  type OpportunitySortKey,
} from "@/lib/utils/opportunity-filters";

export type DataSource = "demo" | "live";

/** Every payload declares its source so the UI can label demo content. */
export interface DataEnvelope<T> {
  source: DataSource;
  data: T;
}

export interface OpportunityQuery extends OpportunityFilter {
  sort?: OpportunitySortKey;
  limit?: number;
}

/*
 * Until a market-data provider and the analysis engine are connected, these functions return
 * demo data. Replace the bodies with real clients; callers and UI stay unchanged.
 */

export function getMarketRegimes(): DataEnvelope<MarketRegimeSnapshot[]> {
  return { source: "demo", data: DEMO_MARKET_REGIMES };
}

export function getOpportunities(query: OpportunityQuery = {}): DataEnvelope<Opportunity[]> {
  const { sort = "score", limit, ...filter } = query;
  const sorted = sortOpportunities(filterOpportunities(DEMO_OPPORTUNITIES, filter), sort);
  return { source: "demo", data: limit === undefined ? sorted : sorted.slice(0, limit) };
}

export function getAnalysisSnapshot(symbol: string): DataEnvelope<AnalysisSnapshot | null> {
  return { source: "demo", data: DEMO_ANALYSIS.find((item) => item.symbol === symbol) ?? null };
}

/** Snapshots keyed by symbol. Symbols without analysis are omitted. */
export function getAnalysisSnapshots(
  symbols: string[],
): DataEnvelope<Record<string, AnalysisSnapshot>> {
  const data: Record<string, AnalysisSnapshot> = {};
  for (const symbol of symbols) {
    const snapshot = DEMO_ANALYSIS.find((item) => item.symbol === symbol);
    if (snapshot) data[symbol] = snapshot;
  }
  return { source: "demo", data };
}
