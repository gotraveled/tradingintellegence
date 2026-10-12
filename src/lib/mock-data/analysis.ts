/**
 * DEMO DATA â€” NOT REAL MARKET DATA. See ./index.ts.
 */
import type { AnalysisSnapshot, Opportunity, Setup } from "@/lib/types";
import { DEMO_OPPORTUNITIES } from "./opportunities";

function opportunity(id: string): Opportunity {
  const found = DEMO_OPPORTUNITIES.find((item) => item.id === id);
  if (!found) throw new Error(`Missing demo opportunity ${id}`);
  return found;
}

function toSetup(opp: Opportunity, id: string): Setup {
  return {
    id,
    symbol: opp.symbol,
    timeframe: opp.timeframe,
    type: opp.setupType,
    direction: opp.direction,
    score: opp.score,
    status: opp.status,
    reasons: opp.reasons ?? [],
    createdAt: opp.createdAt,
    updatedAt: opp.updatedAt,
  };
}

const btc = opportunity("demo-opp-btc-1");
const xau = opportunity("demo-opp-xau-1");

export const DEMO_ANALYSIS: AnalysisSnapshot[] = [
  {
    symbol: "BTCUSDT",
    timeframe: "4h",
    generatedAt: "2026-10-12T08:00:00Z",
    structure: {
      summary:
        "4H is in a corrective downtrend after a lower high. No bullish change of character yet, while the daily structure remains bullish.",
      data: {
        symbol: "BTCUSDT",
        timeframe: "4h",
        trend: "downtrend",
        bias: "bearish",
        swings: [
          {
            kind: "high",
            classification: "LH",
            price: 64900,
            pivotAt: "2026-10-09T12:00:00Z",
            status: "confirmed",
          },
          {
            kind: "low",
            classification: "LL",
            price: 60950,
            pivotAt: "2026-10-11T16:00:00Z",
            status: "confirmed",
          },
        ],
        lastBreak: {
          type: "BOS",
          direction: "bearish",
          price: 61400,
          time: "2026-10-11T12:00:00Z",
          confirmed: true,
        },
        keyLevels: [{ label: "Protected high", price: 64900 }],
        updatedAt: "2026-10-12T08:00:00Z",
      },
    },
    liquidity: {
      summary:
        "Equal lows near 60,200 hold resting sell-side liquidity just above HTF demand. Buy-side liquidity rests at the 64,900 lower high.",
      data: [
        {
          id: "liq-btc-1",
          symbol: "BTCUSDT",
          timeframe: "4h",
          type: "equal_lows",
          side: "sell_side",
          price: 60200,
          status: "approaching",
          occurredAt: "2026-10-10T20:00:00Z",
        },
        {
          id: "liq-btc-2",
          symbol: "BTCUSDT",
          timeframe: "4h",
          type: "swing_high",
          side: "buy_side",
          price: 64900,
          status: "resting",
          occurredAt: "2026-10-09T12:00:00Z",
        },
      ],
    },
    zones: {
      summary:
        "A fresh daily demand zone sits below the equal lows. Overhead, a tested 4H supply zone caps the recovery.",
      data: [
        {
          id: "zone-btc-1",
          symbol: "BTCUSDT",
          timeframe: "1D",
          type: "demand",
          upperPrice: 60400,
          lowerPrice: 59800,
          strength: 78,
          freshness: "fresh",
          retestCount: 0,
          status: "active",
          originAt: "2026-09-24T00:00:00Z",
          createdAt: "2026-09-25T00:00:00Z",
        },
        {
          id: "zone-btc-2",
          symbol: "BTCUSDT",
          timeframe: "4h",
          type: "supply",
          upperPrice: 65200,
          lowerPrice: 64600,
          strength: 64,
          freshness: "tested",
          retestCount: 1,
          status: "active",
          originAt: "2026-10-08T08:00:00Z",
          createdAt: "2026-10-08T12:00:00Z",
        },
      ],
    },
    momentum: {
      summary: "Bearish legs are getting shorter and displacement is fading into demand.",
      data: { state: "weakening", bias: "bearish" },
    },
    setup: toSetup(btc, "demo-setup-btc-1"),
    opportunity: btc,
  },
  {
    symbol: "XAUUSD",
    timeframe: "1h",
    generatedAt: "2026-10-12T09:00:00Z",
    structure: {
      summary:
        "Clean 4H uptrend with consecutive higher highs and higher lows. 1H printed a bullish BOS after the pullback.",
      data: {
        symbol: "XAUUSD",
        timeframe: "1h",
        trend: "uptrend",
        bias: "bullish",
        swings: [
          {
            kind: "low",
            classification: "HL",
            price: 2329.4,
            pivotAt: "2026-10-11T14:00:00Z",
            status: "confirmed",
          },
          {
            kind: "high",
            classification: "HH",
            price: 2356.8,
            pivotAt: "2026-10-12T02:00:00Z",
            status: "confirmed",
          },
        ],
        lastBreak: {
          type: "BOS",
          direction: "bullish",
          price: 2348.2,
          time: "2026-10-12T07:00:00Z",
          confirmed: true,
        },
        updatedAt: "2026-10-12T09:00:00Z",
      },
    },
    liquidity: {
      summary: "Buy-side liquidity rests above the 2,356.8 high, the natural first objective.",
      data: [
        {
          id: "liq-xau-1",
          symbol: "XAUUSD",
          timeframe: "1h",
          type: "swing_high",
          side: "buy_side",
          price: 2356.8,
          status: "resting",
          occurredAt: "2026-10-12T02:00:00Z",
        },
      ],
    },
    zones: {
      summary: "Price reacted from a fresh 1H demand zone formed by the last impulse.",
      data: [
        {
          id: "zone-xau-1",
          symbol: "XAUUSD",
          timeframe: "1h",
          type: "demand",
          upperPrice: 2338.5,
          lowerPrice: 2332.0,
          strength: 72,
          freshness: "tested",
          retestCount: 1,
          status: "active",
          originAt: "2026-10-11T22:00:00Z",
          createdAt: "2026-10-11T23:00:00Z",
        },
      ],
    },
    momentum: {
      summary: "Momentum recovered in trend direction after the pullback.",
      data: { state: "strengthening", bias: "bullish" },
    },
    setup: toSetup(xau, "demo-setup-xau-1"),
    opportunity: xau,
  },
];
