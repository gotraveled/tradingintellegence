import type { ConnectionStatus } from "@/lib/types";

export interface ServiceStatus {
  id: string;
  name: string;
  description: string;
  status: ConnectionStatus;
}

/**
 * Reports the state of platform dependencies.
 * In this phase no external services are wired up, so everything reports its true state.
 */
export function getSystemStatus(): ServiceStatus[] {
  return [
    {
      id: "market-data",
      name: "Market data",
      description: "Quotes and historical candles from a market-data provider.",
      status: "not_configured",
    },
    {
      id: "analysis-engine",
      name: "Analysis engine",
      description: "Structure, zone, liquidity, and imbalance detection service.",
      status: "disconnected",
    },
    {
      id: "backtesting",
      name: "Historical validation",
      description: "Backtesting service used to validate setups.",
      status: "disconnected",
    },
    {
      id: "alerts",
      name: "Alert delivery",
      description: "Notification channels for developing and qualified setups.",
      status: "not_configured",
    },
  ];
}

export function isMarketDataConnected() {
  return getSystemStatus().some(
    (service) => service.id === "market-data" && service.status === "connected",
  );
}
