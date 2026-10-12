import { DEMO_WATCHLIST } from "@/lib/mock";
import type { WatchlistItem } from "@/lib/types";
import type { DataEnvelope } from "./types";

/* Returns demo data until accounts and persistence exist. */

export function getWatchlist(): DataEnvelope<WatchlistItem[]> {
  return { source: "demo", data: DEMO_WATCHLIST };
}
