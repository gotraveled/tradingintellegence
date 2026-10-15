import type { BacktestRequest, BacktestResult } from "@/lib/types";
import { ServiceUnavailableError } from "./types";

/**
 * Strategy Lab backtest seam — the client side of the server boundary.
 *
 * `runBacktest` posts the request to `/api/backtest`; the provider, product-layer
 * composition, and spec-26 engine all execute server-side (credentials never reach the
 * browser). There is deliberately NO fallback data path — a server failure surfaces as a
 * service error, never as a fabricated result.
 *
 * The server-side registry for provider injection lives in
 * `src/lib/market-data/providers/index.ts` (`setConfiguredProvider`/`createConfiguredProvider`).
 */

interface BacktestApiResponse {
  result?: BacktestResult;
  error?: { service?: string; message?: string };
}

export async function runBacktest(request: BacktestRequest): Promise<BacktestResult> {
  let res: Response;
  try {
    res = await fetch("/api/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    throw new ServiceUnavailableError(
      "Backtest service",
      "The backtest service could not be reached. The backtest was not run.",
    );
  }

  let body: BacktestApiResponse;
  try {
    body = (await res.json()) as BacktestApiResponse;
  } catch {
    throw new ServiceUnavailableError(
      "Backtest service",
      "The backtest service returned a malformed response.",
    );
  }

  if (!res.ok || body.result === undefined) {
    const message = body.error?.message ?? `Backtest request failed (HTTP ${res.status}).`;
    if (res.status === 503) {
      throw new ServiceUnavailableError(body.error?.service ?? "Backtest service", message);
    }
    throw new Error(message);
  }
  return body.result;
}
