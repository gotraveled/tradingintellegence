import type { ISODateTime } from "@/lib/types";

const DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

/**
 * Deterministic UTC formatting (identical on server and client, so no hydration mismatch).
 * e.g. "12 Oct, 09:15 UTC".
 */
export function formatDateTimeUTC(value: ISODateTime) {
  return `${DATE_TIME.format(new Date(value))} UTC`;
}
