/**
 * POST /api/analysis — the server-side analysis boundary. The API key lives only
 * here: the browser sends an `AnalysisRequest` and receives an `AnalysisResult` of
 * point-in-time engine observations, or an honest error. No engine code or
 * credentials reach the client.
 *
 * Product-layer bounds (per the abuse-boundary rule, mirroring /api/backtest):
 * explicit symbol lists are capped at MAX_SYMBOLS and history depth at
 * MAX_LOOKBACK_DAYS — the current consumer needs ≤8 catalog symbols and ≤180 days.
 *
 * Data provenance: `result.dataSource` names the configured provider
 * (`kind: "rest"` — historical aggregates, never a live stream).
 */
import { createConfiguredProvider } from "@/lib/market-data/providers";
import {
  ANALYSIS_MAX_LOOKBACK_DAYS,
  ANALYSIS_MAX_SYMBOLS,
  executeAnalysis,
} from "@/lib/services/analysis-service";
import { ServiceUnavailableError } from "@/lib/services/types";
import type { AnalysisRequest } from "@/lib/types";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: { message: "Request body must be valid JSON." } });
  }

  const request = body as AnalysisRequest;
  if (typeof request?.timeframe !== "string" || request.timeframe.trim() === "") {
    return json(400, { error: { message: "timeframe is required." } });
  }
  if (request.asOf !== undefined && !Number.isFinite(Date.parse(request.asOf))) {
    return json(400, { error: { message: "asOf must be a valid ISO timestamp when supplied." } });
  }
  if (request.lookbackDays !== undefined) {
    if (
      typeof request.lookbackDays !== "number" ||
      !Number.isFinite(request.lookbackDays) ||
      request.lookbackDays <= 0 ||
      request.lookbackDays > ANALYSIS_MAX_LOOKBACK_DAYS
    ) {
      return json(400, {
        error: {
          message: `lookbackDays must be a positive number no greater than ${ANALYSIS_MAX_LOOKBACK_DAYS}.`,
        },
      });
    }
  }
  if (request.symbols !== undefined) {
    if (!Array.isArray(request.symbols) || request.symbols.some((s) => typeof s !== "string")) {
      return json(400, { error: { message: "symbols must be an array of strings." } });
    }
    if (request.symbols.length > ANALYSIS_MAX_SYMBOLS) {
      return json(400, { error: { message: `At most ${ANALYSIS_MAX_SYMBOLS} symbols per analysis.` } });
    }
  }

  const provider = createConfiguredProvider();
  if (!provider) {
    return json(503, {
      error: {
        service: "Market data provider",
        message: "No historical market-data provider is configured. The analysis was not run.",
      },
    });
  }

  try {
    const result = await executeAnalysis(request, { provider });
    return json(200, { result });
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return json(503, { error: { service: error.service, message: error.message } });
    }
    const message = error instanceof Error ? error.message : "Analysis failed.";
    const status = /must|required|invalid|No instruments|at most/i.test(message) ? 400 : 500;
    return json(status, { error: { message } });
  }
}
