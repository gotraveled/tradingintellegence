import { describe, expect, it, vi } from "vitest";
import { fetchCryptoKlines, fetchCryptoQuotes } from "../binance/client";
import {
  binanceInterval,
  binanceStreamUrl,
  CRYPTO_SYMBOLS,
  isCryptoSymbol,
} from "../binance/constants";
import {
  normalizeKlineRow,
  normalizeKlines,
  normalizeStreamKline,
  normalizeTicker,
  parseStreamMessage,
} from "../binance/normalize";
import { BinanceStream, type SocketLike } from "../binance/stream";
import type { FeedStatus } from "../types";

// ---------- allowlists & constants ----------

describe("allowlists", () => {
  it("accepts only verified Binance Spot symbols", () => {
    expect(isCryptoSymbol("BTCUSDT")).toBe(true);
    expect(isCryptoSymbol("DOGEUSDT")).toBe(true);
    expect(isCryptoSymbol("btcusdt")).toBe(false); // case-sensitive wire format
    expect(isCryptoSymbol("BTCUSD")).toBe(false);
    expect(isCryptoSymbol("SHIBUSDT")).toBe(false);
    expect(isCryptoSymbol("")).toBe(false);
  });

  it("maps only supported canonical timeframes to Binance intervals", () => {
    expect(binanceInterval("1m")).toBe("1m");
    expect(binanceInterval("1h")).toBe("1h");
    expect(binanceInterval("4h")).toBe("4h");
    expect(binanceInterval("1D")).toBe("1d");
    expect(binanceInterval("2h")).toBeUndefined();
    expect(binanceInterval("1W")).toBeUndefined();
    expect(binanceInterval("1M")).toBeUndefined();
  });

  it("builds lowercase combined-stream URLs", () => {
    expect(binanceStreamUrl(["BTCUSDT@ticker", "ETHUSDT@kline_1h"])).toBe(
      "wss://stream.binance.com:9443/stream?streams=btcusdt@ticker/ethusdt@kline_1h",
    );
  });
});

// ---------- normalization ----------

const KLINE_ROW = [
  1792382400000, "82530.81", "82882.00", "82484.27", "82783.54", "407.52",
  1792385999999, "33680148.18", 59253, "266.34", "22011500.02", "0",
];

describe("normalizeKlineRow", () => {
  it("maps the documented 12-field kline array to a Candle (ms open time)", () => {
    const warnings: string[] = [];
    const c = normalizeKlineRow(KLINE_ROW, "BTCUSDT", "1h", warnings);
    expect(c).toMatchObject({
      time: 1792382400000,
      open: 82530.81,
      high: 82882.0,
      low: 82484.27,
      close: 82783.54,
      volume: 407.52,
      tradeCount: 59253,
      exchange: "BINANCE",
      assetClass: "crypto",
    });
    expect(warnings).toHaveLength(0);
  });

  it("rejects non-array and non-numeric rows with reasons", () => {
    const warnings: string[] = [];
    expect(normalizeKlineRow("nope", "BTCUSDT", "1h", warnings)).toBeUndefined();
    expect(normalizeKlineRow([1, "a", 3, 4, 5, 6, 7, 8, 9, 10, 11], "BTCUSDT", "1h", warnings)).toBeUndefined();
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects impossible OHLC relationships", () => {
    const warnings: string[] = [];
    const bad = [...KLINE_ROW];
    bad[2] = "1"; // high below open/close
    expect(normalizeKlineRow(bad, "BTCUSDT", "1h", warnings)).toBeUndefined();
    expect(warnings[0]).toContain("impossible OHLC");
  });
});

