import { getInstrument } from "@/lib/constants/instruments";
import { MARKET_SEGMENTS } from "@/lib/constants/markets";
import type {
  AnalysisCell,
  AnalysisRequest,
  AnalysisResult,
  BacktestOpportunity,
  MarketSegmentId,
  Opportunity,
  PriceTarget,
  Timeframe,
} from "@/lib/types";
import { ServiceUnavailableError } from "./types";

/**
 * Scanner analysis seam — the client side of the server boundary.
 *
 * `runAnalysis` posts the request to `/api/analysis`; the provider, product-layer
 * composition, and spec-25/26 engine all execute server-side (credentials never
 * reach the browser). There is deliberately NO fallback data path — a server
 * failure surfaces as a service error, never as a fabricated result.
 *
 * The server-side registry for provider injection lives in
 * `src/lib/market-data/providers/index.ts` (`setConfiguredProvider`/`createConfiguredProvider`).
 */

interface AnalysisApiResponse {
  result?: AnalysisResult;
  error?: { service?: string; message?: string };
}

export async function runAnalysis(
  request: AnalysisRequest,
  opts?: { signal?: AbortSignal },
): Promise<AnalysisResult> {
  let res: Response;
  try {
    res = await fetch("/api/analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: opts?.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ServiceUnavailableError(
      "Analysis service",
      "The analysis service could not be reached. The scan was not run.",
    );
  }

  let body: AnalysisApiResponse;
  try {
    body = (await res.json()) as AnalysisApiResponse;
  } catch {
    throw new ServiceUnavailableError(
      "Analysis service",
      "The analysis service returned a malformed response.",
    );
  }

  if (!res.ok || body.result === undefined) {
    const message = body.error?.message ?? `Analysis request failed (HTTP ${res.status}).`;
    if (res.status === 503) {
      throw new ServiceUnavailableError(body.error?.service ?? "Analysis service", message);
    }
    throw new Error(message);
  }
  return body.result;
}

/**
 * Presentation mapping — frozen spec-25/26 records → the UI `Opportunity` shape.
 * Instrument metadata comes from the catalog; a record for a symbol the catalog
 * cannot classify is omitted rather than shown with invented identity (the raw
 * record is still present in the API response for audit).
 */
export function toOpportunities(result: AnalysisResult): Opportunity[] {
  const at = (record: { evaluatedAt: number }) => new Date(record.evaluatedAt).toISOString();
  const out: Opportunity[] = [];
  for (const record of result.opportunities) {
    const meta = result.cells.find((cell) => cell.symbol === record.symbol)?.asset;
    const instrument = getInstrument(record.symbol);
    const assetClass = meta?.assetClass ?? instrument?.assetClass;
    if (assetClass === undefined) continue; // never fabricate a market identity
    const marketId = meta?.marketId ?? instrument?.marketId;
    // `marketId` arrives as the Asset's free-form ID — admit only the canonical
    // MarketSegmentId set; anything else is omitted rather than coerced.
    const market = MARKET_SEGMENTS.some((s) => s.id === marketId)
      ? (marketId as MarketSegmentId)
      : undefined;
    const targets = record.plan?.targets as PriceTarget[] | undefined;
    out.push({
      id: `${record.setupId}@${record.evaluatedAt}`,
      setupId: record.setupId,
      symbol: record.symbol,
      assetClass,
      market,
      setupType: record.setupType,
      direction: record.direction,
      score: record.score,
      scoreContributions: record.scoreContributions,
      timeframe: record.timeframe,
      status: record.status,
      entry: record.plan?.entry,
      stopLoss: record.plan?.stopLoss,
      targets,
      riskReward: record.plan?.riskReward,
      createdAt: at(record),
      updatedAt: at(record),
      pricePrecision: instrument?.pricePrecision,
      metadata: {
        evaluatedAt: record.evaluatedAt,
        rank: record.rank,
        ...(record.selected !== undefined ? { selected: record.selected } : {}),
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chart-triggered analysis — the "Analyze chart" workflow. One instrument, one
// timeframe, anchored to the displayed candle window's exclusive end so the engine
// evaluates exactly the point-in-time the chart is showing.

const DAY_MS = 86_400_000;
/** Mirrors ANALYSIS_MAX_LOOKBACK_DAYS (server-enforced); duplicated to keep the
 *  client-side builder dependency-free and testable without server modules. */
export const CHART_ANALYSIS_MAX_LOOKBACK_DAYS = 180;

export interface ChartAnalysisInput {
  symbol: string;
  timeframe: Timeframe;
  /** Exclusive window end of the displayed candles (ms). */
  windowEnd: number;
  /** Inclusive window start of the displayed candles (ms). */
  windowStart: number;
}

export interface BuiltChartAnalysisRequest {
  request: AnalysisRequest;
  /** True when the chart window exceeds the API lookback bound — the analysis
   *  covers the trailing `lookbackDays`, NOT the whole displayed range. */
  windowClamped: boolean;
  lookbackDays: number;
}

/**
 * Build the AnalysisRequest for the currently displayed chart. `asOf` = the candles'
 * exclusive `end` (typically request time); the engine's `closedIndexAt` then anchors
 * evaluation to the last bar CLOSED at-or-before it — never the forming bar.
 */
export function chartAnalysisRequest(input: ChartAnalysisInput): BuiltChartAnalysisRequest {
  const spanDays = Math.max(1, Math.ceil((input.windowEnd - input.windowStart) / DAY_MS));
  const lookbackDays = Math.min(CHART_ANALYSIS_MAX_LOOKBACK_DAYS, spanDays);
  return {
    request: {
      symbols: [input.symbol],
      timeframe: input.timeframe,
      asOf: new Date(input.windowEnd).toISOString(),
      lookbackDays,
    },
    windowClamped: spanDays > lookbackDays,
    lookbackDays,
  };
}

/** The analyzed cell for the requested symbol/timeframe, or undefined when skipped. */
export function pickCell(
  result: AnalysisResult,
  symbol: string,
  timeframe: Timeframe,
): AnalysisCell | undefined {
  return result.cells.find((c) => c.symbol === symbol && c.timeframe === timeframe);
}

/** Ranked records for the requested symbol/timeframe — the only ones the chart may draw. */
export function pickOpportunities(
  result: AnalysisResult,
  symbol: string,
  timeframe: Timeframe,
): BacktestOpportunity[] {
  return result.opportunities.filter((r) => r.symbol === symbol && r.timeframe === timeframe);
}
