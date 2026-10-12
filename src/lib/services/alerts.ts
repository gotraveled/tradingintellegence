import { DEMO_ALERT_EVENTS, DEMO_ALERTS } from "@/lib/mock";
import type { Alert, AlertEvent } from "@/lib/types";
import type { DataEnvelope } from "./types";

/* Returns demo data until the alerting service and persistence exist. */

export function getAlerts(): DataEnvelope<Alert[]> {
  return { source: "demo", data: DEMO_ALERTS };
}

export function getAlertEvents(): DataEnvelope<AlertEvent[]> {
  return { source: "demo", data: DEMO_ALERT_EVENTS };
}
