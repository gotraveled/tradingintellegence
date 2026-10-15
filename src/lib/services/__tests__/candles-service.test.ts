/**
 * POST /api/candles contract tests — validation, window math, identity resolution,
 * empty-vs-failure semantics, and HTTP/error mapping. Provider "requests" are an
 * injected fake — no real vendor traffic, no fabricated candles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerError } from "@/lib/market-data/provider";
import type { HistoricalDataProvider, ProviderResponse } from "@/lib/market-data/provider";
import {
  clearProviderConnectivity,
  MARKET_DATA_KEY_ENV,
  setConfiguredProvider,
} from "@/lib/market-data/providers";
import { TIMEFRAME_MS } from "@/lib/market-data/timeframes";
import { ServiceUnavailableError } from "@/lib/services/types";
import type {
  CandlesRequest,
  MarketDataErrorCode,
  MarketDataRequest,
  MarketDataSource,
} from "@/lib/types";
import {
  CANDLES_MAX_BARS,
  CANDLES_MAX_RANGE_DAYS,
  candleWindow,
  executeCandles,
  lookbackStart,
  resolveAsset,
} from "../candles-service";
import { fetchCandles, CandlesClientError } from "../candles-runner";
import { POST } from "@/app/api/candles/route";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0); // fixed clock — window math is deterministic

const SOURCE: MarketDataSource = { id: "fake", kind: "rest", label: "Fake Provider" };

const QUALITY = {
  symbol: "AAA",
  timeframe: "4h" as const,
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
  lastRequest: MarketDataRequest | undefined;
  constructor(
    private readonly response: ProviderResponse,
    private readonly supported = true,
  ) {}
  supports(): boolean {
    return this.supported;
  }
  async getCandles(request: MarketDataRequest): Promise<ProviderResponse> {
    this.lastRequest = request;
    return this.response;
  }
}

const okWith = (candles: { time: number; open: number; high: number; low: number; close: number }[]): ProviderResponse => ({
  ok: true,
  result: {
    candles: candles.map((c) => ({ ...c })),
    quality: { ...QUALITY, barCount: candles.length },
    source: SOURCE,
    warnings: ["ticker:X:BTCUSD"],
  },
});

const emptyOk: ProviderResponse = {
  ok: true,
  result: { candles: [], quality: QUALITY, source: SOURCE, warnings: [] },
};

const post = (body: unknown): Promise<Response> =>
  POST(new Request("http://localhost/api/candles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

describe("validation", () => {
  const provider = new FakeProvider(emptyOk);

  it("rejects missing/empty symbol, non-canonical timeframe, bad ISO, bar bounds", async () => {
    for (const bad of [
      { timeframe: "4h" },
      { symbol: "  ", timeframe: "4h" },
      { symbol: "X".repeat(65), timeframe: "4h" },
      { symbol: "AAA", timeframe: "7m" },
      { symbol: "AAA", timeframe: "4h", from: "not-a-date" },
      { symbol: "AAA", timeframe: "4h", to: "nope" },
      { symbol: "AAA", timeframe: "4h", bars: 0 },
      { symbol: "AAA", timeframe: "4h", bars: 1.5 },
      { symbol: "AAA", timeframe: "4h", bars: CANDLES_MAX_BARS + 1 },
      { symbol: "AAA", timeframe: "4h", from: "2026-01-01T00:00:00Z", bars: 10 }, // mutually exclusive
    ]) {
      await expect(executeCandles(bad as CandlesRequest, { provider, nowMs: NOW })).rejects.toMatchObject({
        name: "CandlesError",
        code: "invalid_request",
      });
    }
  });

  it("rejects inverted and oversized windows", async () => {
    await expect(
      executeCandles(
        { symbol: "AAA", timeframe: "4h", from: "2026-10-15T00:00:00Z", to: "2026-10-14T00:00:00Z" },
        { provider, nowMs: NOW },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      executeCandles(
        {
          symbol: "AAA",
          timeframe: "1D",
          from: new Date(NOW - (CANDLES_MAX_RANGE_DAYS + 10) * DAY_MS).toISOString(),
          to: new Date(NOW).toISOString(),
        },
        { provider, nowMs: NOW },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("window math — fixed and calendar intervals independently", () => {
  it("fixed timeframe: start = end − bars×tfMs, floored to the bar boundary", () => {
    const w = candleWindow({ symbol: "AAA", timeframe: "4h", bars: 100 }, "4h", NOW);
    expect(w.end).toBe(NOW);
    expect(w.start).toBe(NOW - 100 * TIMEFRAME_MS["4h"]);
    expect(w.start % TIMEFRAME_MS["4h"]).toBe(0);
  });

  it("odd 'to' shifts only the end; start floors onto the containing bar", () => {
    const oddEnd = NOW + 37 * 60_000; // 12:37 — mid-bar
    const w = candleWindow({ symbol: "AAA", timeframe: "1h", bars: 10 }, "1h", oddEnd);
    expect(w.end).toBe(oddEnd);
    // Floored to the containing bar open — ≤ one interval earlier than end−10h.
    expect(w.start % TIMEFRAME_MS["1h"]).toBe(0);
    expect(w.start).toBeLessThanOrEqual(oddEnd - 10 * TIMEFRAME_MS["1h"]);
    expect(w.start).toBeGreaterThan(oddEnd - 11 * TIMEFRAME_MS["1h"]);
  });

  it("1W lookback aligns to UTC Monday; 1D to UTC midnight", () => {
    const w1w = candleWindow({ symbol: "AAA", timeframe: "1W", bars: 4 }, "1W", NOW);
    expect(new Date(w1w.start).getUTCDay()).toBe(1); // Monday
    expect(w1w.end - w1w.start).toBeGreaterThanOrEqual(4 * TIMEFRAME_MS["1W"]);
    const w1d = lookbackStart(NOW, "1D", 7);
    expect(w1d).toBe(NOW - 7 * DAY_MS);
  });

  it("1M uses UTC month arithmetic — not a fixed ms guess", () => {
    const w = candleWindow({ symbol: "AAA", timeframe: "1M", bars: 6 }, "1M", NOW);
    const d = new Date(w.start);
    expect(d.getUTCDate()).toBe(1);
    // NOW is Oct 2026 → 6 months back = April 2026.
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(3);
  });

  it("explicit from/to window is floored to the boundary and bounded", () => {
    const from = "2026-10-01T03:17:00Z"; // inside a 4h bar
    const to = "2026-10-14T00:00:00Z";
    const w = candleWindow({ symbol: "AAA", timeframe: "4h", from, to }, "4h", NOW);
    expect(w.end).toBe(Date.parse(to));
    expect(w.start).toBe(Date.parse(from) - (Date.parse(from) % TIMEFRAME_MS["4h"]));
  });
});

describe("identity", () => {
  it("catalog symbols resolve canonical AssetIdentifier metadata", () => {
    const aapl = resolveAsset("AAPL");
    expect(aapl).toMatchObject({ symbol: "AAPL", assetClass: "equities", marketId: "us-stocks", exchange: "NASDAQ" });
    // The service uppercases symbols before resolving; lowercase input here is a
    // pass-through, not a catalog match — resolution is exact.
    const btc = resolveAsset("BTCUSDT");
    expect(btc.assetClass).toBe("crypto");
    expect(resolveAsset("btcusdt").assetClass).toBeUndefined();
  });

  it("unknown symbols pass through bare — no invented classification", () => {
    const ghost = resolveAsset("ZZZUNKNOWN");
    expect(ghost).toEqual({ symbol: "ZZZUNKNOWN" });
    expect(ghost.assetClass).toBeUndefined();
    expect(ghost.marketId).toBeUndefined();
    expect(ghost.exchange).toBeUndefined();
  });
});

describe("executeCandles — empty vs failure semantics", () => {
  it("provider ok with zero candles → valid empty result (not an error)", async () => {
    const provider = new FakeProvider(emptyOk);
    const result = await executeCandles(
      { symbol: "AAPL", timeframe: "4h", bars: 50 },
      { provider, nowMs: NOW },
    );
    expect(result.candles).toEqual([]);
    expect(result.candleCount).toBe(0);
    expect(result.classification).toBe("historical");
    expect(result.quality.barCount).toBe(0);
    expect(result.source.label).toBe("Fake Provider");
    expect(result.retrievedAt).toBe(new Date(NOW).toISOString());
  });

  it("returns provider-verbatim candles + quality, and the served ticker", async () => {
    const candles = [
      { time: 1000, open: 1, high: 2, low: 0.5, close: 1.5 },
      { time: 2000, open: 1.5, high: 3, low: 1.4, close: 2.8 },
    ];
    const provider = new FakeProvider(okWith(candles));
    const result = await executeCandles(
      { symbol: "BTCUSDT", timeframe: "4h", bars: 50 },
      { provider, nowMs: NOW },
    );
    expect(result.candleCount).toBe(2);
    expect(result.candles[1].close).toBe(2.8);
    expect(result.servedTicker).toBe("X:BTCUSD"); // requested symbol ≠ vendor ticker
    expect(result.warnings).toContain("ticker:X:BTCUSD");
    expect(provider.lastRequest?.asset.symbol).toBe("BTCUSDT");
    expect(provider.lastRequest?.end).toBe(NOW);
  });

  it("supports() false → unsupported_symbol — truthful, typed", async () => {
    const provider = new FakeProvider(emptyOk, false);
    await expect(
      executeCandles({ symbol: "NIFTY 50", timeframe: "4h", bars: 10 }, { provider, nowMs: NOW }),
    ).rejects.toMatchObject({ name: "CandlesError", code: "unsupported_symbol" });
    expect(provider.lastRequest).toBeUndefined(); // never fetched
  });

  it("provider failures propagate as their canonical code — never as empty", async () => {
    const cases: [MarketDataErrorCode, string][] = [
      ["provider_error", "Polygon authentication failed (HTTP 401)"],
      ["rate_limited", "Polygon rate limit"],
      ["invalid_data", "malformed payload"],
      ["unsupported_symbol", "not served"],
      ["data_not_available", "no history in range"],
    ];
    for (const [code, message] of cases) {
      const provider = new FakeProvider(providerError(code, message));
      await expect(
        executeCandles({ symbol: "AAPL", timeframe: "4h", bars: 10 }, { provider, nowMs: NOW }),
      ).rejects.toMatchObject({ name: "CandlesError", code });
    }
  });
});

describe("route — HTTP/status mapping and secrecy", () => {
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

  it("malformed JSON → 400; missing symbol/timeframe → 400", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ timeframe: "4h" })).status).toBe(400);
    expect((await post({ symbol: "AAPL" })).status).toBe(400);
    expect((await post({ symbol: "AAPL", timeframe: "4h", bars: 99999 })).status).toBe(400);
  });

  it("no provider configured → 503 with service name", async () => {
    const res = await post({ symbol: "AAPL", timeframe: "4h", bars: 10 });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.service).toBe("Market data provider");
  });

  it("maps error codes: 422 unsupported · 404 no-data · 429 rate limit · 502 provider failure", async () => {
    const matrix: [MarketDataErrorCode, number][] = [
      ["unsupported_symbol", 422],
      ["unsupported_timeframe", 422],
      ["data_not_available", 404],
      ["rate_limited", 429],
      ["provider_error", 502],
      ["invalid_data", 502],
      ["incomplete_data", 502],
    ];
    for (const [code, status] of matrix) {
      setConfiguredProvider(new FakeProvider(providerError(code, "fixture")));
      const res = await post({ symbol: "AAPL", timeframe: "4h", bars: 10 });
      expect(res.status, `code ${code}`).toBe(status);
      const body = await res.json();
      expect(body.error.code).toBe(code);
    }
  });

  it("empty provider window → 200 with zero candles and quality metadata", async () => {
    setConfiguredProvider(new FakeProvider(emptyOk));
    const res = await post({ symbol: "AAPL", timeframe: "4h", bars: 10 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.candleCount).toBe(0);
    expect(body.result.candles).toEqual([]);
    expect(body.result.classification).toBe("historical");
    expect(body.result.quality.status).toBe("valid");
  });

  it("response payloads never contain credentials or provider internals", async () => {
    setConfiguredProvider(new FakeProvider(okWith([{ time: 1, open: 1, high: 1, low: 1, close: 1 }])));
    const res = await post({ symbol: "AAPL", timeframe: "4h", bars: 10 });
    const payload = JSON.stringify(await res.json());
    expect(payload).not.toContain("apiKey");
    expect(payload).not.toContain("baseUrl");
    expect(payload).not.toContain("polygon.io");
  });
});

describe("fetchCandles — client seam", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("forwards AbortSignal and rethrows AbortError without wrapping", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")));
    await expect(
      fetchCandles({ symbol: "AAPL", timeframe: "4h", bars: 10 }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it("503 → ServiceUnavailableError; 422/502 → CandlesClientError with code", async () => {
    const respond = (status: number, body: unknown) =>
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));

    respond(503, { error: { service: "Market data provider", message: "not configured" } });
    await expect(fetchCandles({ symbol: "AAPL", timeframe: "4h" })).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );

    respond(422, { error: { code: "unsupported_symbol", message: "not served" } });
    const err = await fetchCandles({ symbol: "NIFTY 50", timeframe: "4h" }).catch((e) => e);
    expect(err).toBeInstanceOf(CandlesClientError);
    expect(err.code).toBe("unsupported_symbol");
    expect(err.status).toBe(422);
  });

  it("network failure → ServiceUnavailableError; 200 zero-bar result returned (not an error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(fetchCandles({ symbol: "AAPL", timeframe: "4h" })).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );

    const result = { candleCount: 0, candles: [], classification: "historical" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ result }), { status: 200 })),
    );
    const out = await fetchCandles({ symbol: "AAPL", timeframe: "4h" });
    expect(out.candleCount).toBe(0);
  });
});
