/**
 * ProviderRouter — the multi-vendor composition root (Phase M1,
 * MARKET_DATA_INTEGRATION_DESIGN §2/§3). A single `HistoricalDataProvider` that
 * holds provider+capability entries and enforces the DECLARED capability layer
 * before any vendor call:
 *
 *   getCandles:
 *     1. market routing   — asset.marketId must be a segment the provider covers
 *                           (unknown assets with no marketId pass through to the
 *                           vendor's own supports()).
 *     2. technical TF     — outside `technicalTimeframes` → unsupported_timeframe.
 *     3. entitlement TF   — outside `entitledTimeframes`  → unsupported_timeframe
 *                           (message discloses the confidence of that claim).
 *     4. history window   — before `historyLimitDays`    → data_not_available.
 *     5. vendor call      — result classified from provider evidence first,
 *                           the capability row as fallback.
 *
 * `supports()` answers ONLY the asset axis (does any provider potentially serve
 * this instrument) so request-level axes still produce their precise error
 * codes at getCandles time — a 422 `unsupported_timeframe` never collapses
 * into `unsupported_symbol`.
 *
 * `displayRights` IS enforced here (Phase M2, design §3.10): under a
 * `public` serving scope a row must be `authorized` before any vendor data
 * reaches a response; `unknown`/`not_authorized` fail closed with
 * `display_not_authorized`. Under `internal` scope (dev/test) the row does
 * not block — capability gates (markets/timeframes/history) still apply.
 */
import type { MarketDataRequest, MarketDataSource } from "@/lib/types";
import type { ProviderCapability } from "./capabilities";
import { displayBlock, servingScope, type ServingScope } from "./serving";
import { providerError, type HistoricalDataProvider, type ProviderResponse } from "../provider";

const DAY_MS = 86_400_000;

export interface RoutedProvider {
  provider: HistoricalDataProvider;
  capability: ProviderCapability;
}

/** Does this entry cover the asset's declared market segment? */
function marketCovered(entry: RoutedProvider, request: MarketDataRequest): boolean {
  const marketId = request.asset.marketId;
  // Unknown/bare identifiers carry no segment — the vendor's own supports()
  // decides (unknown US equities must still reach Polygon).
  if (marketId === undefined) return true;
  return entry.capability.markets.includes(marketId as never);
}

export class ProviderRouter implements HistoricalDataProvider {
  private readonly entries: RoutedProvider[];
  private readonly scope: ServingScope;

  constructor(entries: RoutedProvider[], scope: ServingScope = servingScope()) {
    this.entries = entries;
    this.scope = scope;
  }

  get source(): MarketDataSource {
    return (
      this.entries[0]?.provider.source ?? {
        id: "provider-router",
        kind: "rest",
        label: "Market data (routed)",
      }
    );
  }

  /** The declared capability rows — read-only surface for status reporting. */
  capabilities(): readonly ProviderCapability[] {
    return this.entries.map((entry) => entry.capability);
  }

  /** Entries whose capability row covers this asset's market. */
  private candidates(request: MarketDataRequest): RoutedProvider[] {
    return this.entries.filter((entry) => marketCovered(entry, request));
  }

  supports(request: MarketDataRequest): boolean {
    // Asset axis only: a provider exists whose row covers this asset's market
    // AND whose own mapping accepts it (timeframe depth handled in getCandles).
    const candidates = this.candidates(request);
    if (candidates.length === 0) return false;
    return candidates.some((entry) => entry.provider.supports(request));
  }

  async getCandles(request: MarketDataRequest): Promise<ProviderResponse> {
    const candidates = this.candidates(request);
    if (candidates.length === 0) {
      return providerError(
        "unsupported_symbol",
        `symbol '${request.asset.symbol}' is not in any configured provider's market coverage.`,
      );
    }

    // Among the market-eligible providers, find the most capable candidate:
    // prefer one whose vendor accepts the request (ticker maps); otherwise the
    // first row still gives a precise capability error.
    const serving =
      candidates.find((entry) => entry.provider.supports(request)) ?? candidates[0];
    const { capability } = serving;

    // Licensing first (Phase M2): no vendor data reaches a public response
    // without authorized display rights — fail closed, before any traffic.
    const rightsBlock = displayBlock(capability, this.scope);
    if (rightsBlock) return rightsBlock;

    const confidenceNote =
      capability.confidence === "inferred"
        ? ` (entitlement inferred — ${serving.provider.source.id} plan not declared; capability may be narrower than the account)`
        : "";

    if (!capability.technicalTimeframes.includes(request.timeframe)) {
      return providerError(
        "unsupported_timeframe",
        `timeframe '${request.timeframe}' is outside ${serving.provider.source.label}'s interval model.${confidenceNote}`,
      );
    }
    if (!capability.entitledTimeframes.includes(request.timeframe)) {
      return providerError(
        "unsupported_timeframe",
        `timeframe '${request.timeframe}' is not served by the configured ${serving.provider.source.label} entitlement (declared coverage: ${capability.entitledTimeframes.join("/")}).${confidenceNote}`,
      );
    }
    if (!serving.provider.supports(request)) {
      return providerError(
        "unsupported_symbol",
        `symbol '${request.asset.symbol}' is not served by ${serving.provider.source.label}.`,
      );
    }

    if (capability.historyLimitDays !== undefined) {
      const historyStart = request.end - capability.historyLimitDays * DAY_MS;
      if (request.start < historyStart) {
        return providerError(
          "data_not_available",
          `requested window begins before the declared ${capability.historyLimitDays}-day history limit for ${serving.provider.source.label}.${confidenceNote}`,
        );
      }
    }

    const response = await serving.provider.getCandles(request);
    if (!response.ok) return response;

    // Classification: provider-reported evidence wins (Polygon stamps `delayed`
    // from its own DELAYED status); the capability row is the declared floor —
    // a successful request can never upgrade beyond what the entitlement serves.
    const classification = response.result.classification ?? capability.classification;
    return {
      ok: true,
      result: { ...response.result, classification },
    };
  }
}
