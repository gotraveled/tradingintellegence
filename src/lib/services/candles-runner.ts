import type { CandlesRequest, CandlesResult, MarketDataErrorCode } from "@/lib/types";
import { ServiceUnavailableError } from "./types";

/**
 * Chart candles seam — the client side of the server boundary.
 *
 * `fetchCandles` posts the request to `/api/candles`; provider access and credentials
 * stay server-side. Typed failures distinguish: invalid input (400), unsupported
 * instrument/timeframe (422), provider-reported no-data (404), rate limit (429),
 * provider failure (502), unconfigured provider (503 → `ServiceUnavailableError`).
 * A 200 with `candleCount: 0` is a VALID empty window — returned as a result, never
 * an error. AbortSignal is forwarded so obsolete symbol/timeframe fetches cancel.
 */

interface CandlesApiResponse {
  result?: CandlesResult;
  error?: { code?: string; service?: string; message?: string };
}

/** A typed HTTP-level candles failure — carries the server's canonical error code. */
export class CandlesClientError extends Error {
  readonly code: MarketDataErrorCode | "invalid_request" | string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CandlesClientError";
    this.status = status;
    this.code = code;
  }
}

export async function fetchCandles(
  request: CandlesRequest,
  opts?: { signal?: AbortSignal },
): Promise<CandlesResult> {
  let res: Response;
  try {
    res = await fetch("/api/candles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: opts?.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ServiceUnavailableError(
      "Market data service",
      "The candles service could not be reached. The chart was not updated.",
    );
  }

  let body: CandlesApiResponse;
  try {
    body = (await res.json()) as CandlesApiResponse;
  } catch {
    throw new ServiceUnavailableError(
      "Market data service",
      "The candles service returned a malformed response.",
    );
  }

  if (!res.ok || body.result === undefined) {
    const message = body.error?.message ?? `Candles request failed (HTTP ${res.status}).`;
    if (res.status === 503) {
      throw new ServiceUnavailableError(
        body.error?.service ?? "Market data provider",
        message,
      );
    }
    throw new CandlesClientError(res.status, body.error?.code ?? "provider_error", message);
  }
  return body.result;
}
