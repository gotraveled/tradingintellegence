/**
 * DEMO DATA — NOT REAL MARKET DATA OR REAL BACKTEST RESULTS. See ./index.ts.
 */
import type { BacktestResult, BacktestTrade, BacktestTradeOutcome, Strategy } from "@/lib/types";

export const DEMO_STRATEGIES: Strategy[] = [
  {
    id: "strat-htf-reversal",
    name: "HTF Demand Reversal",
    description: "Reversal from higher-timeframe demand after a liquidity sweep and CHOCH.",
    setupType: "reversal",
    rules: [
      {
        id: "r1",
        category: "supply_demand",
        label: "Price in HTF demand / supply",
        required: true,
      },
      { id: "r2", category: "liquidity", label: "Liquidity sweep", required: true },
      {
        id: "r3",
        category: "market_structure",
        label: "CHOCH on execution timeframe",
        required: true,
      },
      { id: "r4", category: "multi_timeframe", label: "HTF bias aligned", required: false },
    ],
    createdAt: "2026-09-01T00:00:00Z",
  },
  {
    id: "strat-compression-breakout",
    name: "Compression Breakout",
    description: "Breakout from multi-session compression with displacement and retest.",
    setupType: "breakout",
    rules: [
      { id: "r1", category: "momentum", label: "Compression", required: true },
      { id: "r2", category: "market_structure", label: "Key level", required: true },
      { id: "r3", category: "momentum", label: "Displacement", required: true },
      { id: "r4", category: "market_structure", label: "Retest holds", required: false },
    ],
    createdAt: "2026-09-01T00:00:00Z",
  },
  {
    id: "strat-trend-pullback",
    name: "Trend Pullback Continuation",
    description: "Pullback into a zone inside an established trend, entered on momentum recovery.",
    setupType: "continuation",
    rules: [
      { id: "r1", category: "market_structure", label: "Established trend", required: true },
      { id: "r2", category: "supply_demand", label: "Pullback into zone", required: true },
      { id: "r3", category: "momentum", label: "Momentum recovery", required: true },
    ],
    createdAt: "2026-09-01T00:00:00Z",
  },
];

/** Deterministic pseudo-random generator so demo output is stable between renders. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function buildTrades(count: number): BacktestTrade[] {
  const random = seeded(42);
  const start = Date.parse("2025-10-01T00:00:00Z");
  return Array.from({ length: count }, (_, index) => {
    const roll = random();
    let outcome: BacktestTradeOutcome;
    let resultR: number;
    if (roll < 0.44) {
      outcome = "target";
      resultR = Math.round((1.4 + random() * 1.8) * 10) / 10;
    } else if (roll < 0.9) {
      outcome = "stop";
      resultR = -1;
    } else if (roll < 0.96) {
      outcome = "breakeven";
      resultR = 0;
    } else {
      outcome = "timeout";
      resultR = Math.round((random() * 0.8 - 0.3) * 10) / 10;
    }
    const entryAt = new Date(start + index * 7 * 86_400_000).toISOString();
    const exitAt = new Date(start + index * 7 * 86_400_000 + 2 * 86_400_000).toISOString();
    return {
      id: `demo-trade-${index + 1}`,
      symbol: "DEMO",
      direction: random() > 0.5 ? "bullish" : "bearish",
      entryAt,
      exitAt,
      entry: 100,
      exit: 100 + resultR,
      resultR,
      outcome,
    };
  });
}

function summarize(trades: BacktestTrade[]) {
  const wins = trades.filter((trade) => trade.resultR > 0);
  const losses = trades.filter((trade) => trade.resultR < 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.resultR, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.resultR, 0));
  const total = trades.reduce((sum, trade) => sum + trade.resultR, 0);

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of trades) {
    equity += trade.resultR;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
  return {
    sampleSize: trades.length,
    hitRate: round(wins.length / trades.length, 3),
    averageR: round(total / trades.length),
    expectancyR: round(total / trades.length),
    profitFactor: grossLoss === 0 ? undefined : round(grossWin / grossLoss),
    maxDrawdownR: round(maxDrawdown, 1),
  };
}

const TRADES = buildTrades(48);

export const DEMO_BACKTEST_RESULT: BacktestResult = {
  id: "demo-backtest-1",
  strategyId: "strat-htf-reversal",
  symbols: ["DEMO"],
  timeframe: "4h",
  setupType: "reversal",
  period: { from: "2025-10-01T00:00:00Z", to: "2026-09-30T00:00:00Z" },
  ...summarize(TRADES),
  assumptions: { commissionBps: 5, slippageBps: 5 },
  outOfSample: false,
  trades: TRADES,
  createdAt: "2026-10-12T08:00:00Z",
};
