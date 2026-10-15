/**
 * POST /api/backtest — the server-side backtest boundary. The API key lives only here:
 * the browser sends a `BacktestRequest` and receives a `BacktestResult` or an honest
 * error. No engine code or credentials reach the client.
 *
 * Product-layer bounds (per the abuse-boundary rule): explicit symbol lists are capped at
 * MAX_SYMBOLS and periods at MAX_PERIOD_DAYS — the current consumer needs ≤8 catalog
 * symbols and ~1y windows.
 */
import { createConfiguredProvider } from "@/lib/market-data/providers";
import { executeSystemBacktest } from "@/lib/services/backtest-service";
import { ServiceUnavailableError } from "@/lib/services/types";
import type { BacktestRequest } from "@/lib/types";

const MAX_SYMBOLS = 16;
const MAX_PERIOD_DAYS = 1825; // 5 years.

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

  const request = body as BacktestRequest;
  if (typeof request?.strategyId !== "string" || request.strategyId.trim() === "") {
    return json(400, { error: { message: "strategyId is required." } });
  }
  if (typeof request?.timeframe !== "string" || request.timeframe.trim() === "") {
    return json(400, { error: { message: "timeframe is required." } });
  }
  const from = Date.parse(request?.period?.from ?? "");
  const to = Date.parse(request?.period?.to ?? "");
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return json(400, { error: { message: "period.from must be a valid timestamp before period.to." } });
  }
  if (to - from > MAX_PERIOD_DAYS * 86_400_000) {
    return json(400, { error: { message: `Backtest period may not exceed ${MAX_PERIOD_DAYS} days.` } });
  }
  if (request.symbols !== undefined) {
    if (!Array.isArray(request.symbols) || request.symbols.some((s) => typeof s !== "string")) {
      return json(400, { error: { message: "symbols must be an array of strings." } });
    }
    if (request.symbols.length > MAX_SYMBOLS) {
      return json(400, { error: { message: `At most ${MAX_SYMBOLS} symbols per backtest.` } });
    }
  }

  const provider = createConfiguredProvider();
  if (!provider) {
    return json(503, {
      error: {
        service: "Market data provider",
        message: "No historical market-data provider is configured. The backtest was not run.",
      },
    });
  }

  try {
    const execution = await executeSystemBacktest(request, { provider });
    return json(200, {
      result: execution.result,
      skipped: execution.skipped,
    });
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return json(503, { error: { service: error.service, message: error.message } });
    }
    const message = error instanceof Error ? error.message : "Backtest failed.";
    const status = /must|required|invalid|No instruments/i.test(message) ? 400 : 500;
    return json(status, { error: { message } });
  }
}