describe("normalizeKlines", () => {
  it("fails closed on non-array payloads", () => {
    const res = normalizeKlines({ not: "array" }, "BTCUSDT", "1h");
    expect(res).toHaveProperty("error");
  });

  it("returns empty set honestly for an empty provider response", () => {
    const res = normalizeKlines([], "BTCUSDT", "1h");
    expect("error" in res).toBe(false);
    if (!("error" in res)) expect(res.candles).toHaveLength(0);
  });

  it("sorts out-of-order rows, dedups, and flags the forming bar", () => {
    const row2 = [...KLINE_ROW];
    row2[0] = 1792386000000;
    row2[6] = 1792389599999;
    const now = 1792386000000 + 60_000; // second bar still forming
    const res = normalizeKlines([row2, KLINE_ROW, KLINE_ROW], "BTCUSDT", "1h", now);
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.candles.map((c) => c.time)).toEqual([1792382400000, 1792386000000]);
    expect(res.hasFormingCandle).toBe(true);
  });
});

describe("normalizeTicker", () => {
  it("normalizes REST 24hrTicker shape", () => {
    const q = normalizeTicker(
      {
        symbol: "BTCUSDT",
        lastPrice: "82825.22",
        openPrice: "81705.57",
        priceChangePercent: "1.37",
        priceChange: "1119.65",
        highPrice: "83000",
        lowPrice: "81000",
        quoteVolume: "12345678.9",
        closeTime: 1792390889016,
      },
      "BTCUSDT",
    );
    expect(q).toMatchObject({
      symbol: "BTCUSDT",
      venue: "Binance Spot",
      last: 82825.22,
      changePct24h: 1.37,
      eventTime: 1792390889016,
    });
  });

  it("normalizes stream @ticker shape (c/o/P keys)", () => {
    const q = normalizeTicker(
      { s: "ETHUSDT", c: "2150.5", o: "2100", P: "2.404", p: "50.5", h: "2200", l: "2080", q: "999", E: 1792390891016 },
      "ETHUSDT",
    );
    expect(q?.last).toBe(2150.5);
    expect(q?.changePct24h).toBe(2.404);
    expect(q?.eventTime).toBe(1792390891016);
  });

  it("rejects payloads without usable price fields", () => {
    expect(normalizeTicker({ garbage: true }, "BTCUSDT")).toBeUndefined();
    expect(normalizeTicker(null, "BTCUSDT")).toBeUndefined();
  });
});

describe("parseStreamMessage / normalizeStreamKline", () => {
  it("parses combined-stream envelopes and rejects malformed frames", () => {
    expect(parseStreamMessage('{"stream":"btcusdt@ticker","data":{"c":"1","o":"1","E":5}}')).toMatchObject({
      stream: "btcusdt@ticker",
    });
    expect(parseStreamMessage("not json")).toBeUndefined();
    expect(parseStreamMessage('{"data":{}}')).toBeUndefined();
  });

  it("normalizes kline stream payloads and honours the provider closed flag", () => {
    const res = normalizeStreamKline({
      k: {
        s: "BTCUSDT",
        t: 1792382400000,
        T: 1792385999999,
        o: "82530.81",
        h: "82882",
        l: "82484.27",
        c: "82783.54",
        v: "407.52",
        n: 59253,
        x: false,
      },
    });
    expect(res?.isClosed).toBe(false);
    expect(res?.candle.time).toBe(1792382400000);
    expect(res?.candle.close).toBe(82783.54);
    expect(normalizeStreamKline({ k: null })).toBeUndefined();
  });
});

