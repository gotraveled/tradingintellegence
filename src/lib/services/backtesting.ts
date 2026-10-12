import { DEMO_BACKTEST_RESULT, DEMO_STRATEGIES } from "@/lib/mock";
import type { BacktestResult, Strategy } from "@/lib/types";
import type { DataEnvelope } from "./types";

/*
 * Strategy definitions and stored results. Returns demo data until the backtesting service exists.
 */

export function getStrategies(): DataEnvelope<Strategy[]> {
  return { source: "demo", data: DEMO_STRATEGIES };
}

/** An illustrative result for previewing the results UI. Never presented as a real backtest. */
export function getDemoBacktestResult(): DataEnvelope<BacktestResult> {
  return { source: "demo", data: DEMO_BACKTEST_RESULT };
}
