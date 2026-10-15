/**
 * PolygonProvider adapter tests — canned HTTP responses only, never the real API.
 * Covers the contract (supports/getCandles), request construction (incl. the mandatory
 * `adjusted=false` backtest-integrity flag and the exclusive-`end` translation),
 * normalization through the existing pipeline, pagination, and error-code mapping.
 */
import { describe, expect, it } from "vitest";
import type { AssetIdentifier, MarketDataRequest } from "@/lib/types";
import { PolygonProvider, polygonTickerFor } from "../providers/polygon";

const KEY = "test-secret-key";
const BASE = "https://api.polygon.io";
const EPOCH = Date.UTC(2024, 0, 1); // Mon 2024-01-01
const H1 = 3_600_000;

const asset = (over: Partial<AssetIdentifier> = {}): AssetIdentifier => ({
  symbol: "BTCUSDT",
  assetClass: "crypto",
  marketId: "crypto",
  ...over,
});

const req = (over: Partial<MarketDataRequest> = {}): MarketDataRequest => ({
  asset: asset(),
  timeframe: "1h",
  start: EPOCH,
  end: EPOCH + 24 * H1,
  ...over,
});

const row = (t: number, close = 100) => ({ t, o: close - 1, h: close + 1, l: close - 2, c: close, v: 10, vw: close, n: 5 });

function fetchWith(responses: (Response | (() => Promise<Response>) | Error)[]) {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const next = responses.length > 1 ? responses.shift()! : responses[0];
    if (next instanceof Error) throw next;
    return next instanceof Response ? next : next();
  }) as typeof fetch;
  return { fetchImpl, urls };
}

const okJson = (body: unknown) =>
  Response.json(body, { status: 200 });

function provider(fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof PolygonProvider>[0]> = {}) {
  return new PolygonProvider({ apiKey: KEY, fetchImpl, sleep: () => Promise.resolve(), ...over });
}

// ---------------------------------------------------------------------------

