/**
 * ProviderRouter + capability-row tests — declared-capability gating (M1).
 * All providers are injected fakes; no real vendor traffic. The table under
 * test mirrors MARKET_DATA_INTEGRATION_DESIGN §3.1: market routing, technical
 * vs entitled timeframes, history window, classification floor, confidence
 * disclosure.
 */
import { describe, expect, it } from "vitest";
import {
  CANONICAL_TIMEFRAMES,
  polygonCapability,
  resolvePolygonPlan,
} from "../providers/capabilities";
import { ProviderRouter, type RoutedProvider } from "../providers/router";
import { providerError } from "../provider";
import type { HistoricalDataProvider, ProviderResponse } from "../provider";
import type {
  DataQualityReport,
  MarketDataRequest,
  MarketDataSource,
  MarketSegmentId,
  Timeframe,
} from "@/lib/types";

const SOURCE_A: MarketDataSource = { id: "vendor-a", kind: "rest", label: "Vendor A" };
const SOURCE_B: MarketDataSource = { id: "vendor-b", kind: "rest", label: "Vendor B" };

const QUALITY = (symbol: string, timeframe: string, barCount: number): DataQualityReport => ({
  symbol,
  timeframe: timeframe as Timeframe,
  barCount,
  missingBarCount: 0,
  duplicateCount: 0,
  invalidBarCount: 0,
  outOfOrderCount: 0,
  gaps: [],
  warnings: [],
  errors: [],
  info: [],
  status: "valid",
});

const REQ = (over: Partial<MarketDataRequest> = {}): MarketDataRequest => ({
  asset: { symbol: "AAPL", assetClass: "equities", marketId: "us-stocks" },
  timeframe: "1D",
  start: Date.UTC(2026, 8, 1),
  end: Date.UTC(2026, 9, 15),
  ...over,
});

class FakeVendor implements HistoricalDataProvider {
  constructor(
    readonly source: MarketDataSource,
    private readonly accepts: (r: MarketDataRequest) => boolean,
    private readonly response: ProviderResponse,
  ) {}
  supports(r: MarketDataRequest): boolean {
    return this.accepts(r);
  }
  async getCandles(): Promise<ProviderResponse> {
    return this.response;
  }
}

const capFor = (
  providerId: string,
  over: Partial<RoutedProvider["capability"]> = {},
): RoutedProvider["capability"] => ({
  providerId,
  markets: ["us-stocks"] as MarketSegmentId[],
  technicalTimeframes: CANONICAL_TIMEFRAMES,
  entitledTimeframes: CANONICAL_TIMEFRAMES,
  classification: "historical",
  confidence: "declared",
  displayRights: "unknown",
  note: "test row",
  ...over,
});

const okResult = (source: MarketDataSource, extra?: object): ProviderResponse => ({
  ok: true,
  result: {
    candles: [],
    quality: QUALITY("AAPL", "1D", 0),
    source,
    ...extra,
  },
});

describe("resolvePolygonPlan — entitlement is declared, never guessed upward", () => {
  it("unset → basic with inferred confidence (the smoke-tested surface)", () => {
    expect(resolvePolygonPlan(undefined)).toEqual({ plan: "basic", confidence: "inferred" });
    expect(resolvePolygonPlan("")).toEqual({ plan: "basic", confidence: "inferred" });
    expect(resolvePolygonPlan("mystery-tier")).toEqual({ plan: "basic", confidence: "inferred" });
  });

  it("recognized tiers → declared confidence", () => {
    for (const plan of ["basic", "starter", "developer", "advanced"] as const) {
      const { plan: p, confidence } = resolvePolygonPlan(plan);
      expect(p).toBe(plan);
      expect(confidence).toBe("declared");
    }
  });
});

describe("polygonCapability — the row encodes exactly what the plan serves", () => {
  it("basic entitles calendar timeframes only", () => {
    const cap = polygonCapability("basic", "inferred");
    expect(cap.entitledTimeframes).toEqual(["1D", "1W", "1M"]);
    expect(cap.technicalTimeframes).toHaveLength(13);
    expect(cap.classification).toBe("delayed");
    expect(cap.markets).not.toContain("indian-markets");
    expect(cap.displayRights).toBe("unknown");
  });

  it("starter+ entitles the full canonical set; indian-markets still absent", () => {
    const cap = polygonCapability("starter", "declared");
    expect(cap.entitledTimeframes).toEqual(CANONICAL_TIMEFRAMES);
    expect(cap.markets).not.toContain("indian-markets");
  });
});

