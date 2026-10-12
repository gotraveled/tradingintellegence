import type {
  Direction,
  ID,
  ISODateTime,
  Metadata,
  Price,
  Score,
  Timeframe,
  Timestamps,
} from "./common";
import type { MarketSegmentId } from "./market";
import type { ZoneType } from "./zone";

export type AlertType =
  | "developing_setup"
  | "confirmed_reversal"
  | "confirmed_breakout"
  | "confirmed_continuation"
  | "zone_approach"
  | "target_reached"
  | "invalidation_reached";

export type AlertChannel = "in_app" | "email" | "webhook";

export type AlertStatus = "active" | "paused" | "expired";

/** Which instruments an alert watches. All fields optional = everything. */
export interface AlertScope {
  symbols?: string[];
  markets?: MarketSegmentId[];
  timeframes?: Timeframe[];
  direction?: Direction;
  minScore?: Score;
}

/** Type-specific parameters. Discriminated by `type` so new kinds stay backwards compatible. */
export type AlertParams =
  | {
      type:
        "developing_setup" | "confirmed_reversal" | "confirmed_breakout" | "confirmed_continuation";
    }
  | {
      type: "zone_approach";
      zoneType?: ZoneType;
      /** Distance from zone edge, in % of price. */ proximityPct: number;
    }
  | { type: "target_reached"; targetLabel?: string }
  | { type: "invalidation_reached" };

export interface Alert extends Timestamps {
  id: ID;
  userId?: ID;
  name: string;
  params: AlertParams;
  scope: AlertScope;
  channels: AlertChannel[];
  status: AlertStatus;
  lastTriggeredAt?: ISODateTime;
  expiresAt?: ISODateTime;
}

/** A single delivery of an alert. */
export interface AlertEvent {
  id: ID;
  alertId: ID;
  type: AlertType;
  symbol: string;
  timeframe?: Timeframe;
  message: string;
  price?: Price;
  opportunityId?: ID;
  triggeredAt: ISODateTime;
  read?: boolean;
  metadata?: Metadata;
}
