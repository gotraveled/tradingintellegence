import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEFRAME, FEATURED_INSTRUMENTS, ROUTES, TIMEFRAMES } from "@/lib/constants";
import {
  buildChartHref,
  buildChartQuery,
  chartHref,
  isChartSymbol,
  isChartTimeframe,
  parseChartSelection,
  serializeQuery,
} from "@/lib/utils";

const DEFAULT_SYMBOL = FEATURED_INSTRUMENTS[0].symbol;

describe("parseChartSelection", () => {
  it("resolves a valid symbol/timeframe pair from the URL", () => {
    const selection = parseChartSelection({ symbol: "ETHUSDT", timeframe: "1h" });
    expect(selection).toMatchObject({
      symbol: "ETHUSDT",
      timeframe: "1h",
      timeframeFromUrl: true,
      autoAnalyze: false,
      normalized: false,
    });
  });

  it("uses catalog and timeframe defaults when params are missing", () => {
    const selection = parseChartSelection({});
    expect(selection.symbol).toBe(DEFAULT_SYMBOL);
    expect(selection.timeframe).toBe(DEFAULT_TIMEFRAME);
    expect(selection.timeframeFromUrl).toBe(false);
    expect(selection.normalized).toBe(false);
  });

  it("resolves a valid symbol without a timeframe to the default timeframe", () => {
    const selection = parseChartSelection({ symbol: "AAPL" });
    expect(selection.symbol).toBe("AAPL");
    expect(selection.timeframe).toBe(DEFAULT_TIMEFRAME);
    expect(selection.timeframeFromUrl).toBe(false);
    expect(selection.normalized).toBe(false);
  });

  it("falls back and flags normalization for an unknown symbol", () => {
    const selection = parseChartSelection({ symbol: "DOGE", timeframe: "4h" });
    expect(selection.symbol).toBe(DEFAULT_SYMBOL);
    expect(selection.timeframe).toBe("4h");
    expect(selection.normalized).toBe(true);
  });

  it("falls back and flags normalization for an unsupported timeframe", () => {
    const selection = parseChartSelection({ symbol: "BTCUSDT", timeframe: "2h" });
    expect(selection.symbol).toBe("BTCUSDT");
    expect(selection.timeframe).toBe(DEFAULT_TIMEFRAME);
    expect(selection.timeframeFromUrl).toBe(false);
    expect(selection.normalized).toBe(true);
  });

  it("rejects non-catalog values that could never be supported", () => {
    for (const bogus of ["btcusdt", "btc", "BTC-USD", "", "../../x", "javascript:1"]) {
      const selection = parseChartSelection({ symbol: bogus });
      expect(selection.symbol).toBe(DEFAULT_SYMBOL);
      expect(selection.normalized).toBe(true);
    }
  });

  it("accepts every catalog symbol exactly as written — no inference", () => {
    for (const asset of FEATURED_INSTRUMENTS) {
      const selection = parseChartSelection({ symbol: asset.symbol });
      expect(selection.symbol).toBe(asset.symbol);
      expect(selection.normalized).toBe(false);
    }
  });

  it("takes the first value when a param repeats", () => {
    const selection = parseChartSelection({
      symbol: ["AAPL", "ETHUSDT"],
      timeframe: ["15m", "1W"],
    });
    expect(selection.symbol).toBe("AAPL");
    expect(selection.timeframe).toBe("15m");
  });

  it("arms auto-analyze only on the literal analyze=1", () => {
    expect(parseChartSelection({ analyze: "1" }).autoAnalyze).toBe(true);
    for (const value of ["0", "true", "yes", "", undefined]) {
      expect(parseChartSelection({ analyze: value }).autoAnalyze).toBe(false);
    }
  });
});

