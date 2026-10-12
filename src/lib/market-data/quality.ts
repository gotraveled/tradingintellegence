import type { Candle, DataQualityReport, Timeframe } from "@/lib/types";
import { timeframeMs } from "./timeframes";
import { validateSeries } from "./validation";
import type { SessionCalendar } from "./sessions";

/**
 * Deterministic DataQualityReport (spec 5).
 * Metrics: barCount = total input bars; expectedBarCount = calendar.expectedBars(start,end)
 * (only for calendars that can count — e.g. 24/7); missingBarCount = Σ gap.missingBars;
 * duplicateCount / invalidBarCount / outOfOrderCount from validation;
 * coveragePct = validBars / expectedBarCount × 100 (undefined when expected is unknown);
 * status = invalid when any error-severity issue exists, else valid_with_warnings when any
 * warning exists, else valid. Info issues never downgrade the status alone.
 */
export function buildQualityReport(input: {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  calendar?: SessionCalendar;
}): DataQualityReport {
  const { symbol, timeframe, candles, calendar } = input;
  const result = validateSeries(candles, timeframe, calendar);

  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");
  const info = result.issues.filter((i) => i.severity === "info");

  const startTimestamp = candles.length > 0 ? Math.min(...candles.map((c) => c.time)) : undefined;
  const endTimestamp = candles.length > 0 ? Math.max(...candles.map((c) => c.time)) : undefined;

  const interval = timeframeMs(timeframe);
  let expectedBarCount: number | undefined;
  if (
    calendar &&
    startTimestamp !== undefined &&
    endTimestamp !== undefined &&
    interval !== undefined
  ) {
    expectedBarCount = calendar.expectedBars(startTimestamp, endTimestamp + interval, interval);
  }

  const missingBarCount = result.gaps.reduce((sum, g) => sum + g.missingBars, 0);
  const coveragePct =
    expectedBarCount !== undefined && expectedBarCount > 0
      ? Math.round((result.validBars.length / expectedBarCount) * 100)
      : undefined;

  const status =
    errors.length > 0 ? "invalid" : warnings.length > 0 ? "valid_with_warnings" : "valid";

  return {
    symbol,
    timeframe,
    startTimestamp,
    endTimestamp,
    barCount: candles.length,
    expectedBarCount,
    missingBarCount,
    duplicateCount: result.duplicateCount,
    invalidBarCount: result.invalidBarCount,
    outOfOrderCount: result.outOfOrderCount,
    gaps: result.gaps,
    coveragePct,
    warnings,
    errors,
    info,
    status,
  };
}
