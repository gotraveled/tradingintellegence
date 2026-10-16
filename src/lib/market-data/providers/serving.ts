/**
 * Serving-scope contract (Phase M2 — design §3.10 enforcement).
 *
 * The repository had no production/public-serving boundary — this is the
 * smallest safe contract that creates one, deliberately narrow:
 *
 *   scope = "public"   — data responses reach public-facing UI surfaces
 *                        (charts, scanner, analysis panels). A provider may
 *                        only serve when its capability row is
 *                        `displayRights: "authorized"`. `unknown` and
 *                        `not_authorized` fail CLOSED — technical access is
 *                        never treated as display authorization.
 *   scope = "internal" — development/test/internal-operation reads.
 *                        Capability rows still gate markets/timeframes/history;
 *                        display rights do not block the read, so brokers'
 *                        personal-use APIs stay usable where their terms permit
 *                        internal use. This is a serving-mode distinction, not
 *                        a license.
 *
 * Resolution order (first match wins):
 *   1. `MARKET_DATA_SERVING=public|internal` — the DOCUMENTED operator switch.
 *      `.env.example` declares it; this is the only bypass and it is explicit.
 *   2. `NODE_ENV=production` → "public" (fail closed by default).
 *   3. otherwise → "internal" (dev/test).
 *
 * Evidence required to mark a row `displayRights: "authorized"` (all of):
 *   - a written vendor/exchange agreement explicitly covering commercial
 *     display or redistribution on the deployed surface, and
 *   - the agreement reference recorded in the capability row's `note` so the
 *     basis is auditable.
 * A paid subscription, a valid API key, or successful vendor responses are
 * technical access — none of them is display authorization.
 */
import type { ProviderCapability } from "./capabilities";
import { providerError, type ProviderResponse } from "../provider";

export const SERVING_SCOPE_ENV = "MARKET_DATA_SERVING";

export type ServingScope = "public" | "internal";

/** Resolve the serving scope from explicit env, falling back to NODE_ENV. */
export function resolveServingScope(
  raw: string | undefined,
  nodeEnv: string | undefined,
): ServingScope {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "public" || value === "internal") return value;
  return nodeEnv === "production" ? "public" : "internal";
}

/** The scope this process serves under — reads the deployment env. */
export function servingScope(): ServingScope {
  return resolveServingScope(process.env[SERVING_SCOPE_ENV], process.env.NODE_ENV);
}

/**
 * The rights gate. Returns a blocking ProviderResponse when the capability row
 * does not authorize serving under `scope`; `undefined` when serving may
 * proceed. `displayRights` is data, not a comment — this is the enforcement.
 */
export function displayBlock(
  capability: ProviderCapability,
  scope: ServingScope,
): ProviderResponse | undefined {
  if (scope === "internal") return undefined; // dev/test/internal reads unaffected
  if (capability.displayRights === "authorized") return undefined;
  const basis =
    capability.displayRights === "not_authorized"
      ? "its terms do not permit public display"
      : "public-display authorization has not been established";
  return providerError(
    "display_not_authorized",
    `public display of ${capability.providerId} data is not available — ${basis}. ` +
      "Commercial display requires a written vendor/exchange agreement recorded in the " +
      "capability row; a paid plan or working API key is not display authorization.",
  );
}
