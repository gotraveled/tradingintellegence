/**
 * POST /api/candles — the server-side historical-candles boundary. The API key lives
 * only here: the browser sends a `CandlesRequest` and receives a `CandlesResult`
 * (possibly an honest zero-bar window) or a typed error. No provider internals or
 * credentials reach the client.
 *
 * HTTP mapping: 400 invalid request · 422 unsupported symbol/timeframe · 404 provider
 * reported no data · 429 provider rate-limited · 502 provider failure/malformed ·
 * 503 no provider configured. A provider-OK response with zero candles is a valid
 * 200 empty result — never confused with a failure.
 */
import { createConfiguredProvider } from "@/lib/market-data/providers";
import {
  CANDLES_MAX_BARS,
  CandlesError,
  executeCandles,
} from "@/lib/services/candles-service";
import { ServiceUnavailableError } from "@/lib/services/types";
import type { CandlesRequest, MarketDataErrorCode } from "@/lib/types";

const ERROR_STATUS: Record<MarketDataErrorCode | "invalid_request", number> = {
  invalid_request: 400,
  unsupported_symbol: 422,
  unsupported_timeframe: 422,
  data_not_available: 404,
  rate_limited: 429,
  provider_error: 502,
  invalid_data: 502,
  incomplete_data: 502,
  // 451 Unavailable For Legal Reasons — display rights not established.
  display_not_authorized: 451,
};

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function err(status: number, code: string, message: string, service?: string): Response {
  return json(status, { error: { code, message, ...(service !== undefined ? { service } : {}) } });
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "invalid_request", "Request body must be valid JSON.");
  }

  const request = body as CandlesRequest;
  if (typeof request?.symbol !== "string" || request.symbol.trim() === "") {
    return err(400, "invalid_request", "symbol is required.");
  }
  if (typeof request?.timeframe !== "string" || request.timeframe.trim() === "") {
    return err(400, "invalid_request", "timeframe is required.");
  }
  if (request.bars !== undefined && request.bars > CANDLES_MAX_BARS) {
    return err(400, "invalid_request", `bars may not exceed ${CANDLES_MAX_BARS}.`);
  }

  const provider = createConfiguredProvider();
  if (!provider) {
    return err(
      503,
      "data_not_available",
      "No historical market-data provider is configured. The candles were not fetched.",
      "Market data provider",
    );
  }

  try {
    const result = await executeCandles(request, { provider });
    return json(200, { result });
  } catch (error) {
    if (error instanceof CandlesError) {
      return err(ERROR_STATUS[error.code] ?? 502, error.code, error.message);
    }
    if (error instanceof ServiceUnavailableError) {
      return err(503, "data_not_available", error.message, error.service);
    }
    const message = error instanceof Error ? error.message : "Candles request failed.";
    return err(500, "provider_error", message);
  }
}
