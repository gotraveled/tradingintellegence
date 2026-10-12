import type { RawCandle } from "@/lib/types";
import type { CandleFixture } from "./provider";

/**
 * Deterministic test datasets (spec 17). These are TEST FIXTURES — deliberately synthetic,
 * small, and labelled "FIX-*". They are not live market data and are not shaped to produce
 * trading signals. 2024-01-01 00:00Z is a Monday — used as the epoch anchor everywhere.
 */

const M5 = 300_000;
export const FIXTURE_EPOCH = Date.UTC(2024, 0, 1); // Monday 2024-01-01T00:00:00Z

/** Deterministic 5m bar: flat-ish range around base+i so expected values are hand-checkable. */
function bar(i: number, open = 100, high = 101, low = 99, close = 100.5): RawCandle {
  return { time: FIXTURE_EPOCH + i * M5, open, high, low, close, volume: 1000 + i };
}

export const FIXTURES: CandleFixture[] = [
  // 1 — clean continuous 5m series.
  {
    name: "clean-continuous",
    symbol: "FIX-CLEAN",
    timeframe: "5m",
    rows: Array.from({ length: 8 }, (_, i) => bar(i)),
  },
  // 2 — one bar absent in the middle (index 4 missing → delta = 2 intervals).
  {
    name: "missing-candle",
    symbol: "FIX-MISSING",
    timeframe: "5m",
    rows: [bar(0), bar(1), bar(2), bar(3), bar(5), bar(6), bar(7)],
  },
  // 3 — timestamp of bar(2) emitted twice.
  {
    name: "duplicate-candle",
    symbol: "FIX-DUP",
    timeframe: "5m",
    rows: [bar(0), bar(1), bar(2), bar(2), bar(3), bar(4)],
  },
  // 4 — bar(2) appears after bar(3).
  {
    name: "out-of-order",
    symbol: "FIX-OOO",
    timeframe: "5m",
    rows: [bar(0), bar(1), bar(3), bar(2), bar(4)],
  },
  // 5 — bar with high < close (envelope violation) at index 2.
  {
    name: "invalid-ohlc",
    symbol: "FIX-BADOHLC",
    timeframe: "5m",
    rows: [
      bar(0),
      bar(1),
      { time: FIXTURE_EPOCH + 2 * M5, open: 100, high: 99, low: 98, close: 100.5 },
      bar(3),
    ],
  },
  // 6 — Friday 23:55 → Monday 00:00: weekend gap, expected for a weekday calendar.
  {
    name: "weekend-gap",
    symbol: "FIX-WEEKEND",
    timeframe: "5m",
    is24x7: false,
    rows: [
      {
        time: Date.UTC(2024, 0, 5, 23, 50),
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 500,
      },
      {
        time: Date.UTC(2024, 0, 5, 23, 55),
        open: 100.5,
        high: 101,
        low: 99.5,
        close: 100,
        volume: 510,
      },
      {
        time: Date.UTC(2024, 0, 8, 0, 0),
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 520,
      },
    ],
  },
  // 7 — twelve 5m bars = four clean 15m windows (aggregation source).
  {
    name: "agg-5m-12",
    symbol: "FIX-AGG5M",
    timeframe: "5m",
    rows: Array.from({ length: 12 }, (_, i) => bar(i, 100 + i, 102 + i, 99 + i, 101 + i)),
  },
  // 8 — registered but empty.
  { name: "empty", symbol: "FIX-EMPTY", timeframe: "5m", rows: [] },
  // 9 — exactly one bar.
  { name: "single-candle", symbol: "FIX-SINGLE", timeframe: "5m", rows: [bar(0)] },
  // 10 — one full UTC day of 5m bars (288), deterministic walk — no randomness.
  {
    name: "large-day",
    symbol: "FIX-LARGE",
    timeframe: "5m",
    rows: Array.from({ length: 288 }, (_, i) =>
      bar(
        i,
        100 + (i % 24) * 0.1,
        100.6 + (i % 24) * 0.1,
        99.4 + (i % 24) * 0.1,
        100 + (i % 24) * 0.1,
      ),
    ),
  },
];
