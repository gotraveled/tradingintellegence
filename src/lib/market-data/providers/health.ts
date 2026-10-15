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

let lastConnectivity: ProviderConnectivity | undefined;

/** Called by the provider wrapper for every completed request — never for caller-side skips. */
export function recordProviderConnectivity(ok: boolean, at: UnixMs = Date.now()): void {
  lastConnectivity = { ok, at };
}

/** The most recent real observation, or `undefined` when nothing has been seen this process. */
export function getLastProviderConnectivity(): ProviderConnectivity | undefined {
  return lastConnectivity;
}

/** Test seam — restores the "configured but unverified" baseline. */
export function clearProviderConnectivity(): void {
  lastConnectivity = undefined;
}