describe("supports / symbol mapping", () => {
  it("serves catalog symbols across asset classes", () => {
    const p = provider(fetchWith([]).fetchImpl);
    expect(p.supports(req())).toBe(true);
    expect(p.supports(req({ asset: asset({ symbol: "AAPL", assetClass: "equities", marketId: "us-stocks" }) }))).toBe(true);
    expect(p.supports(req({ asset: asset({ symbol: "EURUSD", assetClass: "forex", marketId: "forex" }) }))).toBe(true);
    expect(p.supports(req({ asset: asset({ symbol: "XAUUSD", assetClass: "commodities", marketId: "commodities" }) }))).toBe(true);
    expect(p.supports(req({ asset: asset({ symbol: "NAS100", assetClass: "indices", marketId: "indices" }) }))).toBe(true);
  });

  it("NSE / indian-markets → unsupported, never fabricated", async () => {
    const p = provider(fetchWith([]).fetchImpl);
    const nifty = asset({ symbol: "NIFTY 50", assetClass: "indices", marketId: "indian-markets" });
    expect(p.supports(req({ asset: nifty }))).toBe(false);
    const res = await p.getCandles(req({ asset: nifty }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unsupported_symbol");
  });

  it("ticker mapping is explicit — no guessing", () => {
    expect(polygonTickerFor(asset({ symbol: "BTCUSDT" }))).toBe("X:BTCUSD"); // USDT→USD quote normalization, documented
    expect(polygonTickerFor(asset({ symbol: "ETHUSDT" }))).toBe("X:ETHUSD");
    expect(polygonTickerFor(asset({ symbol: "EURUSD", assetClass: "forex" }))).toBe("C:EURUSD");
    expect(polygonTickerFor(asset({ symbol: "XAUUSD", assetClass: "commodities" }))).toBe("C:XAUUSD");
    expect(polygonTickerFor(asset({ symbol: "NAS100", assetClass: "indices" }))).toBe("I:NDX");
    expect(polygonTickerFor(asset({ symbol: "AAPL", assetClass: "equities" }))).toBe("AAPL");
    expect(polygonTickerFor(asset({ symbol: "RELIANCE", assetClass: "equities", marketId: "indian-markets" }))).toBeUndefined();
    expect(polygonTickerFor(asset({ assetClass: undefined }))).toBeUndefined();
    expect(polygonTickerFor(asset({ symbol: "UNKNOWNIDX", assetClass: "indices" }))).toBeUndefined();
  });
});

describe("timeframe mapping", () => {
  it("maps every canonical timeframe to multiplier/timespan", async () => {
    const { fetchImpl, urls } = fetchWith([okJson({ status: "OK", results: [] })]);
    const p = provider(fetchImpl);
    const cases: [MarketDataRequest["timeframe"], string][] = [
      ["1m", "/range/1/minute/"], ["5m", "/range/5/minute/"], ["15m", "/range/15/minute/"],
      ["1h", "/range/1/hour/"], ["4h", "/range/4/hour/"], ["1D", "/range/1/day/"],
      ["1W", "/range/1/week/"], ["1M", "/range/1/month/"],
    ];
    for (const [tf, frag] of cases) {
      await p.getCandles(req({ timeframe: tf }));
      expect(urls.at(-1)).toContain(frag);
    }
    expect(p.supports(req({ timeframe: "4h" }))).toBe(true);
  });
});

describe("request construction", () => {
  it("builds the aggregates URL with adjusted=false, sort=asc, limit, exclusive end", async () => {
    const { fetchImpl, urls } = fetchWith([okJson({ status: "OK", results: [] })]);
    const p = provider(fetchImpl);
    await p.getCandles(req());
    const url = urls[0];
    expect(url).toContain(`${BASE}/v2/aggs/ticker/X%3ABTCUSD/range/1/hour/${EPOCH}/${EPOCH + 24 * H1 - 1}`); // colon percent-encoded
    expect(url).toContain("adjusted=false"); // backtest integrity — explicit, never the default
    expect(url).toContain("sort=asc");
    expect(url).toContain("limit=50000");
    expect(url).toContain(`apiKey=${KEY}`);
  });

  it("honors a custom pageSize for limit", async () => {
    const { fetchImpl, urls } = fetchWith([okJson({ status: "OK", results: [] })]);
    await provider(fetchImpl, { pageSize: 100 }).getCandles(req());
    expect(urls[0]).toContain("limit=100");
  });
});

describe("response normalization", () => {
  it("maps OHLCV rows to ascending bar-open-ms candles", async () => {
    const body = okJson({ status: "OK", results: [row(EPOCH, 101), row(EPOCH + H1, 102)] });
    const res = await provider(fetchWith([body]).fetchImpl).getCandles(req());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.candles).toHaveLength(2);
    expect(res.result.candles[0]).toMatchObject({ time: EPOCH, open: 100, high: 102, low: 99, close: 101, volume: 10, tradeCount: 5 });
    expect(res.result.candles[1].time).toBe(EPOCH + H1);
    expect(res.result.source.id).toBe("polygon");
    expect(res.result.quality.barCount).toBe(2);
  });

  it("missing intervals stay missing — gaps are data, not fabricated bars", async () => {
    const body = okJson({ status: "OK", results: [row(EPOCH), row(EPOCH + 5 * H1)] }); // 4-bar hole
    const res = await provider(fetchWith([body]).fetchImpl).getCandles(req());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.candles.map((c) => c.time)).toEqual([EPOCH, EPOCH + 5 * H1]);
    expect(res.result.quality.missingBarCount).toBe(4);
  });

  it("rejects rows outside [start, end) even if the vendor returns them", async () => {
    const body = okJson({ status: "OK", results: [row(EPOCH - H1), row(EPOCH), row(EPOCH + 24 * H1)] });
    const res = await provider(fetchWith([body]).fetchImpl).getCandles(req());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.candles.map((c) => c.time)).toEqual([EPOCH]); // only in-window bar
  });
});