// ---------- REST client ----------

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("fetchCryptoQuotes", () => {
  it("rejects non-allowlisted symbol sets before any request", async () => {
    const res = await fetchCryptoQuotes(["SHIBUSDT"], { fetchImpl: fakeFetch(200, []) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unsupported_symbol");
  });

  it("returns normalized venue-attributed quotes", async () => {
    const res = await fetchCryptoQuotes(["BTCUSDT"], {
      fetchImpl: fakeFetch(200, [
        { symbol: "BTCUSDT", lastPrice: "82825.22", openPrice: "81705.57", priceChangePercent: "1.37", quoteVolume: "10", closeTime: 1792390889016 },
      ]),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0].venue).toBe("Binance Spot");
      expect(res.data[0].last).toBe(82825.22);
    }
  });

  it("maps HTTP 429 to rate_limited without retry storm", async () => {
    const fn = fakeFetch(429, {});
    const res = await fetchCryptoQuotes(["BTCUSDT"], { fetchImpl: fn, hosts: ["https://x.test"] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("rate_limited");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("maps malformed JSON bodies to invalid_data", async () => {
    const res = await fetchCryptoQuotes(["BTCUSDT"], {
      fetchImpl: fakeFetch(200, { not: "an array" }),
      hosts: ["https://x.test"],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_data");
  });

  it("fails over to the next host on transport error", async () => {
    const fn = vi.fn(async (url: string) => {
      if (url.includes("dead.test")) throw new TypeError("fetch failed");
      return new Response(
        JSON.stringify([{ symbol: "BTCUSDT", lastPrice: "1", openPrice: "1", closeTime: 1 }]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const res = await fetchCryptoQuotes(["BTCUSDT"], {
      fetchImpl: fn,
      hosts: ["https://dead.test", "https://live.test"],
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(true);
  });
});

describe("fetchCryptoKlines", () => {
  it("rejects unlisted symbols and unsupported timeframes", async () => {
    const a = await fetchCryptoKlines("PEPEUSDT", "1h");
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error.code).toBe("unsupported_symbol");
    const b = await fetchCryptoKlines("BTCUSDT", "2h");
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.code).toBe("unsupported_timeframe");
  });

  it("normalizes a real-shaped klines payload", async () => {
    const res = await fetchCryptoKlines("BTCUSDT", "1h", 50, {
      fetchImpl: fakeFetch(200, [KLINE_ROW]),
      hosts: ["https://x.test"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.candles).toHaveLength(1);
      expect(res.data.candles[0].close).toBe(82783.54);
      expect(res.data.symbol).toBe("BTCUSDT");
    }
  });

  it("bounds the limit parameter", async () => {
    let url = "";
    const fn = vi.fn(async (u: string) => {
      url = u;
      return new Response(JSON.stringify([KLINE_ROW]), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchCryptoKlines("BTCUSDT", "1h", 99999, { fetchImpl: fn, hosts: ["https://x.test"] });
    expect(url).toContain("limit=500");
  });
});

// ---------- WebSocket stream ----------

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(stream: string, data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ stream, data }) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

function makeHarness(nowRef: { t: number }, onlineRef: { online: boolean }) {
  const sockets: FakeSocket[] = [];
  const statuses: FeedStatus[] = [];
  const messages: unknown[] = [];
  const stream = new BinanceStream({
    streams: ["BTCUSDT@ticker"],
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
    wsFactory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    now: () => nowRef.t,
    isOnline: () => onlineRef.online,
    staleAfterMs: 1_000,
    watchdogMs: 10,
    backoffBaseMs: 100,
    backoffMaxMs: 400,
    maxReconnectAttempts: 3,
  });
  return { sockets, statuses, messages, stream };
}

function tick(n: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, n));
}

describe("BinanceStream", () => {
  it("reports connecting → live only after a real received message", async () => {
    const now = { t: 1_000 };
    const online = { online: true };
    const h = makeHarness(now, online);
    h.stream.start();
    expect(h.statuses).toEqual(["connecting"]);
    h.sockets[0].open();
    expect(h.statuses).toEqual(["connecting"]); // open socket, silent → still connecting
    h.sockets[0].emit("btcusdt@ticker", { c: "1", o: "1", E: 2_000 });
    expect(h.statuses).toEqual(["connecting", "live"]);
    expect(h.messages).toHaveLength(1);
    h.stream.close();
  });

  it("transitions to stale when the open socket goes silent", async () => {
    const now = { t: 1_000 };
    const online = { online: true };
    const h = makeHarness(now, online);
    h.stream.start();
    h.sockets[0].open();
    h.sockets[0].emit("btcusdt@ticker", { c: "1", o: "1", E: now.t });
    now.t += 60_000; // silence beyond staleAfterMs
    await tick(50); // watchdog interval = 10ms in tests
    expect(h.statuses).toContain("stale");
    // Recovery: a real message returns the feed to live.
    h.sockets[0].emit("btcusdt@ticker", { c: "2", o: "1", E: now.t });
    expect(h.statuses[h.statuses.length - 1]).toBe("live");
    h.stream.close();
  });

  it("reconnects with bounded backoff and stops after max attempts", async () => {
    const now = { t: 1_000 };
    const online = { online: true };
    const h = makeHarness(now, online);
    h.stream.start();
    h.sockets[0].open();
    h.sockets[0].drop();
    expect(h.statuses).toContain("reconnecting");
    await tick(150); // 100ms delay
    expect(h.sockets.length).toBe(2);
    h.sockets[1].drop();
    await tick(250); // 200ms delay
    expect(h.sockets.length).toBe(3);
    h.sockets[2].drop();
    await tick(450); // 400ms cap delay
    expect(h.sockets.length).toBe(4);
    h.sockets[3].drop();
    await tick(600);
    // attempts exhausted (max 3 retries) → offline, no more sockets
    expect(h.sockets.length).toBe(4);
    expect(h.statuses[h.statuses.length - 1]).toBe("offline");
  });

  it("goes offline when the browser reports offline and reconnects on online", async () => {
    const now = { t: 1_000 };
    const online = { online: true };
    let fireOnline: ((o: boolean) => void) | undefined;
    const sockets: FakeSocket[] = [];
    const statuses: FeedStatus[] = [];
    const stream = new BinanceStream({
      streams: ["BTCUSDT@ticker"],
      onMessage: () => {},
      onStatus: (s) => statuses.push(s),
      wsFactory: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      now: () => now.t,
      isOnline: () => online.online,
      onOnlineChange: (h) => {
        fireOnline = h;
        return () => {};
      },
    });
    stream.start();
    sockets[0].open();
    online.online = false;
    fireOnline?.(false);
    expect(statuses[statuses.length - 1]).toBe("offline");
    online.online = true;
    fireOnline?.(true);
    expect(sockets.length).toBe(2);
    stream.close();
  });

  it("close() tears down socket, timers, and stops all activity", async () => {
    const now = { t: 1_000 };
    const online = { online: true };
    const h = makeHarness(now, online);
    h.stream.start();
    const sock = h.sockets[0];
    h.stream.close();
    expect(sock.closed).toBe(true);
    expect(h.stream.currentStatus).toBe("offline");
    // A close event racing teardown must not reconnect.
    sock.drop();
    await tick(300);
    expect(h.sockets.length).toBe(1);
  });

  it("ignores malformed frames instead of fabricating data", () => {
    const now = { t: 1_000 };
    const online = { online: true };
    const h = makeHarness(now, online);
    h.stream.start();
    h.sockets[0].open();
    h.sockets[0].onmessage?.({ data: "<<<not json>>>" });
    h.sockets[0].onmessage?.({ data: '{"stream":"x@ticker"}' }); // missing data
    expect(h.messages).toHaveLength(0);
    expect(h.stream.currentStatus).toBe("connecting"); // malformed ≠ live
    h.stream.close();
  });
});

// ---------- constants sanity ----------

describe("constants", () => {
  it("ships exactly the exchange-info-verified symbol set", () => {
    expect(CRYPTO_SYMBOLS.map((s) => s.symbol)).toEqual([
      "BTCUSDT",
      "ETHUSDT",
      "SOLUSDT",
      "BNBUSDT",
      "XRPUSDT",
      "ADAUSDT",
      "DOGEUSDT",
      "LINKUSDT",
      "AVAXUSDT",
      "DOTUSDT",
      "LTCUSDT",
      "TRXUSDT",
    ]);
  });
});
