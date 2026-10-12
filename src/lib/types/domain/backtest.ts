import type { Direction, ID, ISODateTime, Price, Timeframe } from "./common";
import type { SetupType } from "./setup";

export type BacktestTradeOutcome = "target" | "stop" | "breakeven" | "timeout";

export interface BacktestTrade {
  id: ID;
  symbol: string;
  direction: Direction;
  entryAt: ISODateTime;
  exitAt: ISODateTime;
  entry: Price;
  exit: Price;
  /** Result in R multiples (risk units). */
  resultR: number;
  outcome: BacktestTradeOutcome;
}

export interface BacktestResult {
  id: ID;
  strategyId: ID;
  symbols: string[];
  timeframe: Timeframe;
  setupType?: SetupType;
  period: { from: ISODateTime; to: ISODateTime };
  /** Number of trades/setups in the sample. Small samples should be flagged in the UI. */
  sampleSize: number;
  /** Share of trades that reached the first target before the stop, 0–1. */
  hitRate: number;
  averageR: number;
  expectancyR: number;
  maxDrawdownR?: number;
  profitFactor?: number;
  /** Assumed costs, so results can be reproduced. */
  assumptions?: { commissionBps?: number; slippageBps?: number };
  outOfSample?: boolean;
  trades?: BacktestTrade[];
  createdAt: ISODateTime;
}
