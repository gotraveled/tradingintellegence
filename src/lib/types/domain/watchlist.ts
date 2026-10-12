import type { Direction, ID, ISODateTime, Score, Timestamps } from "./common";
import type { AssetClass, MarketSegmentId } from "./market";
import type { OpportunityStatus } from "./opportunity";
import type { SetupType } from "./setup";

/** Status of a watched instrument: the state of its most relevant setup, or none. */
export type WatchlistStatus = OpportunityStatus | "no_setup";

export interface WatchlistItem extends Timestamps {
  id: ID;
  watchlistId?: ID;
  symbol: string;
  market: MarketSegmentId;
  assetClass: AssetClass;
  status: WatchlistStatus;
  setupType?: SetupType;
  direction?: Direction;
  score?: Score;
  opportunityId?: ID;
  lastUpdate: ISODateTime;
  note?: string;
}

export interface Watchlist extends Timestamps {
  id: ID;
  userId?: ID;
  name: string;
  items: WatchlistItem[];
}
