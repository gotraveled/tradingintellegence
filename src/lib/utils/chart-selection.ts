import { DEFAULT_TIMEFRAME, FEATURED_INSTRUMENTS, ROUTES, TIMEFRAMES } from "@/lib/constants";
import type { Timeframe } from "@/lib/types";

/**
 * `/chart` URL contract — the addressable selection (Unified Market Workspace,
 * Phase 1). The URL is the source of truth for symbol/timeframe; these helpers
 * are the single place that parses, validates, and serializes it.
 */

/** Search params as Next.js delivers them to a page (`searchParams` prop, resolved). */
export type ChartQuery = Record<string, string | string[] | undefined>;

/** The opt-in analysis trigger. Only the literal value `"1"` arms it. */
export const CHART_ANALYZE_PARAM = "analyze";

export interface ChartSelection {
  /** Resolved instrument — always a catalog symbol (unsupported input falls back). */
  symbol: string;
  /** Resolved timeframe — always a defined `Timeframe`. */
  timeframe: Timeframe;
  /** `true` when `timeframe` came from a valid URL param (vs the default). */
  timeframeFromUrl: boolean;
  /** `true` when `?analyze=1` requests a one-shot analysis for this selection. */
  autoAnalyze: boolean;
  /** `true` when a present param was invalid — the URL should be normalized. */
  normalized: boolean;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function isChartSymbol(value: string | undefined): value is string {
  return (
    value !== undefined && FEATURED_INSTRUMENTS.some((asset) => asset.symbol === value)
  );
}

export function isChartTimeframe(value: string | undefined): value is Timeframe {
  return TIMEFRAMES.some((tf) => tf.value === value);
}

/**
 * Validate `symbol`/`timeframe` against the instrument catalog and timeframe
 * definitions. Missing params resolve to the repository defaults; present-but-
 * invalid params resolve to defaults and set `normalized` so the caller can
 * rewrite the URL. Support is never inferred — only catalog symbols resolve.
 */
export function parseChartSelection(searchParams: ChartQuery): ChartSelection {
  const rawSymbol = firstParam(searchParams.symbol);
  const rawTimeframe = firstParam(searchParams.timeframe);
  const symbol = isChartSymbol(rawSymbol)
    ? rawSymbol
    : FEATURED_INSTRUMENTS[0].symbol;
  const timeframeFromUrl = isChartTimeframe(rawTimeframe);
  return {
    symbol,
    timeframe: timeframeFromUrl ? rawTimeframe : DEFAULT_TIMEFRAME,
    timeframeFromUrl,
    autoAnalyze: firstParam(searchParams[CHART_ANALYZE_PARAM]) === "1",
    normalized:
      (rawSymbol !== undefined && !isChartSymbol(rawSymbol)) ||
      (rawTimeframe !== undefined && !isChartTimeframe(rawTimeframe)),
  };
}

function appendParam(
  params: URLSearchParams,
  key: string,
  value: string | string[] | undefined,
): void {
  for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
    params.append(key, item);
  }
}

/** Serialize a `ChartQuery` preserving key order and repeated values. */
export function serializeQuery(searchParams: ChartQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    appendParam(params, key, value);
  }
  return params.toString();
}

/**
 * Canonical `/chart` query: unrelated params are preserved, `symbol` and
 * `timeframe` are always set, and the one-shot `analyze` param is never carried
 * forward. Comparing `buildChartQuery` output to `serializeQuery` of the same
 * raw params is the loop-safe "does the URL need rewriting" check.
 */
export function buildChartQuery(
  searchParams: ChartQuery,
  selection: { symbol: string; timeframe: Timeframe },
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "symbol" || key === "timeframe" || key === CHART_ANALYZE_PARAM) continue;
    appendParam(params, key, value);
  }
  params.set("symbol", selection.symbol);
  params.set("timeframe", selection.timeframe);
  return params.toString();
}

/** `/chart?…` href for a resolved selection, preserving unrelated params. */
export function buildChartHref(
  searchParams: ChartQuery,
  selection: { symbol: string; timeframe: Timeframe },
): string {
  return `${ROUTES.chart}?${buildChartQuery(searchParams, selection)}`;
}

/**
 * `/chart` destination for a known selection — or `undefined` when the symbol
 * or timeframe is not chartable. Callers must render an honest unavailable
 * state rather than link to a substituted instrument. Never adds `analyze=1`:
 * opening a chart is viewing, not an implicit analysis request.
 */
export function chartHref(symbol: string, timeframe: string): string | undefined {
  if (!isChartSymbol(symbol) || !isChartTimeframe(timeframe)) return undefined;
  const params = new URLSearchParams({ symbol, timeframe });
  return `${ROUTES.chart}?${params.toString()}`;
}
