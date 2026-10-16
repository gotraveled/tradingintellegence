/**
 * Server-boundary tests for POST /api/analysis — the route owns the provider, the
 * composition, and the engine; the key never leaves the server. Providers are
 * injected through the configured-provider registry; no real Polygon traffic occurs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { POST } from "../route";
import { ProviderRouter, setConfiguredProvider } from "@/lib/market-data/providers";
import { CANONICAL_TIMEFRAMES } from "@/lib/market-data/providers/capabilities";
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
  supports(r: MarketDataRequest): boolean {
    // Honest unsupported surface — mirrors Polygon's NSE stance.
    return r.asset.marketId !== "indian-markets";
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
  symbols: ["AAPL"],
  timeframe: "1h",
  lookbackDays: 7,
  asOf: "2024-01-03T12:00:00Z",
};

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/analysis", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

afterEach(() => {
  setConfiguredProvider(undefined);
  delete process.env.POLYGON_API_KEY;
});

describe("POST /api/analysis", () => {
  it("missing credentials → 503 honest unavailable, never demo", async () => {
    delete process.env.POLYGON_API_KEY;
    const res = await post(REQUEST);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.service).toBe("Market data provider");
    expect(body.error.message).toMatch(/configured|unavailable/i);
    expect(body.result).toBeUndefined();
  });

  it("configured provider → real engine run → AnalysisResult contract", async () => {
    setConfiguredProvider(new TestProvider(Array.from({ length: 120 }, (_, i) => flatBar(i))));
    const res = await post(REQUEST);
    expect(res.status).toBe(200);
    const body = await res.json();
    const r = body.result;
    expect(Date.parse(r.asOf)).toBe(Date.parse(REQUEST.asOf));
    expect(r.cells).toHaveLength(1);
    expect(r.cells[0].symbol).toBe("AAPL");
    expect(r.cells[0].timeframe).toBe("1h");
    expect(r.cells[0].barCount).toBeGreaterThan(0);
    expect(typeof r.cells[0].evaluatedIndex).toBe("number");
    expect(typeof r.cells[0].evaluatedAt).toBe("number");
    expect(r.cells[0].quality.status).toBe("valid");
    expect(Array.isArray(r.opportunities)).toBe(true);
    expect(Array.isArray(r.developing)).toBe(true);
    expect(Array.isArray(r.skipped)).toBe(true);
    expect(r.dataSource.id).toBe("test");
    expect(r.dataSource.kind).toBe("fixture");
    expect(typeof r.versions.paramsVersion).toBe("string");
    // Flat series → an honest empty scan, not fabricated setups.
    expect(r.opportunities).toHaveLength(0);
  });

  it("anchor is the last CLOSED bar at asOf — an open bar is never the evaluation point", async () => {
    // asOf lands INSIDE bar i's open→close window: bar60 opens at 11:00 (close 12:00)
    // while asOf = 11:30 — so the anchor must be bar59, not bar60.
    const rows = Array.from({ length: 80 }, (_, i) => flatBar(i));
    const asOf = new Date(EPOCH + 60 * H1 + H1 / 2).toISOString();
    setConfiguredProvider(new TestProvider(rows));
    const res = await post({ ...REQUEST, asOf });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.cells[0].evaluatedIndex).toBe(59);
    expect(body.result.cells[0].evaluatedAt).toBe(EPOCH + 59 * H1);
  });

  it("identical inputs → identical records (determinism)", async () => {
    setConfiguredProvider(new TestProvider(Array.from({ length: 120 }, (_, i) => flatBar(i))));
    const a = await (await post(REQUEST)).json();
    const b = await (await post(REQUEST)).json();
    expect(JSON.stringify(a.result.opportunities)).toBe(JSON.stringify(b.result.opportunities));
    expect(JSON.stringify(a.result.developing)).toBe(JSON.stringify(b.result.developing));
    expect(JSON.stringify(a.result.cells)).toBe(JSON.stringify(b.result.cells));
  });

  it("rejects malformed bodies and invalid requests before provider access", async () => {
    setConfiguredProvider(new TestProvider([]));
    expect((await post("not-json{")).status).toBe(400);
    expect((await post({ ...REQUEST, timeframe: "" })).status).toBe(400);
    expect((await post({ ...REQUEST, timeframe: "7h" })).status).toBe(400);
    expect((await post({ ...REQUEST, asOf: "garbage" })).status).toBe(400);
    expect((await post({ ...REQUEST, lookbackDays: 999 })).status).toBe(400);
    expect((await post({ ...REQUEST, lookbackDays: -1 })).status).toBe(400);
    expect((await post({ ...REQUEST, symbols: Array.from({ length: 20 }, (_, i) => `S${i}`) })).status).toBe(400);
    expect((await post({ ...REQUEST, symbols: "AAPL" })).status).toBe(400);
  });

  it("unsupported symbols surface in skipped — partial failures never fabricate", async () => {
    setConfiguredProvider(new TestProvider(Array.from({ length: 120 }, (_, i) => flatBar(i))));
    const res = await post({ ...REQUEST, symbols: ["AAPL", "NIFTY 50"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.cells).toHaveLength(1);
    expect(body.result.cells[0].symbol).toBe("AAPL");
    expect(body.result.skipped).toHaveLength(1);
    expect(body.result.skipped[0].symbol).toBe("NIFTY 50");
    expect(body.result.skipped[0].reason).toMatch(/unsupported/i);
  });

  it("all symbols unsupported → 503, never an empty fabricated scan", async () => {
    setConfiguredProvider(new TestProvider(Array.from({ length: 120 }, (_, i) => flatBar(i))));
    const res = await post({ ...REQUEST, symbols: ["NIFTY 50"] });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.service).toBe("Market data provider");
    expect(body.result).toBeUndefined();
  });

  it("insufficient history → honest skip, not an evaluation", async () => {
    // Two bars only — the window contains them, but asOf lands before the second bar
    // closes, leaving exactly one anchorable bar. The engine still runs; what matters
    // is the sparse-history path is reported, not hidden.
    setConfiguredProvider(new TestProvider([flatBar(0), flatBar(1)]));
    const res = await post({ ...REQUEST, asOf: new Date(EPOCH + H1 / 2).toISOString() });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.service).toBe("Market data provider");
  });
  it("public scope + unverified display rights → 503 with no provider data in the payload", async () => {
    // The router enforces rights — any route consuming it inherits the gate.
    const router = new ProviderRouter(
      [
        {
          provider: new TestProvider(Array.from({ length: 120 }, (_, i) => flatBar(i))),
          capability: {
            providerId: "test",
            markets: ["us-stocks", "crypto", "forex", "commodities", "indices"],
            technicalTimeframes: CANONICAL_TIMEFRAMES,
            entitledTimeframes: CANONICAL_TIMEFRAMES,
            classification: "delayed",
            confidence: "declared",
            displayRights: "unknown", // not authorized → fail closed
            note: "test row",
          },
        },
      ],
      "public",
    );
    setConfiguredProvider(router);
    const res = await post(REQUEST);
    expect(res.status).toBe(503);
    const body = await res.json();
    const text = JSON.stringify(body);
    // No result, no candle array, no bar fields, no opportunity records — the
    // payload carries only the honest error, never provider data.
    expect(body.result).toBeUndefined();
    expect(text).not.toMatch(/"candles"\s*:\s*\[/);
    expect(text).not.toContain('"open"');
    expect(text).not.toMatch(/"cells"\s*:\s*\[\s*{/);
    expect(text).not.toContain("1704");
    expect(body.error.service).toBe("Market data provider");
  });

  it("internal scope still serves the same provider — the gate is scope-aware", async () => {
    const router = new ProviderRouter(
      [
        {
          provider: new TestProvider(Array.from({ length: 120 }, (_, i) => flatBar(i))),
          capability: {
            providerId: "test",
            markets: ["us-stocks"],
            technicalTimeframes: CANONICAL_TIMEFRAMES,
            entitledTimeframes: CANONICAL_TIMEFRAMES,
            classification: "delayed",
            confidence: "declared",
            displayRights: "unknown",
            note: "test row",
          },
        },
      ],
      "internal",
    );
    setConfiguredProvider(router);
    const res = await post(REQUEST);
    expect(res.status).toBe(200);
  });

  it("never leaks the API key or provider internals into the response", async () => {
    process.env.POLYGON_API_KEY = "test-secret-key";
    setConfiguredProvider(new TestProvider(Array.from({ length: 10 }, (_, i) => flatBar(i))));
    const res = await post(REQUEST);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("test-secret-key");
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("api.polygon.io");
  });
});
