/**
 * Configured-provider bootstrap — server-side only (reads `process.env`, holds the API
 * key). The registry lets tests/bootstrap inject a provider explicitly; production derives
 * one from the environment.
 *
 * Missing `POLYGON_API_KEY` → `createConfiguredProvider()` returns `undefined` — the
 * honest "market-data provider unavailable" state the backtest path already surfaces.
 * There is deliberately no fallback to fixtures or demo data here.
 */
import type { HistoricalDataProvider } from "../provider";
import type { MarketDataErrorCode } from "@/lib/types";
import { PolygonProvider } from "./polygon";
import { recordProviderConnectivity } from "./health";

export { getLastProviderConnectivity, clearProviderConnectivity } from "./health";

export const MARKET_DATA_KEY_ENV = "POLYGON_API_KEY";
export const MARKET_DATA_BASE_URL_ENV = "MARKET_DATA_BASE_URL";

let configuredProvider: HistoricalDataProvider | undefined;

/**
 * Registers the provider the backtest route uses — for tests and future bootstrap code.
 * `undefined` restores the unregistered (unavailable) state.
 */
export function setConfiguredProvider(provider: HistoricalDataProvider | undefined): void {
  configuredProvider = provider;
}

export function getConfiguredProvider(): HistoricalDataProvider | undefined {
  return configuredProvider;
}

/**
 * `true` when a provider is registered or env credentials exist. This says nothing
 * about reachability — a key is not a connection; see `getLastProviderConnectivity`.
 */
export function isProviderConfigured(): boolean {
  return configuredProvider !== undefined || Boolean(process.env[MARKET_DATA_KEY_ENV]);
}

/**
 * Error codes that mean the provider *answered* — request/data-level failures that
 * surface to callers as `skipped` or per-cell quality, NOT connectivity evidence.
 * `provider_error` and `rate_limited` (and any thrown transport error) are the only
 * outcomes treated as connectivity failures.
 */
const NON_CONNECTIVITY_CODES: ReadonlySet<MarketDataErrorCode> = new Set([
  "invalid_request",
  "unsupported_symbol",
  "unsupported_timeframe",
  "data_not_available",
  "invalid_data",
  "incomplete_data",
]);

/**
 * Wraps a provider so each real request records its connectivity outcome — no probes
 * and no extra traffic; status reporting rides on traffic that already happens.
 */
export function observeProviderHealth(inner: HistoricalDataProvider): HistoricalDataProvider {
  return {
    source: inner.source,
    supports: (request) => inner.supports(request),
    getCandles: async (request) => {
      try {
        const res = await inner.getCandles(request);
        recordProviderConnectivity(res.ok || NON_CONNECTIVITY_CODES.has(res.error.code));
        return res;
      } catch (err) {
        recordProviderConnectivity(false);
        throw err;
      }
    },
  };
}

/**
 * Builds the production provider from the environment. Returns `undefined` when no
 * credentials are configured — callers surface that as `ServiceUnavailableError`.
 * Explicitly-set registry providers take precedence (test/bootstrap seam).
 * The env-built provider is health-wrapped so real requests update last-observed
 * connectivity; the injected registry provider is not (tests control their own state).
 */
export function createConfiguredProvider(): HistoricalDataProvider | undefined {
  if (configuredProvider !== undefined) return configuredProvider;
  const apiKey = process.env[MARKET_DATA_KEY_ENV];
  if (!apiKey) return undefined;
  return observeProviderHealth(
    new PolygonProvider({
      apiKey,
      baseUrl: process.env[MARKET_DATA_BASE_URL_ENV],
    }),
  );
}
