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
  /**
   * How many bars the caller actually asked for (or the window's expected
   * count where determinable). When the request itself is smaller than
   * DATA_MIN_BARS, satisfying it is `ok` — the floor compares against the
   * request, never against a universal minimum that punishes small windows.
   */
  requestedBars?: number;
}

export function assessDataSufficiency(input: DataSufficiencyInput): DataSufficiency {
  const { candles, quality, requestedBars } = input;
  if (candles.length === 0) return "empty";
  if (quality.status === "invalid") return "insufficient";
  if (quality.coveragePct !== undefined && quality.coveragePct < DATA_MIN_COVERAGE_PCT) {
    return "insufficient";
  }
  // The floor is the smaller of the absolute minimum and the request — a
  // 5-bar ask filled with 5 bars is complete; a 300-bar ask filled with 9 is
  // a fragment. Provider-limited history (window truncated before start) still
  // fails the floor when the request wanted more than the market produced.
  const floor = Math.min(DATA_MIN_BARS, requestedBars ?? DATA_MIN_BARS);
  if (candles.length < floor) return "insufficient";
  return "ok";
}
