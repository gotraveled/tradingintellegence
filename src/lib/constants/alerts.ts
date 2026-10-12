import type { AlertChannel, AlertStatus, AlertType } from "@/lib/types";

export interface AlertTypeDefinition {
  value: AlertType;
  label: string;
  description: string;
  group: "Setup lifecycle" | "Price interaction";
}

export const ALERT_TYPES: AlertTypeDefinition[] = [
  {
    value: "developing_setup",
    label: "Developing setup",
    description: "A setup starts forming and meets its first conditions.",
    group: "Setup lifecycle",
  },
  {
    value: "confirmed_reversal",
    label: "Confirmed reversal",
    description: "A reversal setup meets all required conditions.",
    group: "Setup lifecycle",
  },
  {
    value: "confirmed_breakout",
    label: "Confirmed breakout",
    description: "A breakout is confirmed beyond its key level.",
    group: "Setup lifecycle",
  },
  {
    value: "confirmed_continuation",
    label: "Confirmed continuation",
    description: "A trend-continuation setup is confirmed.",
    group: "Setup lifecycle",
  },
  {
    value: "zone_approach",
    label: "Zone approach",
    description: "Price comes within a set distance of a demand or supply zone.",
    group: "Price interaction",
  },
  {
    value: "target_reached",
    label: "Target reached",
    description: "Price reaches a target level of a tracked setup.",
    group: "Price interaction",
  },
  {
    value: "invalidation_reached",
    label: "Invalidation reached",
    description: "Price breaches the invalidation level of a tracked setup.",
    group: "Price interaction",
  },
];

export const ALERT_TYPE_LABEL = Object.fromEntries(
  ALERT_TYPES.map((item) => [item.value, item.label]),
) as Record<AlertType, string>;

export const ALERT_CHANNELS: { value: AlertChannel; label: string }[] = [
  { value: "in_app", label: "In-app" },
  { value: "email", label: "Email" },
  { value: "webhook", label: "Webhook" },
];

export const ALERT_CHANNEL_LABEL = Object.fromEntries(
  ALERT_CHANNELS.map((item) => [item.value, item.label]),
) as Record<AlertChannel, string>;

export const ALERT_STATUS_LABEL: Record<AlertStatus, string> = {
  active: "Active",
  paused: "Paused",
  expired: "Expired",
};
