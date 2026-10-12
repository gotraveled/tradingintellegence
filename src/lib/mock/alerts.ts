/**
 * DEMO DATA — NOT REAL ALERTS. See ./index.ts.
 */
import type { Alert, AlertEvent } from "@/lib/types";

export const DEMO_ALERTS: Alert[] = [
  {
    id: "demo-alert-1",
    name: "Crypto developing reversals",
    params: { type: "developing_setup" },
    scope: { markets: ["crypto"], minScore: 70 },
    channels: ["in_app"],
    status: "active",
    lastTriggeredAt: "2026-10-12T08:00:00Z",
    createdAt: "2026-10-01T10:00:00Z",
  },
  {
    id: "demo-alert-2",
    name: "Gold confirmed continuations",
    params: { type: "confirmed_continuation" },
    scope: { symbols: ["XAUUSD"], timeframes: ["1h", "4h"] },
    channels: ["in_app", "email"],
    status: "active",
    lastTriggeredAt: "2026-10-12T09:00:00Z",
    createdAt: "2026-10-03T10:00:00Z",
  },
  {
    id: "demo-alert-3",
    name: "BTC approaching daily demand",
    params: { type: "zone_approach", zoneType: "demand", proximityPct: 0.5 },
    scope: { symbols: ["BTCUSDT"], timeframes: ["1D"] },
    channels: ["in_app"],
    status: "active",
    createdAt: "2026-10-05T10:00:00Z",
  },
  {
    id: "demo-alert-4",
    name: "Index breakouts 75+",
    params: { type: "confirmed_breakout" },
    scope: { markets: ["indices", "indian-markets"], minScore: 75 },
    channels: ["webhook"],
    status: "paused",
    createdAt: "2026-10-06T10:00:00Z",
  },
];

export const DEMO_ALERT_EVENTS: AlertEvent[] = [
  {
    id: "demo-evt-1",
    alertId: "demo-alert-2",
    type: "confirmed_continuation",
    symbol: "XAUUSD",
    timeframe: "1h",
    message: "Bullish continuation confirmed after BOS on 15m.",
    opportunityId: "demo-opp-xau-1",
    triggeredAt: "2026-10-12T09:00:00Z",
  },
  {
    id: "demo-evt-2",
    alertId: "demo-alert-1",
    type: "developing_setup",
    symbol: "BTCUSDT",
    timeframe: "4h",
    message: "Potential bullish reversal developing (3 of 6 conditions met).",
    opportunityId: "demo-opp-btc-1",
    triggeredAt: "2026-10-12T08:00:00Z",
    read: true,
  },
  {
    id: "demo-evt-3",
    alertId: "demo-alert-1",
    type: "invalidation_reached",
    symbol: "USDJPY",
    timeframe: "4h",
    message: "Bullish breakout invalidated — price closed below invalidation.",
    opportunityId: "demo-opp-jpy-1",
    triggeredAt: "2026-10-11T04:00:00Z",
    read: true,
  },
  {
    id: "demo-evt-4",
    alertId: "demo-alert-2",
    type: "target_reached",
    symbol: "MSFT",
    timeframe: "1D",
    message: "Final target T2 reached.",
    opportunityId: "demo-opp-msft-1",
    triggeredAt: "2026-10-08T20:00:00Z",
    read: true,
  },
];