describe("buildChartQuery / serializeQuery", () => {
  it("writes a canonical selection into the query", () => {
    const query = buildChartQuery(
      {},
      { symbol: "ETHUSDT", timeframe: "1h" },
    );
    expect(query).toBe("symbol=ETHUSDT&timeframe=1h");
  });

  it("preserves unrelated params, including repeated keys", () => {
    const query = buildChartQuery(
      { view: ["a", "b"], from: "scanner" },
      { symbol: "AAPL", timeframe: "4h" },
    );
    expect(query).toBe("view=a&view=b&from=scanner&symbol=AAPL&timeframe=4h");
  });

  it("overwrites stale selection params and strips analyze", () => {
    const query = buildChartQuery(
      { symbol: "BTCUSDT", timeframe: "1m", analyze: "1", keep: "yes" },
      { symbol: "XAUUSD", timeframe: "1D" },
    );
    expect(query).toBe("keep=yes&symbol=XAUUSD&timeframe=1D");
  });

  it("is loop-safe: a normalized URL needs no second rewrite", () => {
    // The workspace rewrites when `buildChartQuery(params) !== serializeQuery(params)`.
    // After one rewrite, the comparison must stabilize — otherwise router.replace loops.
    const rewritten = new URLSearchParams(
      buildChartQuery(
        { symbol: "NOPE", timeframe: "bogus", analyze: "1", keep: "1" },
        { symbol: DEFAULT_SYMBOL, timeframe: DEFAULT_TIMEFRAME },
      ),
    );
    const canonicalParams = Object.fromEntries(rewritten.entries());
    expect(buildChartQuery(canonicalParams, {
      symbol: DEFAULT_SYMBOL,
      timeframe: DEFAULT_TIMEFRAME,
    })).toBe(serializeQuery(canonicalParams));
  });

  it("serializeQuery preserves order and repeated values", () => {
    expect(serializeQuery({ a: ["1", "2"], b: "x", c: undefined })).toBe("a=1&a=2&b=x");
  });
});

describe("buildChartHref", () => {
  it("produces an addressable /chart href", () => {
    const href = buildChartHref({}, { symbol: "EURUSD", timeframe: "1W" });
    expect(href).toBe(`${ROUTES.chart}?symbol=EURUSD&timeframe=1W`);
  });
});

describe("chartHref — the scanner's guarded link builder", () => {
  it("links every catalog symbol and timeframe to its exact selection", () => {
    for (const asset of FEATURED_INSTRUMENTS) {
      for (const tf of TIMEFRAMES) {
        const href = chartHref(asset.symbol, tf.value);
        expect(href).not.toBeUndefined();
        // The URL must parse back to exactly the requested selection —
        // never a substituted or defaulted one.
        const params = Object.fromEntries(
          new URLSearchParams(href!.split("?")[1]).entries(),
        );
        const selection = parseChartSelection(params);
        expect(selection.symbol).toBe(asset.symbol);
        expect(selection.timeframe).toBe(tf.value);
        expect(selection.normalized).toBe(false);
      }
    }
  });

  it("never includes analyze — viewing a chart is not an analysis request", () => {
    for (const asset of FEATURED_INSTRUMENTS) {
      const href = chartHref(asset.symbol, "4h")!;
      expect(href).not.toContain("analyze");
    }
  });

  it("returns undefined for non-catalog symbols instead of redirecting", () => {
    expect(chartHref("DOGE", "4h")).toBeUndefined();
    expect(chartHref("btcusdt", "4h")).toBeUndefined();
    expect(chartHref("", "4h")).toBeUndefined();
  });

  it("returns undefined for unsupported timeframes", () => {
    expect(chartHref("BTCUSDT", "2h")).toBeUndefined();
    expect(chartHref("BTCUSDT", "daily")).toBeUndefined();
  });

  it("encodes symbols that contain spaces (NIFTY 50) for safe transport", () => {
    const href = chartHref("NIFTY 50", "4h")!;
    expect(href.startsWith(`${ROUTES.chart}?`)).toBe(true);
    const params = Object.fromEntries(
      new URLSearchParams(href.split("?")[1]).entries(),
    );
    expect(params.symbol).toBe("NIFTY 50");
    expect(params.timeframe).toBe("4h");
  });
});

describe("validators", () => {
  it("isChartSymbol is catalog-exact", () => {
    expect(isChartSymbol("BTCUSDT")).toBe(true);
    expect(isChartSymbol("NIFTY 50")).toBe(true);
    expect(isChartSymbol("btc")).toBe(false);
    expect(isChartSymbol(undefined)).toBe(false);
  });

  it("isChartTimeframe is definition-exact", () => {
    expect(isChartTimeframe("4h")).toBe(true);
    expect(isChartTimeframe("1M")).toBe(true);
    expect(isChartTimeframe("1m ")).toBe(false);
    expect(isChartTimeframe("daily")).toBe(false);
  });
});