describe("ProviderRouter — routing and capability gating", () => {
  const anyAsset = (r: MarketDataRequest) => r.asset.symbol !== "ZZZ";

  it("supports() is the asset axis only — covered market + vendor accepts", () => {
    const router = new ProviderRouter([
      {
        provider: new FakeVendor(SOURCE_A, anyAsset, okResult(SOURCE_A)),
        capability: capFor("vendor-a"),
      },
    ]);
    expect(router.supports(REQ())).toBe(true);
    expect(router.supports(REQ({ asset: { symbol: "ZZZ" } }))).toBe(false); // vendor rejects
    expect(
      router.supports(REQ({ asset: { symbol: "NIFTY 50", marketId: "indian-markets" } })),
    ).toBe(false); // market uncovered — never reaches vendor
  });

  it("uncovered market → unsupported_symbol without calling the vendor", async () => {
    let called = 0;
    const counting: HistoricalDataProvider = {
      source: SOURCE_A,
      supports: () => true,
      getCandles: async () => {
        called++;
        return okResult(SOURCE_A);
      },
    };
    const router = new ProviderRouter([
      { provider: counting, capability: capFor("vendor-a") },
    ]);
    const res = await router.getCandles(
      REQ({ asset: { symbol: "NIFTY 50", assetClass: "indices", marketId: "indian-markets" } }),
    );
    expect(called).toBe(0);
    expect(res).toMatchObject({ ok: false, error: { code: "unsupported_symbol" } });
  });

  it("entitled-timeframe miss → unsupported_timeframe, disclosed as inferred", async () => {
    const router = new ProviderRouter([
      {
        provider: new FakeVendor(SOURCE_A, anyAsset, okResult(SOURCE_A)),
        capability: capFor("vendor-a", {
          entitledTimeframes: ["1D", "1W", "1M"],
          confidence: "inferred",
        }),
      },
    ]);
    const res = await router.getCandles(REQ({ timeframe: "4h" }));
    expect(res).toMatchObject({ ok: false, error: { code: "unsupported_timeframe" } });
    if (!res.ok) {
      expect(res.error.message).toContain("4h");
      expect(res.error.message).toMatch(/inferred/i); // unverified entitlement is disclosed
    }
    expect(router.supports(REQ({ timeframe: "4h" }))).toBe(true); // asset axis unaffected
  });

  it("technical-timeframe miss → unsupported_timeframe distinct from entitlement", async () => {
    const router = new ProviderRouter([
      {
        provider: new FakeVendor(SOURCE_A, anyAsset, okResult(SOURCE_A)),
        capability: capFor("vendor-a", {
          technicalTimeframes: ["1D", "1W", "1M"],
          entitledTimeframes: ["1D", "1W", "1M"],
        }),
      },
    ]);
    const res = await router.getCandles(REQ({ timeframe: "15m" }));
    expect(res).toMatchObject({ ok: false, error: { code: "unsupported_timeframe" } });
    if (!res.ok) expect(res.error.message).toMatch(/interval model/i);
  });

  it("history window before historyLimitDays → data_not_available", async () => {
    const router = new ProviderRouter([
      {
        provider: new FakeVendor(SOURCE_A, anyAsset, okResult(SOURCE_A)),
        capability: capFor("vendor-a", { historyLimitDays: 30 }),
      },
    ]);
    const res = await router.getCandles(
      REQ({ start: Date.UTC(2026, 7, 1), end: Date.UTC(2026, 9, 15) }),
    );
    expect(res).toMatchObject({ ok: false, error: { code: "data_not_available" } });
    // A window inside the limit still reaches the vendor.
    const inside = await router.getCandles(
      REQ({ start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 9, 15) }),
    );
    expect(inside.ok).toBe(true);
  });

  it("vendor-unsupported symbol inside a covered market → unsupported_symbol", async () => {
    const router = new ProviderRouter([
      {
        provider: new FakeVendor(SOURCE_A, () => false, okResult(SOURCE_A)),
        capability: capFor("vendor-a"),
      },
    ]);
    const res = await router.getCandles(REQ());
    expect(res).toMatchObject({ ok: false, error: { code: "unsupported_symbol" } });
  });

  it("provider-reported classification wins; capability is the floor — never an upgrade", async () => {
    const delayed = new ProviderRouter([
      {
        provider: new FakeVendor(SOURCE_A, anyAsset, okResult(SOURCE_A, { classification: "delayed" })),
        capability: capFor("vendor-a", { classification: "historical" }),
      },
    ]);
    const res = await delayed.getCandles(REQ());
    expect(res.ok && res.result.classification).toBe("delayed");

    const floored = new ProviderRouter([
      {
        provider: new FakeVendor(SOURCE_A, anyAsset, okResult(SOURCE_A)), // vendor omits it
        capability: capFor("vendor-a", { classification: "delayed" }),
      },
    ]);
    const res2 = await floored.getCandles(REQ());
    expect(res2.ok && res2.result.classification).toBe("delayed"); // declared floor applies
  });

  it("provider failures pass through verbatim — routing never fabricates", async () => {
    const router = new ProviderRouter([
      {
        provider: new FakeVendor(
          SOURCE_A,
          anyAsset,
          providerError("rate_limited", "vendor 429"),
        ),
        capability: capFor("vendor-a"),
      },
    ]);
    const res = await router.getCandles(REQ());
    expect(res).toMatchObject({ ok: false, error: { code: "rate_limited" } });
  });

  it("public scope + unknown rights → display_not_authorized before any vendor traffic", async () => {
    let called = 0;
    const counting: HistoricalDataProvider = {
      source: SOURCE_A,
      supports: () => true,
      getCandles: async () => {
        called++;
        return okResult(SOURCE_A);
      },
    };
    const router = new ProviderRouter(
      [{ provider: counting, capability: capFor("vendor-a", { displayRights: "unknown" }) }],
      "public",
    );
    const res = await router.getCandles(REQ());
    expect(called).toBe(0); // blocked at the router — no traffic, no data
    expect(res).toMatchObject({ ok: false, error: { code: "display_not_authorized" } });
  });

  it("public scope + not_authorized → same fail-closed code", async () => {
    const router = new ProviderRouter(
      [
        {
          provider: new FakeVendor(SOURCE_A, anyAsset, okResult(SOURCE_A)),
          capability: capFor("vendor-a", { displayRights: "not_authorized" }),
        },
      ],
      "public",
    );
    expect((await router.getCandles(REQ())).ok).toBe(false);
  });

  it("public scope + authorized → serves; internal scope never blocks on rights", async () => {
    const authorized = new ProviderRouter(
      [
        {
          provider: new FakeVendor(SOURCE_A, anyAsset, okResult(SOURCE_A)),
          capability: capFor("vendor-a", { displayRights: "authorized" }),
        },
      ],
      "public",
    );
    expect((await authorized.getCandles(REQ())).ok).toBe(true);

    const internal = new ProviderRouter(
      [
        {
          provider: new FakeVendor(SOURCE_A, anyAsset, okResult(SOURCE_A)),
          capability: capFor("vendor-a", { displayRights: "not_authorized" }),
        },
      ],
      "internal",
    );
    expect((await internal.getCandles(REQ())).ok).toBe(true); // dev/test reads unaffected
  });

  it("rights gate precedes timeframe errors — licensing is the primary fact", async () => {
    const router = new ProviderRouter(
      [
        {
          provider: new FakeVendor(SOURCE_A, anyAsset, okResult(SOURCE_A)),
          capability: capFor("vendor-a", {
            displayRights: "unknown",
            entitledTimeframes: ["1D"],
          }),
        },
      ],
      "public",
    );
    const res = await router.getCandles(REQ({ timeframe: "4h" }));
    expect(res).toMatchObject({ ok: false, error: { code: "display_not_authorized" } });
  });

  it("multi-provider routing picks the covering vendor and reports its source", async () => {
    const router = new ProviderRouter([
      {
        provider: new FakeVendor(SOURCE_A, anyAsset, okResult(SOURCE_A)),
        capability: capFor("vendor-a"),
      },
      {
        provider: new FakeVendor(SOURCE_B, anyAsset, okResult(SOURCE_B)),
        capability: capFor("vendor-b", { markets: ["indian-markets"] }),
      },
    ]);
    const india = await router.getCandles(
      REQ({ asset: { symbol: "NIFTY 50", assetClass: "indices", marketId: "indian-markets" } }),
    );
    expect(india.ok && india.result.source.id).toBe("vendor-b");
    expect(router.source.id).toBe("vendor-a"); // primary label for the composite
  });
});
