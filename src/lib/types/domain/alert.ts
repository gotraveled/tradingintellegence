import type { ID, ISODateTime, Price, Score, Timestamps } from "./common";
import type { OpportunityStatus } from "./opportunity";
import type { SetupType } from "./setup";

export type AlertChannel = "in_app" | "email" | "webhook";

export type AlertStatus = "active" | "paused" | "triggered" | "expired";

/** Discriminated union so new condition kinds can be added without breaking existing ones. */
export type AlertCondition =
  | { kind: "setup_status"; symbol?: string; setupType?: SetupType; status: OpportunityStatus }
  | { kind: "score_threshold"; symbol?: string; minScore: Score }
  | { kind: "price_level"; symbol: string; price: Price; crossing: "above" | "below" }
  | { kind: "zone_interaction"; symbol: string; zoneId: ID };

export interface Alert extends Timestamps {
  id: ID;
  userId?: ID;
  name: string;
  condition: AlertCondition;
  channels: AlertChannel[];
  status: AlertStatus;
  lastTriggeredAt?: ISODateTime;
  expiresAt?: ISODateTime;
}
