/**
 * Engine test scaffolding (docs/engine/22-testing.md).
 * Types and pure helpers only — no test-runner dependency. A runner (vitest/jest) is adopted in
 * the implementation phase; fixtures written against this contract run unchanged.
 */
import type { CandleSeries } from "@/lib/types";
import type { EngineResult } from "@/lib/services/engine";

/** The 14 required fixture categories (spec 22). */
export type FixtureCategory =
  | "normal_market"
  | "high_volatility"
  | "low_volatility"
  | "ranging_market"
  | "gaps"
  | "equal_highs_lows"
  | "overlapping_zones"
  | "repeated_retests"
  | "false_breakout"
  | "liquidity_sweep"
  | "insufficient_data"
  | "missing_volume"
  | "asset_classes"
  | "timeframes";

export const FIXTURE_CATEGORIES: readonly FixtureCategory[] = [
  "normal_market",
  "high_volatility",
  "low_volatility",
  "ranging_market",
  "gaps",
  "equal_highs_lows",
  "overlapping_zones",
  "repeated_retests",
  "false_breakout",
  "liquidity_sweep",
  "insufficient_data",
  "missing_volume",
  "asset_classes",
  "timeframes",
] as const;

/**
 * A golden fixture: a named candle series + the config + the exact expected output.
 * Fixtures are data — stored as serialized JSON alongside the suite, never code.
 */
export interface GoldenFixture<TConfig, TExpected> {
  id: string;
  category: FixtureCategory;
  /** Engine under test, e.g. "swing", "structure", "zone". */
  engine: string;
  description: string;
  input: { series: CandleSeries };
  config: TConfig;
  expected: TExpected;
  /** paramsVersion this fixture pins — config changes require deliberate re-golden'ing. */
  paramsVersion: string;
}

/** A negative expectation: input must produce errors, not data. */
export interface ErrorFixture<TConfig> {
  id: string;
  category: FixtureCategory;
  engine: string;
  input: { series: CandleSeries };
  config: TConfig;
  expectedError: "insufficient_data" | "invalid_input" | "invalid_config";
  paramsVersion: string;
}

/**
 * Determinism assertion: run an engine function twice on the same input and require deep-equal
 * results (minus nothing — engine output must be byte-identical, including event order).
 */
export function assertDeterministic<TIn, TOut>(
  run: (input: TIn) => TOut,
  input: TIn,
): { ok: boolean; diff?: { first: TOut; second: TOut } } {
  const first = run(input);
  const second = run(input);
  const same = JSON.stringify(first) === JSON.stringify(second);
  return same ? { ok: true } : { ok: false, diff: { first, second } };
}

/**
 * No-look-ahead assertion (spec 18): for every truncation point t, the engine's output on
 * candles[0..t] must equal the full-series output restricted to entities knowable by t.
 * `visibleBy` projects an output to "knowable at bar t" (e.g. filter by confirmedIndex <= t).
 */
export function assertNoLookAhead<TIn extends { series: CandleSeries }, TOut>(
  run: (input: TIn) => EngineResult<TOut>,
  input: TIn,
  visibleBy: (out: TOut, atBar: number) => TOut,
): { ok: boolean; violatedAt?: number } {
  const full = run(input);
  if (!full.ok || full.data === undefined) return { ok: false };
  for (let t = 0; t < input.series.candles.length; t += 1) {
    const truncated = run({
      ...input,
      series: { ...input.series, candles: input.series.candles.slice(0, t + 1) },
    });
    if (!truncated.ok || truncated.data === undefined) continue; // insufficient_data is a valid prefix result
    const expectedSlice = visibleBy(full.data, t);
    if (JSON.stringify(truncated.data) !== JSON.stringify(expectedSlice)) {
      return { ok: false, violatedAt: t };
    }
  }
  return { ok: true };
}
