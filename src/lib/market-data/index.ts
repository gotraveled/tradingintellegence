/**
 * Market-data layer — the deterministic foundation every intelligence engine consumes
 * (docs/market-data). Pipeline: raw provider rows → normalize → validate → CandleSeries →
 * aggregate/replay. No detection logic lives here.
 */
export * from "./aggregation";
export * from "./fixtures";
export * from "./normalize";
export * from "./provider";
export * from "./quality";
export * from "./replay";
export * from "./series";
export * from "./sessions";
export * from "./timeframes";
export * from "./validation";

import type { Candle } from "@/lib/types";
import { FixtureProvider, type CandleFixture } from "./provider";
import { buildQualityReport } from "./quality";
import { alwaysOpen, weekdayUtc } from "./sessions";
import { FIXTURES } from "./fixtures";

/**
 * Ready-to-use fixture provider wired with the standard validate+quality pipeline.
 * Weekday-calendar fixtures (is24x7: false) get weekend-aware gap classification.
 */
export function createFixtureProvider(fixtures: CandleFixture[] = FIXTURES): FixtureProvider {
  return new FixtureProvider(fixtures, (candles: Candle[], fixture) =>
    buildQualityReport({
      symbol: fixture.symbol,
      timeframe: fixture.timeframe,
      candles,
      calendar: fixture.is24x7 === false ? weekdayUtc() : alwaysOpen(),
    }),
  );
}
