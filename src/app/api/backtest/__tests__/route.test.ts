/**
 * Server-boundary tests for POST /api/backtest — the route owns the provider, the
 * composition, and the engine; the key never leaves the server. Providers are injected
 * through the configured-provider registry; no real Polygon traffic occurs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { POST } from "../route";
import { setConfiguredProvider } from "@/lib/market-data/providers";
import type { HistoricalDataProvider, ProviderResponse } from "@/lib/market-data/provider";
import type { Candle, MarketDataRequest } from "@/lib/types";

const H1 = 3_600_000;
const EPOCH = Date.UTC(2024, 0, 1);

const flatBar = (i: number): Candle => ({
  time: EPOCH + i * H1, open: 100, high: 100.5, low: 99.5, close: 100, volume: 10,
});

/** Deterministic in-test provider — real contract, no network. */
class TestProvider implements HistoricalDataProvider {
  readonly source = { id: "test", kind: "fixture" as const, label: "Test provider" };
  constructor(private readonly rows: Candle[]) {}
  supports(): boolean {
    return true;
  }
  async getCandles(r: MarketDataRequest): Promise<ProviderResponse> {
    const candles = this.rows.filter((c) => c.time >= r.start && c.time < r.end);
    return {
      ok: true,
      result: {
        candles,
        quality: {
          symbol: r.asset.symbol, timeframe: r.timeframe, barCount: candles.length,
          missingBarCount: 0, duplicateCount: 0, invalidBarCount: 0, outOfOrderCount: 0,
          gaps: [], warnings: [], errors: [], info: [], status: "valid",
        },
        source: this.source,
      },
    };
  }
}

const REQUEST = {
  strategyId: "strat-htf-reversal",
  timeframe: "1h",
  period: { from: "2024-01-01T00:00:00Z", to: "2024-01-15T00:00:00Z" },
  setupType: "reversal",
  minScore: 60,
  riskPerTradePct: 1,
};

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/backtest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

afterEach(() => {
  setConfiguredProvider(undefined);
  delete process.env.POLYGON_API_KEY;
});

describe("POST /api/backtest", () => {
  it("missing credentials → 503 honest unavailable, never demo", async () => {
    delete process.env.POLYGON_API_KEY;
    const res = await post(REQUEST);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.service).toBe("Market data provider");
    expect(body.error.message).toMatch(/configured|unavailable/i);
    expect(body.result).toBeUndefined();
  });

  it("configured provider → real engine run → BacktestResult contract", async () => {
    setConfiguredProvider(new TestProvider(Array.from({ length: 100 }, (_, i) => flatBar(i))));
    const res = await post({ ...REQUEST, symbols: ["AAA"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.strategyId).toBe("strat-htf-reversal");
    expect(body.result.symbols).toEqual(["AAA"]);
    expect(body.result.timeframe).toBe("1h");
    expect(Array.isArray(body.result.trades)).toBe(true);
    expect(body.result.sampleSize).toBe(0); // flat series — honest zero, not fabricated
    expect(Array.isArray(body.skipped)).toBe(true);
  });

  it("never leaks the API key or provider internals into the response", async () => {
    process.env.POLYGON_API_KEY = "test-secret-key";
    setConfiguredProvider(new TestProvider(Array.from({ length: 10 }, (_, i) => flatBar(i))));
    const res = await post({ ...REQUEST, symbols: ["AAA"] });
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("test-secret-key");
    expect(text).not.toContain("apiKey");
  });

  it("rejects malformed bodies and invalid requests before provider access", async () => {
    setConfiguredProvider(new TestProvider([]));
    expect((await post("not-json{")).status).toBe(400);
    expect((await post({ ...REQUEST, strategyId: "" })).status).toBe(400);
    expect((await post({ ...REQUEST, period: { from: "2024-01-02T00:00:00Z", to: "2024-01-01T00:00:00Z" } })).status).toBe(400);
    expect((await post({ ...REQUEST, symbols: Array.from({ length: 20 }, (_, i) => `S${i}`) })).status).toBe(400);
  });

  it("provider-level exhaustion surfaces as 503, not a fabricated result", async () => {
    class EmptyProvider extends TestProvider {
      constructor() {
        super([]);
      }
    }
    setConfiguredProvider(new EmptyProvider());
    const res = await post({ ...REQUEST, symbols: ["AAA"] });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.service).toBe("Market data provider");
    expect(body.result).toBeUndefined();
  });
});
