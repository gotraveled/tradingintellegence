import type { Timeframe, UnixMs } from "@/lib/types";

/**
 * Canonical timeframe model (docs/market-data). Minute/hour timeframes have a deterministic
 * fixed duration; day/week/month are calendar-based and aligned to UTC boundaries.
 */

/** Fixed durations in milliseconds. "1M" is intentionally absent — months vary in length. */
export const TIMEFRAME_MS: Record<Exclude<Timeframe, "1M">, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "12h": 43_200_000,
  "1D": 86_400_000,
  "1W": 604_800_000,
};

const DAY_MS = 86_400_000;

/** Fixed duration in ms, or undefined for calendar-based "1M". */
export function timeframeMs(tf: Timeframe): number | undefined {
  return tf === "1M" ? undefined : TIMEFRAME_MS[tf];
}

/** True when both timeframes are fixed-length and the source evenly divides the target. */
export function intervalDivisible(source: Timeframe, target: Timeframe): boolean {
  const s = timeframeMs(source);
  const t = timeframeMs(target);
  return s !== undefined && t !== undefined && t > s && t % s === 0;
}

/**
 * Bar-open alignment floor for a timestamp. Fixed timeframes align to epoch multiples;
 * "1D" aligns to UTC midnight, "1W" to UTC Monday, "1M" to UTC month start.
 * All UTC — no locale or local-timezone dependence.
 */
export function alignFloor(time: UnixMs, tf: Timeframe): UnixMs {
  if (tf === "1M") {
    const d = new Date(time);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  if (tf === "1W") {
    const d = new Date(time);
    // ISO week: Monday = boundary.
    const dayOffset = (d.getUTCDay() + 6) % 7;
    const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return midnight - dayOffset * DAY_MS;
  }
  const ms = timeframeMs(tf);
  return ms === undefined ? time : time - (time % ms);
}
