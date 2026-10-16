import { ConnectionBadge } from "@/components/ui/status";
import type { ServiceStatus } from "@/lib/services/system-status";

/**
 * Compact capability strip above the chart toolbar — renders the server-derived
 * `getSystemStatus()` facts for the capabilities that govern this surface.
 *
 * Honesty contract:
 * - `unverified` means credentials exist but no real request has completed —
 *   rendered as "Configured", never as connectivity or "live".
 * - `connected` means the last real request was answered — it says nothing
 *   about whether a specific instrument has data (that's the per-request
 *   `skipped`/empty-state contract).
 * - Live quotes are a separate service — their absence is shown, not hidden.
 * - `dataAvailability` is the DECLARED capability row: entitled timeframes,
 *   classification (delayed/historical — never "live"), and whether that
 *   entitlement is verified or merely inferred.
 */
const CLASSIFICATION_LABEL: Record<string, string> = {
  historical: "Historical",
  delayed: "Delayed",
};

export function ChartCapabilityStrip({ services }: { services: ServiceStatus[] }) {
  const marketData = services.find((service) => service.id === "market-data");
  const liveQuotes = services.find((service) => service.id === "live-quotes");
  const availability = marketData?.dataAvailability;

  return (
    <dl
      aria-label="Data capabilities"
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border px-4 py-2 text-[11px]"
    >
      {marketData ? (
        <div className="flex items-center gap-1.5">
          <dt className="text-subtle-foreground">Market data</dt>
          <dd className="flex items-center gap-2">
            <ConnectionBadge status={marketData.status} />
            {availability?.classification !== undefined ? (
              <span className="rounded border border-border px-1 py-px text-[10px] font-medium text-muted-foreground">
                {CLASSIFICATION_LABEL[availability.classification] ?? availability.classification}
                {availability.confidence === "inferred" ? " · unverified plan" : ""}
              </span>
            ) : null}
            <span className="hidden text-subtle-foreground md:inline" title={marketData.description}>
              {marketData.description}
            </span>
          </dd>
        </div>
      ) : null}
      {liveQuotes ? (
        <div className="flex items-center gap-1.5">
          <dt className="text-subtle-foreground">Live quotes</dt>
          <dd>
            <ConnectionBadge status={liveQuotes.status} />
          </dd>
        </div>
      ) : null}
      <dd className="ml-auto text-subtle-foreground">
        {availability !== undefined
          ? `Declared coverage: ${availability.timeframes.join(" · ")}${availability.displayAllowed ? "" : " · public display blocked (rights not established)"}`
          : "Candles and analysis are historical aggregates — never live quotes."}
      </dd>
    </dl>
  );
}
