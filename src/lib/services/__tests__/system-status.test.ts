/**
 * Status-semantics tests — verify getSystemStatus reports configured capability,
 * last-observed connectivity, and per-request failures as distinct facts, and never
 * fabricates reachability from credentials alone. Provider "requests" here are an
 * injected fake wrapped in observeProviderHealth — no real provider traffic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearProviderConnectivity,
  MARKET_DATA_KEY_ENV,
  observeProviderHealth,
  setConfiguredProvider,
} from "@/lib/market-data/providers";
import { providerError } from "@/lib/market-data/provider";
import type { HistoricalDataProvider, ProviderResponse } from "@/lib/market-data/provider";
import type { MarketDataRequest } from "@/lib/types";
import {
  getMarketDataStatus,
  getSystemStatus,
  isMarketDataConnected,
  type ServiceStatus,
} from "../system-status";

const REQUEST: MarketDataRequest = {
  asset: { symbol: "AAA" },
  timeframe: "1h",
  start: 0,
  end: 60_000,
};

const SOURCE = { id: "test", kind: "rest" as const, label: "Test provider" };

const QUALITY = {
  symbol: "AAA",
  timeframe: "1h" as const,
  barCount: 0,
  missingBarCount: 0,
  duplicateCount: 0,
  invalidBarCount: 0,
  outOfOrderCount: 0,
  gaps: [],
  warnings: [],
  errors: [],
  info: [],
  status: "valid" as const,
};

class FakeProvider implements HistoricalDataProvider {
  readonly source = SOURCE;
  constructor(private readonly response: ProviderResponse) {}
  supports(): boolean {
    return true;
  }
  async getCandles(): Promise<ProviderResponse> {
    return this.response;
  }
}

class ThrowingProvider implements HistoricalDataProvider {
  readonly source = SOURCE;
  supports(): boolean {
    return true;
  }
  async getCandles(): Promise<ProviderResponse> {
    throw new Error("socket hang up");
  }
}

const okResponse: ProviderResponse = {
  ok: true,
  result: { candles: [], quality: QUALITY, source: SOURCE },
};

const service = (id: string): ServiceStatus => {
  const found = getSystemStatus().find((s) => s.id === id);
  if (!found) throw new Error(`service '${id}' missing`);
  return found;
};

describe("getSystemStatus", () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env[MARKET_DATA_KEY_ENV];
    delete process.env[MARKET_DATA_KEY_ENV];
    setConfiguredProvider(undefined);
    clearProviderConnectivity();
  });

  afterEach(() => {
    setConfiguredProvider(undefined);
    clearProviderConnectivity();
    if (savedKey === undefined) delete process.env[MARKET_DATA_KEY_ENV];
    else process.env[MARKET_DATA_KEY_ENV] = savedKey;
  });

  it("reports every service when nothing is configured — no fabricated connectivity", () => {
    expect(service("market-data").status).toBe("not_configured");
    // Streaming absence is separate — it never marks historical data disconnected.
    expect(service("live-quotes").status).toBe("not_configured");
    expect(service("live-quotes").description).toMatch(/not implemented|aggregates only/i);
    // In-process engine: functional but blocked by the missing provider — degraded,
    // not "disconnected" as if it were an unwired external service.
    expect(service("analysis-engine").status).toBe("degraded");
    expect(service("backtesting").status).toBe("degraded");
    expect(service("alerts").status).toBe("not_configured");
    expect(isMarketDataConnected()).toBe(false);
  });

  it("reports configured-but-unverified — a credential alone is not connectivity", () => {
    setConfiguredProvider(new FakeProvider(okResponse));
    expect(service("market-data").status).toBe("unverified");
    expect(service("market-data").description).toMatch(/verified/i);
    expect(service("analysis-engine").status).toBe("connected");
    expect(service("backtesting").status).toBe("connected");
    expect(isMarketDataConnected()).toBe(false);
  });

  it("env credentials also count as configured-unverified without a completed request", () => {
    process.env[MARKET_DATA_KEY_ENV] = "TEST-KEY-NOT-REAL";
    expect(service("market-data").status).toBe("unverified");
    expect(isMarketDataConnected()).toBe(false);
  });

  it("reports connected only after a real request is answered", async () => {
    const wrapped = observeProviderHealth(new FakeProvider(okResponse));
    setConfiguredProvider(wrapped);
    await wrapped.getCandles(REQUEST);
    expect(service("market-data").status).toBe("connected");
    expect(service("market-data").description).toMatch(/answered/i);
    expect(isMarketDataConnected()).toBe(true);
  });

  it("reports degraded after a provider-level failure", async () => {
    const wrapped = observeProviderHealth(
      new FakeProvider(providerError("provider_error", "upstream 502")),
    );
    setConfiguredProvider(wrapped);
    await wrapped.getCandles(REQUEST);
    expect(service("market-data").status).toBe("degraded");
    expect(service("market-data").description).toMatch(/failed|unavailable/i);
    expect(isMarketDataConnected()).toBe(false);
  });

  it("reports degraded on rate limiting and thrown transport errors", async () => {
    const limited = observeProviderHealth(
      new FakeProvider(providerError("rate_limited", "429")),
    );
    setConfiguredProvider(limited);
    await limited.getCandles(REQUEST);
    expect(service("market-data").status).toBe("degraded");

    const throwing = observeProviderHealth(new ThrowingProvider());
    setConfiguredProvider(throwing);
    await expect(throwing.getCandles(REQUEST)).rejects.toThrow("socket hang up");
    expect(service("market-data").status).toBe("degraded");
  });

  it("request-level failures are NOT connectivity — provider answered, request unsupported", async () => {
    for (const code of [
      "unsupported_symbol",
      "unsupported_timeframe",
      "data_not_available",
      "invalid_request",
      "incomplete_data",
    ] as const) {
      clearProviderConnectivity();
      const wrapped = observeProviderHealth(
        new FakeProvider(providerError(code, `${code} fixture`)),
      );
      setConfiguredProvider(wrapped);
      await wrapped.getCandles(REQUEST);
      // The provider responded — connectivity is verified even though the request
      // failed. The per-request outcome is surfaced in API skipped/quality payloads.
      expect(service("market-data").status).toBe("connected");
    }
  });

  it("later observations replace earlier ones — degradation then recovery", async () => {
    const failing = observeProviderHealth(
      new FakeProvider(providerError("provider_error", "down")),
    );
    setConfiguredProvider(failing);
    await failing.getCandles(REQUEST);
    expect(service("market-data").status).toBe("degraded");

    const healthy = observeProviderHealth(new FakeProvider(okResponse));
    setConfiguredProvider(healthy);
    await healthy.getCandles(REQUEST);
    expect(service("market-data").status).toBe("connected");
  });

  it("exposes no credentials or provider internals in status payloads", () => {
    process.env[MARKET_DATA_KEY_ENV] = "SECRET-UNIT-TEST-KEY";
    setConfiguredProvider(new FakeProvider(okResponse));
    const payload = JSON.stringify(getSystemStatus());
    expect(payload).not.toContain("SECRET-UNIT-TEST-KEY");
    expect(payload).not.toContain("polygon.io");
    expect(payload).not.toContain("apiKey");
    expect(payload).not.toContain("baseUrl");
  });

  it("getMarketDataStatus returns the market-data entry verbatim — the shared badge derivation", () => {
    // Consumers (topbar, markets, chart strip) must never substitute their own status.
    expect(getMarketDataStatus()).toEqual(
      getSystemStatus().find((s) => s.id === "market-data"),
    );
  });

  it("declared capability rides the market-data entry — never invented for unknown providers", () => {
    // Env-configured deployment: the Polygon capability row is present.
    process.env[MARKET_DATA_KEY_ENV] = "TEST-KEY-NOT-REAL";
    const md = service("market-data");
    expect(md.dataAvailability).toBeDefined();
    expect(md.dataAvailability?.classification).toBe("delayed");
    expect(md.dataAvailability?.confidence).toBe("inferred"); // POLYGON_PLAN unset
    expect(md.dataAvailability?.displayRights).toBe("unknown");
    expect(md.dataAvailability?.timeframes).toEqual(["1D", "1W", "1M"]); // Basic EOD
    expect(md.dataAvailability?.note).toMatch(/DELAYED|Basic/i);
    expect(md.description).toMatch(/inferred/i);

    // An injected provider has no declared row — capabilities are not fabricated.
    delete process.env[MARKET_DATA_KEY_ENV];
    setConfiguredProvider(new FakeProvider(okResponse));
    expect(service("market-data").dataAvailability).toBeUndefined();
  });

  it("serving scope + display verdict ride the status entry — honest, never hidden", () => {
    process.env[MARKET_DATA_KEY_ENV] = "TEST-KEY-NOT-REAL";
    const md = service("market-data");
    // Under the test env the scope is internal → unknown rights do not block.
    expect(md.dataAvailability?.serving).toBe("internal");
    expect(md.dataAvailability?.displayAllowed).toBe(true);
    // An explicit public scope flips the verdict — the gate's own answer.
    process.env.MARKET_DATA_SERVING = "public";
    try {
      const pub = service("market-data");
      expect(pub.dataAvailability?.serving).toBe("public");
      expect(pub.dataAvailability?.displayAllowed).toBe(false); // polygon row is unknown
      expect(pub.description).toMatch(/not authorized/i);
    } finally {
      delete process.env.MARKET_DATA_SERVING;
    }
  });

  it("declared POLYGON_PLAN widens the surfaced entitlement set", () => {
    process.env[MARKET_DATA_KEY_ENV] = "TEST-KEY-NOT-REAL";
    process.env.POLYGON_PLAN = "starter";
    try {
      const md = service("market-data");
      expect(md.dataAvailability?.confidence).toBe("declared");
      expect(md.dataAvailability?.timeframes).toContain("4h");
      expect(md.description).not.toMatch(/inferred/i);
    } finally {
      delete process.env.POLYGON_PLAN;
    }
  });

  it("getMarketDataStatus tracks each state transition", async () => {
    expect(getMarketDataStatus().status).toBe("not_configured");
    setConfiguredProvider(new FakeProvider(okResponse));
    expect(getMarketDataStatus().status).toBe("unverified");
    const wrapped = observeProviderHealth(new FakeProvider(okResponse));
    setConfiguredProvider(wrapped);
    await wrapped.getCandles(REQUEST);
    expect(getMarketDataStatus().status).toBe("connected");
  });
});
