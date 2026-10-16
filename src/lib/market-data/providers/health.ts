/**
 * Last-observed provider connectivity — passive health, never a probe.
 *
 * Status reporting must not fabricate connectivity from credentials alone, and it must
 * not issue provider calls just to report status. Instead the production provider is
 * wrapped (see `observeProviderHealth` in `index.ts`) so real requests record their
 * outcome here; the status service reports "configured, unverified" until the first
 * observation exists.
 */
import type { UnixMs } from "@/lib/types";

export interface ProviderConnectivity {
  /**
   * `true` — the provider answered (a success, or a request/data-level error such as
   * `unsupported_symbol` or `data_not_available`). `false` — the request failed at the
   * provider/transport level (`provider_error`, `rate_limited`, or a thrown error).
   */
  ok: boolean;
  /** Observation time on the server clock. */
  at: UnixMs;
}

/** Per-provider observations keyed by `MarketDataSource.id` — a routed deployment
 *  never lets one vendor's failure mislabel another's. `latest` mirrors the most
 *  recent observation overall for the single-provider status path. */
const byProvider = new Map<string, ProviderConnectivity>();
let latest: ProviderConnectivity | undefined;

/** Called by the provider wrapper for every completed request — never for caller-side skips. */
export function recordProviderConnectivity(
  ok: boolean,
  at: UnixMs = Date.now(),
  sourceId?: string,
): void {
  const entry: ProviderConnectivity = { ok, at };
  latest = entry;
  if (sourceId !== undefined) byProvider.set(sourceId, entry);
}

/** The most recent real observation, or `undefined` when nothing has been seen this process. */
export function getLastProviderConnectivity(): ProviderConnectivity | undefined {
  return latest;
}

/** The last observation for one provider id — undefined when it never answered. */
export function getProviderConnectivity(sourceId: string): ProviderConnectivity | undefined {
  return byProvider.get(sourceId);
}

/** Test seam — restores the "configured but unverified" baseline. */
export function clearProviderConnectivity(): void {
  byProvider.clear();
  latest = undefined;
}
