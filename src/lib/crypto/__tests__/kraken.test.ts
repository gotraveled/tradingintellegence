import { describe, expect, it, vi } from "vitest";
import { fetchKrakenOhlc, fetchKrakenQuotes } from "../kraken/client";
import {
  isKrakenSymbol,
  krakenIntervalMinutes,
  krakenSymbolInfo,
} from "../kraken/constants";
import {
  normalizeKrakenOhlc,
  normalizeKrakenOhlcRow,
  normalizeKrakenTickers,
  parseKrakenWsMessage,
} from "../kraken/normalize";
import { KrakenStream, type KrakenSocketLike } from "../kraken/stream";
import type { FeedStatus } from "../types";

// ---------- allowlists & constants ----------

describe("kraken allowlists", () => {
  it("accepts only verified Kraken USD spot pairs", () => {
    expect(isKrakenSymbol("XBTUSD")).toBe(true);
    expect(isKrakenSymbol("DOGEUSD")).toBe(true);
    expect(isKrakenSymbol("BTCUSDT")).toBe(false); // Binance format, not Kraken
    expect(isKrakenSymbol("BNBUSD")).toBe(false); // Kraken lists no BNB/USD
    expect(isKrakenSymbol("")).toBe(false);
  });

  it("maps canonical timeframes to Kraken interval minutes", () => {
    expect(krakenIntervalMinutes("5m")).toBe(5);
    expect(krakenIntervalMinutes("30m")).toBe(30);
    expect(krakenIntervalMinutes("1h")).toBe(60);
    expect(krakenIntervalMinutes("4h")).toBe(240);
    expect(krakenIntervalMinutes("1D")).toBe(1440);
    expect(krakenIntervalMinutes("2h")).toBeUndefined();
  });

  it("exposes the WS v2 pair name per symbol", () => {
    expect(krakenSymbolInfo("XBTUSD")?.wsSymbol).toBe("BTC/USD");
    expect(krakenSymbolInfo("DOGEUSD")?.wsSymbol).toBe("DOGE/USD");
  });
});

// ---------- REST normalization ----------

/** Kraken OHLC row: [time sec, open, high, low, close, vwap, volume, count]. */
const OHLC_ROW = [1792382400, "82530.81", "82882.00", "82484.27", "82783.54", "82600.1", "407.52", 59253];

describe("normalizeKrakenOhlcRow", () => {
  it("converts epoch-seconds open time to ms and maps OHLCV", () => {
    const warnings: string[] = [];
    const c = normalizeKrakenOhlcRow(OHLC_ROW, "XBTUSD", warnings);
    expect(c).toMatchObject({
      time: 1792382400000,
      open: 82530.81,
      high: 82882,
      low: 82484.27,
      close: 82783.54,
      volume: 407.52,
      tradeCount: 59253,
      exchange: "KRAKEN",
    });
    expect(warnings).toHaveLength(0);
  });

  it("rejects impossible OHLC relationships and malformed rows", () => {
    const warnings: string[] = [];
    expect(
      normalizeKrakenOhlcRow([1792382400, "100", "90", "80", "95", "0", "1", 1], "XBTUSD", warnings),
    ).toBeUndefined(); // high < open
    expect(normalizeKrakenOhlcRow(["x"], "XBTUSD", warnings)).toBeUndefined();
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });
});

describe("normalizeKrakenOhlc", () => {
  it("resolves the legacy pair key Kraken returns (XXBTZUSD for XBTUSD)", () => {
    const res = normalizeKrakenOhlc(
      {
        XXBTZUSD: [
          OHLC_ROW,
          [1792386000, "82530.81", "82882.00", "82484.27", "82800", "82600.1", "407.52", 59253],
        ],
        last: 1792386000,
      },
      "XBTUSD",
      "1h",
      1792386000000 + 999,
    );
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.candles).toHaveLength(2);
      expect(res.candles[1].close).toBe(82800);
      expect(res.symbol).toBe("XBTUSD");
      expect(res.hasFormingCandle).toBe(true); // last bar's close lies in the future
    }
  });

  it("fails closed on a payload with no recognizable candle array", () => {
    const res = normalizeKrakenOhlc({ last: 1 }, "XBTUSD", "1h");
    expect("error" in res).toBe(true);
  });
});

const TICKER_ROW = {
  a: ["83000", "1", "1.0"],
  b: ["82990", "1", "1.0"],
  c: ["83000.5", "0.01"],
  v: ["100", "200"],
  p: ["82800", "82900"],
  t: [1, 2],
  l: ["82000", "82000"],
  h: ["83500", "83500"],
  o: "82000",
};

describe("normalizeKrakenTickers", () => {
  it("maps each allowlist pair via its legacy result key", () => {
    const res = normalizeKrakenTickers({
      XXBTZUSD: TICKER_ROW,
      XETHZUSD: { ...TICKER_ROW, c: ["3100.25", "1"], o: "3000" },
    });
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      const btc = res.quotes.find((q) => q.symbol === "XBTUSD");
      const eth = res.quotes.find((q) => q.symbol === "ETHUSD");
      expect(btc?.last).toBe(83000.5);
      expect(btc?.changePct24h).toBeCloseTo(((83000.5 - 82000) / 82000) * 100, 5);
      expect(btc?.quoteVolume24h).toBeCloseTo(100 * 82800, 0); // vol(today) × vwap(today)
      expect(eth?.last).toBe(3100.25);
      expect(res.warnings.length).toBeGreaterThan(0); // the other allowlist pairs were absent
    }
  });
});

// ---------- WS v2 parsing ----------

