import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEFRAME,
  FEATURED_INSTRUMENTS,
  instrumentsBySegment,
  MARKET_SEGMENTS,
} from "@/lib/constants";
import { chartHref } from "@/lib/utils";

describe("instrumentsBySegment", () => {
  it("returns only instruments belonging to the requested segment", () => {
    for (const segment of MARKET_SEGMENTS) {
      for (const asset of instrumentsBySegment(segment.id)) {
        expect(asset.marketId).toBe(segment.id);
      }
    }
  });

  it("partitions the catalog — every instrument lands in exactly one segment", () => {
    const grouped = MARKET_SEGMENTS.flatMap((segment) =>
      instrumentsBySegment(segment.id).map((asset) => asset.symbol),
    );
    expect(grouped.length).toBe(FEATURED_INSTRUMENTS.length);
    expect([...grouped].sort()).toEqual(
      FEATURED_INSTRUMENTS.map((asset) => asset.symbol).sort(),
    );
  });

  it("keeps NIFTY 50 in indian-markets", () => {
    expect(instrumentsBySegment("indian-markets").map((a) => a.symbol)).toContain(
      "NIFTY 50",
    );
  });

  it("gives the toolbar selector a non-empty optgroup per segment", () => {
    for (const segment of MARKET_SEGMENTS) {
      expect(instrumentsBySegment(segment.id).length).toBeGreaterThan(0);
    }
  });
});

describe("markets/watchlist → chart destinations", () => {
  it("every catalog instrument resolves a chart href at the default timeframe", () => {
    for (const asset of FEATURED_INSTRUMENTS) {
      const href = chartHref(asset.symbol, DEFAULT_TIMEFRAME);
      expect(href).toBeDefined();
      const params = new URLSearchParams(href!.split("?")[1]);
      expect(params.get("symbol")).toBe(asset.symbol);
      expect(params.get("timeframe")).toBe(DEFAULT_TIMEFRAME);
    }
  });

  it("entry-point links never carry analyze — navigation is not an analysis request", () => {
    for (const asset of FEATURED_INSTRUMENTS) {
      expect(chartHref(asset.symbol, DEFAULT_TIMEFRAME)).not.toContain("analyze");
    }
  });

  it("non-catalog watchlist symbols produce no destination", () => {
    expect(chartHref("GME", DEFAULT_TIMEFRAME)).toBeUndefined();
    expect(chartHref("RELIANCE", DEFAULT_TIMEFRAME)).toBeUndefined();
  });
});
