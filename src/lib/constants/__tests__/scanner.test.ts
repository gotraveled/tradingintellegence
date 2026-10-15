import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEFRAME,
  FEATURED_INSTRUMENTS,
  SCAN_REQUEST,
} from "@/lib/constants";

describe("SCAN_REQUEST", () => {
  // `AnalysisRequest.symbols` is optional in the type — assert the concrete request
  // always defines it before testing its contents.
  const symbols = SCAN_REQUEST.symbols ?? [];

  it("derives its symbols exactly from FEATURED_INSTRUMENTS", () => {
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols).toEqual(FEATURED_INSTRUMENTS.map((asset) => asset.symbol));
  });

  it("contains no duplicate symbols", () => {
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it("requests the shared default timeframe", () => {
    expect(SCAN_REQUEST.timeframe).toBe(DEFAULT_TIMEFRAME);
  });

  it("includes NIFTY 50 — the catalog entry the hardcoded list used to drop", () => {
    const inCatalog = FEATURED_INSTRUMENTS.some((a) => a.symbol === "NIFTY 50");
    expect(inCatalog).toBe(true);
    expect(symbols).toContain("NIFTY 50");
  });

  it("invents no instruments outside the catalog", () => {
    const catalog = new Set(FEATURED_INSTRUMENTS.map((a) => a.symbol));
    for (const symbol of symbols) {
      expect(catalog.has(symbol)).toBe(true);
    }
  });
});