describe("parseKrakenWsMessage", () => {
  it("parses a ticker update into a quote event", () => {
    const events = parseKrakenWsMessage(
      JSON.stringify({
        channel: "ticker",
        type: "update",
        data: [
          {
            symbol: "BTC/USD",
            last: 83000.5,
            change: 1000.5,
            change_pct: 1.22,
            high: 83500,
            low: 82000,
            volume: 1234.5,
            vwap: 82800,
            timestamp: "2026-10-19T10:00:00.000Z",
          },
        ],
      }),
    );
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe("ticker");
    if (e.kind === "ticker") {
      expect(e.symbol).toBe("XBTUSD");
      expect(e.quote.last).toBe(83000.5);
      expect(e.quote.changePct24h).toBeCloseTo(1.22);
      expect(e.quote.eventTime).toBe(Date.parse("2026-10-19T10:00:00.000Z"));
    }
  });

  it("parses an ohlc update into a candle keyed by interval_begin", () => {
    const events = parseKrakenWsMessage(
      JSON.stringify({
        channel: "ohlc",
        type: "update",
        data: [
          {
            symbol: "BTC/USD",
            open: 82500,
            high: 83000,
            low: 82400,
            close: 82800,
            volume: 12.5,
            interval: 60,
            interval_begin: "2026-10-19T10:00:00.000Z",
          },
        ],
      }),
    );
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe("ohlc");
    if (e.kind === "ohlc") {
      expect(e.symbol).toBe("XBTUSD");
      expect(e.candle.time).toBe(Date.parse("2026-10-19T10:00:00.000Z"));
      expect(e.candle.close).toBe(82800);
    }
  });

  it("ignores heartbeats, subscription acks, malformed frames, and unlisted symbols", () => {
    expect(
      parseKrakenWsMessage(JSON.stringify({ channel: "heartbeat" })),
    ).toEqual([{ kind: "ignored" }]);
    expect(
      parseKrakenWsMessage(
        JSON.stringify({ method: "subscribe", success: true, result: { channel: "ticker" } }),
      ),
    ).toEqual([{ kind: "ignored" }]);
    expect(parseKrakenWsMessage("not json")).toEqual([{ kind: "ignored" }]);
    expect(
      parseKrakenWsMessage(
        JSON.stringify({
          channel: "ohlc",
          type: "update",
          data: [{ symbol: "SHIB/USD", open: 1, high: 1, low: 1, close: 1, interval_begin: "2026-10-19T10:00:00.000Z" }],
        }),
      ),
    ).toEqual([]);
  });
});

// ---------- REST client ----------

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("fetchKrakenOhlc / fetchKrakenQuotes", () => {
  it("rejects unlisted symbols and unsupported timeframes", async () => {
    const a = await fetchKrakenOhlc("PEPEUSD", "1h");
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error.code).toBe("unsupported_symbol");
    const b = await fetchKrakenOhlc("XBTUSD", "2h");
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.code).toBe("unsupported_timeframe");
  });

  it("surfaces Kraken's error array as provider_error", async () => {
    const res = await fetchKrakenOhlc("XBTUSD", "1h", 50, {
      fetchImpl: fakeFetch(200, { error: ["EQuery:Unknown asset pair"], result: {} }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("provider_error");
  });

  it("normalizes a real-shaped OHLC envelope and tail-slices to the limit", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => [
      1792382400 + i * 3600,
      ...OHLC_ROW.slice(1),
    ]);
    const res = await fetchKrakenOhlc("XBTUSD", "1h", 3, {
      fetchImpl: fakeFetch(200, { error: [], result: { XXBTZUSD: rows, last: 1 } }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.candles).toHaveLength(3);
      expect(res.data.candles[0].time).toBe((1792382400 + 2 * 3600) * 1000); // newest 3 kept
    }
  });

  it("normalizes the Ticker envelope into allowlisted quotes", async () => {
    const res = await fetchKrakenQuotes({
      fetchImpl: fakeFetch(200, { error: [], result: { XXBTZUSD: TICKER_ROW } }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0].symbol).toBe("XBTUSD");
      expect(res.data[0].venue).toBe("Kraken Spot");
    }
  });
});

// ---------- WebSocket stream ----------

class FakeKrakenSocket implements KrakenSocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  closed = false;
  sent: string[] = [];
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

describe("KrakenStream", () => {
  it("sends ticker + ohlc subscribe frames on open and goes live on first data", () => {
    const sockets: FakeKrakenSocket[] = [];
    const statuses: FeedStatus[] = [];
    const events: unknown[] = [];
    const stream = new KrakenStream({
      symbols: ["BTC/USD"],
      ohlcIntervalMinutes: 60,
      onMessage: (e) => events.push(e),
      onStatus: (s) => statuses.push(s),
      wsFactory: (url) => {
        const s = new FakeKrakenSocket(url);
        sockets.push(s);
        return s;
      },
      isOnline: () => true,
    });
    stream.start();
    expect(statuses).toEqual(["connecting"]);
    sockets[0].open();
    expect(sockets[0].sent).toHaveLength(2);
    expect(JSON.parse(sockets[0].sent[0])).toMatchObject({
      method: "subscribe",
      params: { channel: "ticker", symbol: ["BTC/USD"] },
    });
    expect(JSON.parse(sockets[0].sent[1])).toMatchObject({
      method: "subscribe",
      params: { channel: "ohlc", symbol: ["BTC/USD"], interval: 60 },
    });
    expect(statuses).toEqual(["connecting"]); // open but silent
    sockets[0].emit({
      channel: "ticker",
      type: "update",
      data: [{ symbol: "BTC/USD", last: 83000, timestamp: "2026-10-19T10:00:00.000Z" }],
    });
    expect(statuses).toEqual(["connecting", "live"]);
    expect(events).toHaveLength(1);
    stream.close();
    expect(sockets[0].closed).toBe(true);
    expect(statuses[statuses.length - 1]).toBe("offline");
  });
});
