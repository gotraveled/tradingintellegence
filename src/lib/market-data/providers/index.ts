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
import { PolygonProvider } from "./polygon";

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
 * Builds the production provider from the environment. Returns `undefined` when no
 * credentials are configured — callers surface that as `ServiceUnavailableError`.
 * Explicitly-set registry providers take precedence (test/bootstrap seam).
 */
export function createConfiguredProvider(): HistoricalDataProvider | undefined {
  if (configuredProvider !== undefined) return configuredProvider;
  const apiKey = process.env[MARKET_DATA_KEY_ENV];
  if (!apiKey) return undefined;
  return new PolygonProvider({
    apiKey,
    baseUrl: process.env[MARKET_DATA_BASE_URL_ENV],
  });
}
