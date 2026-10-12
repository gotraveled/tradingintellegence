import type { Candle, DataGap, DataValidationIssue, Timeframe } from "@/lib/types";
import { alignFloor, timeframeMs } from "./timeframes";
import type { SessionCalendar } from "./sessions";

/**
 * Deterministic candle validation (spec 4). Pure, single-pass, O(n) where possible.
 * Corrupt data is NEVER silently repaired — issues are returned as structured findings.
 */

export interface ValidationResult {
  issues: DataValidationIssue[];
  /** Candles that passed per-bar checks (index positions may differ from input). */
  validBars: Candle[];
  duplicateCount: number;
  outOfOrderCount: number;
  invalidBarCount: number;
  gaps: DataGap[];
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function issue(
  code: DataValidationIssue["code"],
  severity: DataValidationIssue["severity"],
  message: string,
  index?: number,
  timestamp?: number,
): DataValidationIssue {
  return { code, severity, message, index, timestamp };
}

/**
 * Per-bar structural checks (spec 4). A bar failing any of these is excluded from `validBars`
 * and counted in `invalidBarCount` — never patched.
 */
export function validateBars(candles: Candle[], timeframe: Timeframe): DataValidationIssue[] {
  const issues: DataValidationIssue[] = [];
  const interval = timeframeMs(timeframe);

  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    if (c.time === undefined || c.time === null) {
      issues.push(issue("missing_timestamp", "error", `bar ${i}: no timestamp`, i));
      continue;
    }
    if (!finite(c.time) || c.time <= 0) {
      issues.push(
        issue(
          "invalid_timestamp",
          "error",
          `bar ${i}: timestamp not finite/positive`,
          i,
          undefined,
        ),
      );
      continue;
    }
    if (![c.open, c.high, c.low, c.close].every(finite)) {
      issues.push(issue("non_finite_ohlc", "error", `bar ${i}: non-finite OHLC`, i, c.time));
      continue;
    }
    if (c.high < Math.max(c.open, c.close, c.low) || c.low > Math.min(c.open, c.close, c.high)) {
      issues.push(
        issue(
          "invalid_ohlc_relationship",
          "error",
          `bar ${i}: high/low envelope violated`,
          i,
          c.time,
        ),
      );
      continue;
    }
    if (c.volume !== undefined && (!finite(c.volume) || c.volume < 0)) {
      issues.push(
        issue("negative_volume", "error", `bar ${i}: negative/non-finite volume`, i, c.time),
      );
      continue;
    }
    if (interval !== undefined && alignFloor(c.time, timeframe) !== c.time) {
      issues.push(
        issue(
          "misaligned_interval",
          "warning",
          `bar ${i}: timestamp not aligned to ${timeframe} boundary`,
          i,
          c.time,
        ),
      );
      continue;
    }
  }
  return issues;
}

/**
 * Series-level checks: ordering, duplicates, overlaps, and gaps (spec 4 + 12).
 * `calendar` classifies gaps; without one every multi-interval stretch is "unknown".
 */
export function validateSeries(
  candles: Candle[],
  timeframe: Timeframe,
  calendar?: SessionCalendar,
): ValidationResult {
  const issues = validateBars(candles, timeframe);
  const interval = timeframeMs(timeframe);

  const invalidIdx = new Set(
    issues.filter((i) => i.severity === "error").map((i) => i.index ?? -1),
  );
  const validBars = candles.filter((_, i) => !invalidIdx.has(i));
  const invalidBarCount = invalidIdx.size;

  let duplicateCount = 0;
  let outOfOrderCount = 0;
  const gaps: DataGap[] = [];
  const seen = new Set<number>();
  let prevTime: number | undefined;

  for (let i = 0; i < candles.length; i += 1) {
    if (invalidIdx.has(i)) continue;
    const t = candles[i].time;
    if (seen.has(t)) {
      duplicateCount += 1;
      issues.push(issue("duplicate_timestamp", "error", `bar ${i}: duplicate timestamp`, i, t));
      continue;
    }
    seen.add(t);
    if (prevTime !== undefined && t <= prevTime) {
      outOfOrderCount += 1;
      issues.push(issue("out_of_order", "error", `bar ${i}: timestamp ≤ previous valid bar`, i, t));
    }
    prevTime = Math.max(prevTime ?? t, t);
  }

  // Gaps need a fixed interval and strictly-ordered valid timestamps.
  if (interval !== undefined) {
    const ordered = [...validBars].sort((a, b) => a.time - b.time);
    for (let i = 1; i < ordered.length; i += 1) {
      const delta = ordered[i].time - ordered[i - 1].time;
      if (delta === interval) continue;
      if (delta < interval) {
        issues.push(
          issue(
            "overlapping_candle",
            "error",
            `bars ${i - 1}..${i} overlap (${delta}ms < ${interval}ms)`,
            i,
            ordered[i].time,
          ),
        );
        continue;
      }
      const missingBars = Math.floor(delta / interval) - 1;
      if (missingBars <= 0) continue;
      const kind = classifyGap(ordered[i - 1].time, ordered[i].time, interval, calendar);
      gaps.push({ kind, afterTime: ordered[i - 1].time, beforeTime: ordered[i].time, missingBars });
      issues.push(
        issue(
          kind === "expected"
            ? "gap_expected"
            : kind === "unexpected"
              ? "gap_unexpected"
              : "gap_unknown",
          kind === "expected" ? "info" : kind === "unexpected" ? "warning" : "info",
          `${missingBars} bar(s) absent between index ${i - 1} and ${i} (${kind})`,
          i,
          ordered[i].time,
        ),
      );
    }
  }

  return { issues, validBars, duplicateCount, outOfOrderCount, invalidBarCount, gaps };
}

/**
 * Gap classification (spec 12):
 * - No calendar → every gap is "unknown" (honest, not assumed corrupt).
 * - Any missing bar open-time inside an open session → "unexpected".
 * - All missing bars fall in closed time (weekend/holiday/off-hours) → "expected".
 */
function classifyGap(
  after: number,
  before: number,
  interval: number,
  calendar?: SessionCalendar,
): DataGap["kind"] {
  if (!calendar) return "unknown";
  for (let t = after + interval; t < before; t += interval) {
    if (calendar.isOpenAt(t)) return "unexpected";
  }
  return "expected";
}
