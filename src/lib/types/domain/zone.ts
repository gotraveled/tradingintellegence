import type { Direction, ID, ISODateTime, Metadata, Price, Score, Timeframe } from "./common";

export type ZoneType = "demand" | "supply";

/**
 * Origin pattern (docs/engine/05-06): DBR/RBR create demand, RBD/DBD create supply.
 * D=Drop, R=Rally, B=Base.
 */
export type ZonePattern = "DBR" | "RBR" | "RBD" | "DBD";

/** fresh = never retested, tested = retested at least once, mitigated = largely consumed. */
export type ZoneFreshness = "fresh" | "tested" | "mitigated";

/** "forming" and "expired" are diagnostic states (docs/engine/05 §lifecycle). */
export type ZoneStatus = "forming" | "active" | "mitigated" | "invalidated" | "expired";

export interface Zone {
  id: ID;
  symbol: string;
  timeframe: Timeframe;
  type: ZoneType;
  pattern?: ZonePattern;
  upperPrice: Price;
  lowerPrice: Price;
  /** Engine-assessed zone quality, 0–100 — evidence quality, not outcome probability. */
  strength: Score;
  freshness: ZoneFreshness;
  /** Distinct completed retests (docs/engine/07 — contiguous in-zone bars count once). */
  retestCount: number;
  lastRetestAt?: ISODateTime;
  /** Deepest penetration as % of zone height from the proximal edge; monotonic while alive. */
  penetrationDepthPct?: number;
  /** strength decayed by consumption — mutable; `strength` is the immutable origin score. */
  remainingStrength?: Score;
  status: ZoneStatus;
  /** Whether the departure leg produced a CHOCH/BOS ("strong"), minor break, or none. */
  structureImpact?: "strong" | "minor" | "none";
  /** Base formed on a sweep, or departure cleared an opposing pool. */
  liquidityContext?: "formed_on_sweep" | "departure_through_pool" | "none";
  /** FVG created on the departure leg, if any. */
  fvgId?: ID;
  /** Zone aligns with the next-higher-timeframe level in the same direction. */
  htfAligned?: boolean;
  /** Time of the candle where the zone originated. */
  originAt: ISODateTime;
  createdAt: ISODateTime;
  metadata?: Metadata;
}

/** wick-through = filled; close-through = invalidated (docs/engine/08). */
export type ImbalanceStatus = "open" | "partially_filled" | "filled" | "invalidated" | "expired";

/** Fair value gap / price inefficiency (docs/engine/08). */
export interface Imbalance {
  id: ID;
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
  upperPrice: Price;
  lowerPrice: Price;
  /** Gap height in ATR units at creation — never raw price or %. */
  gapAtr?: number;
  /** Deepest penetration into the gap as % of height; monotonic while open. */
  fillPct?: number;
  status: ImbalanceStatus;
  createdAt: ISODateTime;
  invalidatedAt?: ISODateTime;
  /** Session/zone/sweep relationship hints per spec 08 (setup scoring reads these). */
  metadata?: Metadata;
}
