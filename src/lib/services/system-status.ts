import {
  getLastProviderConnectivity,
  isProviderConfigured,
} from "@/lib/market-data/providers";
import type { ConnectionStatus } from "@/lib/types";

export interface ServiceStatus {
  id: string;
  name: string;
  description: string;
  status: ConnectionStatus;
}

/**
 * Reports the state of platform dependencies — server-side only (reads env and the
 * in-process provider-health registry). Distinctions preserved:
 *
 *  - `not_configured` — no credentials registered, or the feature is not implemented.
 *  - `unverified`     — credentials exist, but no real provider request has completed.
 *                       A key's presence is never reported as connectivity.
 *  - `connected`      — the most recent real provider request was answered.
 *  - `degraded`       — the most recent real request failed at provider/transport level
 *                       (`provider_error`, `rate_limited`, transport throw).
 *
 * Deliberately NOT represented here: per-request data sufficiency (insufficient
 * history, unsupported symbols/markets) — those are request-level outcomes the API
 * reports via `skipped` and quality payloads, not connectivity. Streaming/live quotes
 * are not implemented and are tracked as a separate service so their absence never
 * downgrades the historical-data status.
 */
export function getSystemStatus(): ServiceStatus[] {
  const configured = isProviderConfigured();
  const observed = getLastProviderConnectivity();

  const marketDataStatus: ConnectionStatus = !configured
    ? "not_configured"
    : observed === undefined
      ? "unverified"
      : observed.ok
        ? "connected"
        : "degraded";

  const marketDataDescription = !configured
    ? "Historical candles — no market-data provider is configured."
    : observed === undefined
      ? "Historical candle aggregates — provider configured; connectivity is verified by the first real request."
      : observed.ok
        ? "Historical candle aggregates via the configured REST provider — last request answered."
        : "Historical candle aggregates — the last provider request failed; the provider may be temporarily unavailable.";

  // The engine is in-process: wired and functional, but every run needs a configured
  // provider — when credentials are absent it degrades rather than pretending to be
  // a disconnected external service.
  const engineStatus: ConnectionStatus = configured ? "connected" : "degraded";
  const engineDescription = configured
    ? "In-process causal engine."
    : "In-process engine — awaits a configured market-data provider.";

  return [
    {
      id: "market-data",
      name: "Market data",
      description: marketDataDescription,
      status: marketDataStatus,
    },
    {
      id: "live-quotes",
      name: "Live quotes",
      description:
        "Streaming quotes are not implemented — analysis and backtests use historical aggregates only.",
      status: "not_configured",
    },
    {
      id: "analysis-engine",
      name: "Analysis engine",
      description: `${engineDescription} Serves /api/analysis.`,
      status: engineStatus,
    },
    {
      id: "backtesting",
      name: "Historical validation",
      description: `${engineDescription} Serves /api/backtest.`,
      status: engineStatus,
    },
    {
      id: "alerts",
      name: "Alert delivery",
      description: "Notification channels for developing and qualified setups.",
      status: "not_configured",
    },
  ];
}

/** `true` only when the provider has been observed reachable — never on credentials alone. */
export function isMarketDataConnected(): boolean {
  return getSystemStatus().some(
    (service) => service.id === "market-data" && service.status === "connected",
  );
}