describe("pagination", () => {
  it("follows next_url, appends apiKey, dedupes the page boundary", async () => {
    const page1 = okJson({
      status: "OK",
      results: [row(EPOCH), row(EPOCH + H1)],
      next_url: `${BASE}/v2/aggs/ticker/X:BTCUSD/range/1/hour/${EPOCH}/${EPOCH + 24 * H1 - 1}?cursor=abc`,
    });
    const page2 = okJson({ status: "OK", results: [row(EPOCH + H1), row(EPOCH + 2 * H1)] }); // overlap at boundary
    const { fetchImpl, urls } = fetchWith([page1, page2]);
    const res = await provider(fetchImpl).getCandles(req());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("cursor=abc");
    expect(urls[1]).toContain(`apiKey=${KEY}`); // Polygon omits the key on next_url
    expect(res.result.candles.map((c) => c.time)).toEqual([EPOCH, EPOCH + H1, EPOCH + 2 * H1]);
  });

  it("single page with no next_url stops; empty results yield an honest empty set", async () => {
    const { fetchImpl, urls } = fetchWith([okJson({ status: "OK", results: [row(EPOCH)] })]);
    const res = await provider(fetchImpl).getCandles(req());
    expect(urls).toHaveLength(1);
    expect(res.ok && res.result.candles).toHaveLength(1);

    const empty = await provider(fetchWith([okJson({ status: "OK", results: [] })]).fetchImpl).getCandles(req());
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.result.candles).toEqual([]);
  });

  it("never paginates forever — exceeding the page bound yields incomplete_data", async () => {
    // An infinite next_url loop: every page claims another page exists.
    // Factory (not a shared Response) — each page needs an unconsumed body.
    const endless = () =>
      Promise.resolve(
        Response.json(
          {
            status: "OK",
            results: [row(EPOCH)],
            next_url: `${BASE}/v2/aggs/ticker/X%3ABTCUSD/range/1/hour/0/1?cursor=loop`,
          },
          { status: 200 },
        ),
      );
    const { fetchImpl, urls } = fetchWith([endless]);
    const res = await provider(fetchImpl).getCandles(req({ end: EPOCH + 40 * 24 * H1 })); // long range so pages keep coming
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("incomplete_data");
    expect(urls.length).toBe(40); // hard bound, not silent truncation
  });

  it("stops paging when results reach the exclusive end", async () => {
    const body = okJson({
      status: "OK",
      results: [row(EPOCH), row(EPOCH + 24 * H1)], // bar at end — out of [start,end), ends the walk
      next_url: `${BASE}/x?cursor=zzz`,
    });
    const { fetchImpl, urls } = fetchWith([body]);
    const res = await provider(fetchImpl).getCandles(req());
    expect(urls).toHaveLength(1); // no second page fetched
    expect(res.ok && res.result.candles.map((c) => c.time)).toEqual([EPOCH]);
  });
});

describe("error mapping", () => {
  const caseOf = async (status: number, body?: unknown) => {
    const res = await provider(fetchWith([Response.json(body ?? {}, { status })]).fetchImpl).getCandles(req());
    return res;
  };

  it("401/403 → provider_error", async () => {
    for (const status of [401, 403]) {
      const res = await caseOf(status);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("provider_error");
    }
  });

  it("404 → unsupported_symbol", async () => {
    const res = await caseOf(404);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unsupported_symbol");
  });

  it("429 → one retry then rate_limited; 429→200 recovers", async () => {
    const limited = await provider(
      fetchWith([Response.json({}, { status: 429 }), Response.json({}, { status: 429 })]).fetchImpl,
    ).getCandles(req());
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.error.code).toBe("rate_limited");

    const recovered = await provider(
      fetchWith([Response.json({}, { status: 429 }), okJson({ status: "OK", results: [row(EPOCH)] })]).fetchImpl,
    ).getCandles(req());
    expect(recovered.ok).toBe(true);
  });

  it("5xx retries once then provider_error; 4xx other → provider_error", async () => {
    const down = await provider(
      fetchWith([Response.json({}, { status: 503 }), Response.json({}, { status: 503 })]).fetchImpl,
    ).getCandles(req());
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.error.code).toBe("provider_error");

    const bad = await caseOf(400);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("provider_error");
  });

  it("network failure retries once then provider_error", async () => {
    const res = await provider(
      fetchWith([new Error("socket"), new Error("socket")]).fetchImpl,
    ).getCandles(req());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("provider_error");
  });

  it("malformed JSON → invalid_data; NOT_FOUND status → unsupported_symbol", async () => {
    const malformed = await provider(
      fetchWith([new Response("not-json{", { status: 200 })]).fetchImpl,
    ).getCandles(req());
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("invalid_data");

    const nf = await caseOf(200, { status: "NOT_FOUND", error: "Ticker not found" });
    expect(nf.ok).toBe(false);
    if (!nf.ok) expect(nf.error.code).toBe("unsupported_symbol");
  });

  it("invalid request bounds → invalid_request without a network call", async () => {
    const { fetchImpl, urls } = fetchWith([]);
    const res = await provider(fetchImpl).getCandles(req({ start: EPOCH + H1, end: EPOCH }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_request");
    expect(urls).toHaveLength(0);
  });
});
