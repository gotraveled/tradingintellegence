import {
  configuredCapabilities,
  getLastProviderConnectivity,
  isProviderConfigured,
} from "@/lib/market-data/providers";
import { CANONICAL_TIMEFRAMES } from "@/lib/market-data/providers/capabilities";
import type {
  CapabilityConfidence,
  DisplayRights,
} from "@/lib/market-data/providers/capabilities";
import type { ConnectionStatus, DataClassification, Timeframe } from "@/lib/types";

/** Declared capability facts the UI renders verbatim — never probed, never implied. */
export interface MarketDataAvailability {
  /** Union of entitled timeframes across configured providers, canonical order. */
  timeframes: readonly Timeframe[];
  /** Freshness of the configured feeds — "delayed" dominates "historical". */
  classification?: DataClassification;
  /** The weakest confidence across rows — one inferred row makes the set inferred. */
  confidence?: CapabilityConfidence;
  /** Weakest display-rights state across rows (unknown dominates authorized). */
  displayRights?: DisplayRights;
  /** The providers' own capability notes, joined. */
  note?: string;
}

export interface ServiceStatus {
  id: string;
  name: string;
  description: string;
  status: ConnectionStatus;
  /** Declared capability row — present on the market-data entry only. */
  dataAvailability?: MarketDataAvailability;
}

/** Merge declared capability rows into one UI-safe summary. */
function declaredAvailability(): MarketDataAvailability | undefined {
  const caps = configuredCapabilities();
  if (caps.length === 0) return undefined;
  const timeframes = CANONICAL_TIMEFRAMES.filter((tf) =>
    caps.some((cap) => cap.entitledTimeframes.includes(tf)),
  );
  const classes = new Set(caps.map((cap) => cap.classification));
  const classification: DataClassification = classes.has("delayed")
    ? "delayed"
    : classes.has("live")
      ? "live"
      : "historical";
  const confidence: CapabilityConfidence = caps.some((cap) => cap.confidence === "inferred")
    ? "inferred"
    : caps.some((cap) => cap.confidence === "declared")
      ? "declared"
      : "verified";
  const displayRights: DisplayRights = caps.some((cap) => cap.displayRights === "not_authorized")
    ? "not_authorized"
    : caps.some((cap) => cap.displayRights === "unknown")
      ? "unknown"
      : "authorized";
  const notes = caps.map((cap) => cap.note).filter(Boolean);
  return {
    timeframes,
    classification,
    confidence,
    displayRights,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
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

  const availability = declaredAvailability();
  const entitlementNote =
    availability?.confidence === "inferred"
      ? " Entitlement is inferred (POLYGON_PLAN unset) — the account tier has not been verified."
      : "";

  const marketDataDescription = !configured
    ? "Historical candles — no market-data provider is configured."
    : observed === undefined
      ? `Historical candle aggregates — provider configured; connectivity is verified by the first real request.${entitlementNote}`
      : observed.ok
        ? `Historical candle aggregates via the configured REST provider — last request answered.${entitlementNote}`
        : `Historical candle aggregates — the last provider request failed; the provider may be temporarily unavailable.${entitlementNote}`;

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
      ...(availability !== undefined ? { dataAvailability: availability } : {}),
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

/**
 * The market-data service entry — the single derivation for provider-connectivity
 * badges (topbar, markets, chart capability strip). Callers must render its
 * `status` verbatim: `unverified` means configured-but-never-answered, never
 * connectivity, and a `connected` provider still says nothing about whether a
 * particular instrument has data.
 */
export function getMarketDataStatus(): ServiceStatus {
  const service = getSystemStatus().find((entry) => entry.id === "market-data");
  if (!service) throw new Error("market-data service missing from system status");
  return service;
}
