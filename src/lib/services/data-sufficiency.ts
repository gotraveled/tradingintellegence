/**
 * Data sufficiency — the product-layer verdict on whether a returned candle
 * window can support normal use (Phase M1, MARKET_DATA_INTEGRATION_DESIGN §3 /
 * COVERAGE_DISCOVERY §4.2). Deterministic rules, no provider specifics:
 *
 *   empty        — the provider answered OK with zero candles. A valid result,
 *                  never an error: the range genuinely holds no bars.
 *   insufficient — nonzero but not usable as a complete window:
 *                    · quality.status "invalid"  — per-bar integrity failed
 *                    · coveragePct < 50          — where the calendar can count
 *                      expected bars (24/7 feeds), under half is a fragment
 *                    · candleCount < MIN_BARS    — too few bars for a chart or
 *                      an engine run to mean anything
 *   ok           — none of the above.
 *
 * The rule deliberately does NOT reject a window just for having gaps —
 * `coveragePct` is undefined for session calendars, and an honest partial
 * window (e.g. a short requested range) is charted with its quality report
 * intact. `insufficient` gates the *display as normal data*, not the facts.
 */
import type { Candle, DataQualityReport, DataSufficiency } from "@/lib/types";

/** Fewer bars than this can never drive a chart or an analysis cell. */
export const DATA_MIN_BARS = 10;
/** Below this share of expected bars, a countable calendar saw a fragment. */
export const DATA_MIN_COVERAGE_PCT = 50;

export interface DataSufficiencyInput {
  candles: readonly Candle[];
  quality: DataQualityReport;
}

export function assessDataSufficiency(input: DataSufficiencyInput): DataSufficiency {
  const { candles, quality } = input;
  if (candles.length === 0) return "empty";
  if (quality.status === "invalid") return "insufficient";
  if (quality.coveragePct !== undefined && quality.coveragePct < DATA_MIN_COVERAGE_PCT) {
    return "insufficient";
  }
  if (candles.length < DATA_MIN_BARS) return "insufficient";
  return "ok";
}
