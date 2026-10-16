/**
 * assessDataSufficiency — the single rule separating a valid empty window from
 * a sparse fragment that must not render as a usable chart or an analysis cell.
 * Pure function; no provider traffic.
 */
import { describe, expect, it } from "vitest";
import type { Candle, DataQualityReport } from "@/lib/types";
import {
  assessDataSufficiency,
  DATA_MIN_BARS,
  DATA_MIN_COVERAGE_PCT,
} from "../data-sufficiency";

const quality = (over: Partial<DataQualityReport> = {}): DataQualityReport => ({
  symbol: "AAA",
  timeframe: "1h",
  barCount: 0,
  missingBarCount: 0,
  duplicateCount: 0,
  invalidBarCount: 0,
  outOfOrderCount: 0,
  gaps: [],
  warnings: [],
  errors: [],
  info: [],
  status: "valid",
  ...over,
});

const bars = (n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    time: i * 3_600_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
  }));

describe("assessDataSufficiency", () => {
  it("zero candles is `empty` — a valid result, never insufficient", () => {
    expect(assessDataSufficiency({ candles: [], quality: quality() })).toBe("empty");
    // Even a quality report with warnings stays `empty` — there is nothing to misrepresent.
    expect(
      assessDataSufficiency({ candles: [], quality: quality({ status: "invalid" }) }),
    ).toBe("empty");
  });

  it("invalid quality status is insufficient regardless of bar count", () => {
    expect(
      assessDataSufficiency({
        candles: bars(50),
        quality: quality({ barCount: 50, status: "invalid" }),
      }),
    ).toBe("insufficient");
  });

  it("under MIN_BARS nonzero bars is insufficient — the sparse-intraday signature", () => {
    const candles = bars(DATA_MIN_BARS - 3);
    expect(
      assessDataSufficiency({ candles, quality: quality({ barCount: candles.length }) }),
    ).toBe("insufficient");
  });

  it("low countable coverage is insufficient; unknown coverage passes on bar count", () => {
    const candles = bars(30);
    expect(
      assessDataSufficiency({
        candles,
        quality: quality({ barCount: 30, coveragePct: DATA_MIN_COVERAGE_PCT - 10 }),
      }),
    ).toBe("insufficient");
    // Session calendars don't produce expected-bar counts — coverage unknown.
    expect(
      assessDataSufficiency({ candles, quality: quality({ barCount: 30 }) }),
    ).toBe("ok");
  });

  it("requestedBars lowers the floor — a filled small request is complete", () => {
    const candles = bars(5);
    // Without the request context, 5 < MIN_BARS looks sparse…
    expect(
      assessDataSufficiency({ candles, quality: quality({ barCount: 5 }) }),
    ).toBe("insufficient");
    // …but if the caller asked for exactly 5, the window is satisfied.
    expect(
      assessDataSufficiency({
        candles,
        quality: quality({ barCount: 5 }),
        requestedBars: 5,
      }),
    ).toBe("ok");
    // An under-filled small request is still insufficient.
    expect(
      assessDataSufficiency({
        candles: bars(3),
        quality: quality({ barCount: 3 }),
        requestedBars: 5,
      }),
    ).toBe("insufficient");
  });

  it("provider-limited history is not excused — floor follows the ask, not the yield", () => {
    // Asked for 300 daily bars; the market only produced 9 (IPO/short history).
    expect(
      assessDataSufficiency({
        candles: bars(9),
        quality: quality({ barCount: 9 }),
        requestedBars: 300,
      }),
    ).toBe("insufficient");
  });

  it("adequate bars with warnings stays ok — gaps are quality facts, not sufficiency", () => {
    const candles = bars(40);
    expect(
      assessDataSufficiency({
        candles,
        quality: quality({
          barCount: 40,
          status: "valid_with_warnings",
          warnings: [
            { code: "misaligned_interval", severity: "warning", message: "expected weekend gap" },
          ],
        }),
      }),
    ).toBe("ok");
  });
});
