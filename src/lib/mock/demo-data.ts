/**
 * DEMO DATA — NOT REAL MARKET DATA.
 *
 * Illustrative values used to design and exercise the UI before market-data providers and the
 * analysis engine exist. Prices, scores, and regimes here are invented and must never be presented
 * without a visible "Demo" label. Only `src/lib/services/*` may import this module.
 */
import type {
  DevelopingSetup,
  MarketRegimeSnapshot,
  OpportunitySummary,
  TradePlan,
} from "@/lib/types";

function plan(entry: number, invalidation: number, target: number): TradePlan {
  const risk = Math.abs(entry - invalidation);
  const reward = Math.abs(target - entry);
  return { entry, invalidation, target, riskReward: Math.round((reward / risk) * 10) / 10 };
}

export const DEMO_MARKET_REGIMES: MarketRegimeSnapshot[] = [
  {
    symbol: "BTC",
    name: "Bitcoin",
    assetClass: "crypto",
    direction: "bullish",
    regime: "trending",
    strength: 72,
    timeframe: "1D",
  },
  {
    symbol: "ETH",
    name: "Ethereum",
    assetClass: "crypto",
    direction: "neutral",
    regime: "ranging",
    strength: 41,
    timeframe: "1D",
  },
  {
    symbol: "XAUUSD",
    name: "Gold",
    assetClass: "commodities",
    direction: "bullish",
    regime: "expanding",
    strength: 66,
    timeframe: "4h",
  },
  {
    symbol: "NAS100",
    name: "NASDAQ 100",
    assetClass: "indices",
    direction: "neutral",
    regime: "compressing",
    strength: 38,
    timeframe: "4h",
  },
  {
    symbol: "EURUSD",
    name: "Euro / US Dollar",
    assetClass: "forex",
    direction: "bearish",
    regime: "trending",
    strength: 58,
    timeframe: "1D",
  },
];

export const DEMO_OPPORTUNITIES: OpportunitySummary[] = [
  {
    id: "demo-opp-1",
    symbol: "BTCUSDT",
    assetClass: "crypto",
    setupType: "reversal",
    bias: "bullish",
    stage: "qualified",
    timeframe: "4h",
    score: 82,
    pricePrecision: 0,
    plan: plan(61250, 59800, 65600),
  },
  {
    id: "demo-opp-2",
    symbol: "XAUUSD",
    assetClass: "commodities",
    setupType: "continuation",
    bias: "bullish",
    stage: "qualified",
    timeframe: "1h",
    score: 78,
    pricePrecision: 2,
    plan: plan(2342.5, 2331.0, 2376.0),
  },
  {
    id: "demo-opp-3",
    symbol: "NAS100",
    assetClass: "indices",
    setupType: "breakout",
    bias: "bullish",
    stage: "qualified",
    timeframe: "4h",
    score: 74,
    pricePrecision: 1,
    plan: plan(18420.0, 18265.0, 18830.0),
  },
  {
    id: "demo-opp-4",
    symbol: "EURUSD",
    assetClass: "forex",
    setupType: "reversal",
    bias: "bearish",
    stage: "qualified",
    timeframe: "1h",
    score: 71,
    pricePrecision: 5,
    plan: plan(1.0872, 1.0898, 1.0805),
  },
  {
    id: "demo-opp-5",
    symbol: "ETHUSDT",
    assetClass: "crypto",
    setupType: "continuation",
    bias: "bearish",
    stage: "qualified",
    timeframe: "15m",
    score: 67,
    pricePrecision: 2,
    plan: plan(3020.0, 3058.0, 2925.0),
  },
  {
    id: "demo-opp-6",
    symbol: "NIFTY 50",
    assetClass: "indices",
    setupType: "breakout",
    bias: "bearish",
    stage: "qualified",
    timeframe: "1h",
    score: 63,
    pricePrecision: 1,
    plan: plan(22480.0, 22610.0, 22150.0),
  },
];

export const DEMO_DEVELOPING_SETUPS: DevelopingSetup[] = [
  {
    id: "demo-dev-1",
    symbol: "BTCUSDT",
    assetClass: "crypto",
    setupType: "reversal",
    bias: "bullish",
    timeframe: "4h",
    score: 76,
    conditions: [
      { label: "Higher-timeframe demand", met: true },
      { label: "Liquidity approaching", met: true },
      { label: "Selling momentum weakening", met: true },
      { label: "Liquidity sweep", met: false },
      { label: "CHOCH", met: false },
      { label: "Entry confirmation", met: false },
    ],
  },
  {
    id: "demo-dev-2",
    symbol: "GBPUSD",
    assetClass: "forex",
    setupType: "breakout",
    bias: "bearish",
    timeframe: "1h",
    score: 64,
    conditions: [
      { label: "Range compression", met: true },
      { label: "Key support identified", met: true },
      { label: "Displacement below support", met: false },
      { label: "Retest confirmation", met: false },
    ],
  },
  {
    id: "demo-dev-3",
    symbol: "XAGUSD",
    assetClass: "commodities",
    setupType: "continuation",
    bias: "bullish",
    timeframe: "4h",
    score: 69,
    conditions: [
      { label: "Higher-timeframe uptrend", met: true },
      { label: "Pullback into demand", met: true },
      { label: "Momentum recovery", met: false },
      { label: "Bullish BOS on execution timeframe", met: false },
    ],
  },
];
