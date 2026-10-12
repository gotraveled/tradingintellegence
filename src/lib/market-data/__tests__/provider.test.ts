import { describe, expect, it } from "vitest";
import type { MarketDataRequest } from "@/lib/types";
import { createFixtureProvider, FIXTURE_EPOCH as E } from "..";

const req = (symbol: string, over: Partial<MarketDataRequest> = {}): MarketDataRequest => ({
  asset: { symbol },
  timeframe: "5m",
  start: E,
  end: E + 86_400_000,
  ...over,
});

describe("FixtureProvider", () => {
  it("serves a registered fixture through the normalized request", async () => {
    const provider = createFixtureProvider();
    const res = await provider.getCandles(req("FIX-CLEAN"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.candles).toHaveLength(8);
    expect(res.result.quality.status).toBe("valid");
    expect(res.result.source.kind).toBe("fixture");
  });

  it("returns identical output on repeat calls — deterministic", async () => {
    const provider = createFixtureProvider();
    const a = await provider.getCandles(req("FIX-CLEAN"));
    const b = await provider.getCandles(req("FIX-CLEAN"));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("honours the [start, end) window and limit", async () => {
    const provider = createFixtureProvider();
    const res = await provider.getCandles(
      req("FIX-CLEAN", { start: E + 2 * 300_000, end: E + 5 * 300_000 }),
    );
    expect(res.ok && res.result.candles).toHaveLength(3);
    const limited = await provider.getCandles(req("FIX-CLEAN", { limit: 3 }));
    expect(limited.ok && limited.result.candles).toHaveLength(3);
    expect(limited.ok && limited.result.candles[2].time).toBe(E + 2 * 300_000);
  });

  it("rejects unknown symbols", async () => {
    const provider = createFixtureProvider();
    const res = await provider.getCandles(req("NOPE"));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unsupported_symbol");
  });

  it("rejects timeframe mismatches", async () => {
    const provider = createFixtureProvider();
    const res = await provider.getCandles(req("FIX-CLEAN", { timeframe: "15m" }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unsupported_timeframe");
  });

  it("rejects inverted ranges", async () => {
    const provider = createFixtureProvider();
    const res = await provider.getCandles(req("FIX-CLEAN", { start: 200, end: 100 }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid_request");
  });

  it("surfaces data problems via quality — never silently repairs", async () => {
    const provider = createFixtureProvider();
    const missing = await provider.getCandles(req("FIX-MISSING"));
    expect(missing.ok && missing.result.quality.status).toBe("valid_with_warnings");
    expect(missing.ok && missing.result.quality.missingBarCount).toBe(1);
    const dup = await provider.getCandles(req("FIX-DUP"));
    expect(dup.ok && dup.result.quality.status).toBe("invalid");
    expect(dup.ok && dup.result.quality.duplicateCount).toBe(1);
  });

  it("empty fixture returns a valid empty result", async () => {
    const provider = createFixtureProvider();
    const res = await provider.getCandles(req("FIX-EMPTY"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.candles).toHaveLength(0);
    expect(res.result.quality.barCount).toBe(0);
  });

  it("supports() reflects the registry", () => {
    const provider = createFixtureProvider();
    expect(provider.supports(req("FIX-CLEAN"))).toBe(true);
    expect(provider.supports(req("NOPE"))).toBe(false);
  });
});
