import type { Timeframe } from "@/lib/types";

/**
 * Indian index feed — Yahoo Finance public chart API (unofficial, no key).
 *
 * NSE/BSE indices carry no real intraday volume (an index isn't traded),
 * so `volume` is 0 on every bar — the Victor scalp and Confluence engine
 * are price-action first and degrade honestly on missing volume.
 *
 * Market hours 09:15–15:30 IST (03:45–10:00 UTC). Yahoo returns ~15-min
 * delayed bars for Indian indices — paper-trading use only, disclosed in
 * the UI.
 */

export const VENUE_LABEL = "NSE/BSE — Yahoo";

/**
 * Strict symbol allowlist — each maps a UI symbol to its Yahoo ticker.
 * Never accepts arbitrary input: the proxy route rejects unlisted symbols.
 */
export const INDIA_SYMBOLS = [
  {
    symbol: "NIFTY50",
    yahoo: "^NSEI",
    label: "NIFTY 50",
    name: "NSE Nifty 50 Index",
    pricePrecision: 2,
  },
  {
    symbol: "SENSEX",
    yahoo: "^BSESN",
    label: "SENSEX",
    name: "BSE Sensex Index",
    pricePrecision: 2,
  },
] as const;

export type IndiaSymbol = (typeof INDIA_SYMBOLS)[number]["symbol"];

const INDIA_SYMBOL_SET: ReadonlySet<string> = new Set(INDIA_SYMBOLS.map((s) => s.symbol));

export function indiaSymbolInfo(symbol: string) {
  return INDIA_SYMBOLS.find((s) => s.symbol === symbol);
}

export function isIndiaSymbol(symbol: string): symbol is IndiaSymbol {
  return INDIA_SYMBOL_SET.has(symbol);
}

export function yahooSymbol(symbol: string): string | undefined {
  return indiaSymbolInfo(symbol)?.yahoo;
}

/**
 * Timeframe → Yahoo interval + range needed for ~200 bars.
 * Yahoo limits: 1m ≤ 7d, 5m/15m/30m ≤ 60d, 60m ≤ 730d.
 * 4h isn't offered by Yahoo — omitted from the India venue.
 */
export const INDIA_INTERVALS: {
  timeframe: Timeframe;
  yahoo: string;
  range: string;
  label: string;
}[] = [
  { timeframe: "1m", yahoo: "1m", range: "1d", label: "1m" },
  { timeframe: "5m", yahoo: "5m", range: "5d", label: "5m" },
  { timeframe: "15m", yahoo: "15m", range: "15d", label: "15m" },
  { timeframe: "30m", yahoo: "30m", range: "1mo", label: "30m" },
  { timeframe: "1h", yahoo: "60m", range: "3mo", label: "1H" },
  { timeframe: "1D", yahoo: "1d", range: "1y", label: "1D" },
];

export function indiaInterval(timeframe: Timeframe): { yahoo: string; range: string } | undefined {
  const i = INDIA_INTERVALS.find((x) => x.timeframe === timeframe);
  return i === undefined ? undefined : { yahoo: i.yahoo, range: i.range };
}

export const DEFAULT_INDIA_SYMBOL: IndiaSymbol = "NIFTY50";
export const DEFAULT_INDIA_TIMEFRAME: Timeframe = "5m";

/** NSE entry session in UTC hours — 03:45–10:00 UTC ≈ 09:15–15:30 IST. */
export const INDIA_SESSION_UTC: readonly [number, number] = [3.75, 10];

export const REST_TIMEOUT_MS = 10_000;
