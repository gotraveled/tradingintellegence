import type { BacktestRequest, BacktestResult } from "@/lib/types";
import { ServiceUnavailableError } from "./types";

const SIMULATED_LATENCY_MS = 900;

/**
 * Submits a backtest. The backtesting service is not implemented yet, so this always rejects
 * with `ServiceUnavailableError` after a short delay (so loading and error states can be built).
 */
export async function runBacktest(request: BacktestRequest): Promise<BacktestResult> {
  void request;
  await new Promise((resolve) => setTimeout(resolve, SIMULATED_LATENCY_MS));
  throw new ServiceUnavailableError(
    "Backtesting engine",
    "The backtesting engine is not connected yet. No backtest was run.",
  );
}
