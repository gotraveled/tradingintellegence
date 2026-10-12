import type {
  AssetClass,
  Direction,
  MarketSegmentId,
  Opportunity,
  OpportunityStatus,
  SetupType,
  Timeframe,
} from "@/lib/types";

export interface OpportunityFilter {
  market?: MarketSegmentId;
  assetClass?: AssetClass;
  timeframe?: Timeframe;
  setupType?: SetupType;
  direction?: Direction;
  status?: OpportunityStatus | OpportunityStatus[];
  minScore?: number;
}

export type OpportunitySortKey = "score" | "updated" | "riskReward";

export function lastUpdated(opportunity: Opportunity) {
  return opportunity.updatedAt ?? opportunity.createdAt;
}

/** Pure, framework-agnostic filtering. Shared by services and client-side UI. */
export function filterOpportunities(items: Opportunity[], filter: OpportunityFilter = {}) {
  const statuses =
    filter.status === undefined
      ? undefined
      : Array.isArray(filter.status)
        ? filter.status
        : [filter.status];

  return items.filter(
    (item) =>
      (!filter.market || item.market === filter.market) &&
      (!filter.assetClass || item.assetClass === filter.assetClass) &&
      (!filter.timeframe || item.timeframe === filter.timeframe) &&
      (!filter.setupType || item.setupType === filter.setupType) &&
      (!filter.direction || item.direction === filter.direction) &&
      (!statuses || statuses.includes(item.status)) &&
      (filter.minScore === undefined || item.score >= filter.minScore),
  );
}

export function sortOpportunities(
  items: Opportunity[],
  key: OpportunitySortKey = "score",
  order: "asc" | "desc" = "desc",
) {
  const value = (item: Opportunity) => {
    if (key === "updated") return Date.parse(lastUpdated(item));
    if (key === "riskReward") return item.riskReward ?? -Infinity;
    return item.score;
  };
  const sign = order === "desc" ? -1 : 1;
  return [...items].sort((a, b) => sign * (value(a) - value(b)));
}
