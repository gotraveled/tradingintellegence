/**
 * Declared provider capabilities (Phase M1, MARKET_DATA_INTEGRATION_DESIGN §3.1).
 *
 * A capability row is DECLARED configuration — it encodes what the configured
 * entitlement is believed to serve, never what a probe observed. The axis is
 * deliberately separate from the vendor adapter's `supports()`:
 *
 *   capability.markets             — which catalog segments this provider covers
 *   capability.technicalTimeframes — intervals the vendor API can express at all
 *   capability.entitledTimeframes  — intervals the *configured plan* serves
 *   capability.historyLimitDays    — documented history depth limit (from `end`)
 *   capability.classification      — freshness label the entitlement produces
 *   capability.confidence          — how the row's entitlement was established
 *   capability.displayRights       — commercial display/redistribution status
 *
 * When `POLYGON_PLAN` is unset the row defaults to the smoke-tested Basic/EOD
 * surface with `confidence: "inferred"` — inspectable via `getSystemStatus()` and
 * updatable by setting the env, with no engine or UI code touched.
 */
import type {
  DataClassification,
  MarketSegmentId,
  Timeframe,
} from "@/lib/types";

export const POLYGON_PLAN_ENV = "POLYGON_PLAN";

/** Canonical order — the full spec timeframe set, intraday then calendar. */
export const CANONICAL_TIMEFRAMES: readonly Timeframe[] = [
  "1m", "3m", "5m", "15m", "30m",
  "1h", "2h", "4h", "6h", "12h",
  "1D", "1W", "1M",
];

/** Intervals below a day — the axis the EOD entitlement cuts off. */
export const INTRADAY_TIMEFRAMES: readonly Timeframe[] = CANONICAL_TIMEFRAMES.slice(0, 10);
export const CALENDAR_TIMEFRAMES: readonly Timeframe[] = ["1D", "1W", "1M"];

/** How a capability row's entitlement claim was established. */
export type CapabilityConfidence =
  /** Observed evidence — e.g. the vendor's own DELAYED/OK status field. */
  | "verified"
  /** Operator-declared configuration (env) — trusted, not independently checked. */
  | "declared"
  /** Defaulted from observed behavior; not operator-declared. */
  | "inferred";

/** Commercial display/redistribution status — a licensing fact, not a capability. */
export type DisplayRights =
  /** Written authorization exists (exchange/vendor agreement). */
  | "authorized"
  /** Terms explicitly forbid public display (e.g. Kite Connect). */
  | "not_authorized"
  /** Terms unpublished or unverified — never treated as granted. */
  | "unknown";

export interface ProviderCapability {
  /** Matches `MarketDataSource.id` of the wrapped provider. */
  providerId: string;
  /** Catalog market segments this provider can serve at all. */
  markets: readonly MarketSegmentId[];
  /**
   * Timeframes the vendor API can technically express — independent of plan.
   * `entitledTimeframes` is always a subset; anything outside both is an
   * `unsupported_timeframe` at the vendor layer too.
   */
  technicalTimeframes: readonly Timeframe[];
  /** Timeframes the configured entitlement actually serves. The serving gate. */
  entitledTimeframes: readonly Timeframe[];
  /**
   * Documented history-depth limit measured back from the request's `end`
   * (vendors publish "N years of history" relative to now). Undefined → no
   * declared limit; requests pass through.
   */
  historyLimitDays?: number;
  /** Freshness the entitlement produces — the floor when the provider's own
   *  response carries no classification evidence. */
  classification: DataClassification;
  confidence: CapabilityConfidence;
  /**
   * Commercial display status. DECLARED ONLY in M1 — surfaced in status so the
   * licensing state is visible; it becomes a serving gate when a provider whose
   * terms distinguish display rights exists (Phase M3, India).
   */
  displayRights: DisplayRights;
  /** Short human-readable note — where the row came from. */
  note: string;
}

// ---------------------------------------------------------------------------
// Polygon.io (Massive) — capability per published plan.
// Facts are documented in MARKET_DATA_PROVIDER_EVALUATION.md (checked 2026-10-16).

export type PolygonPlanKey = "basic" | "starter" | "developer" | "advanced";

const POLYGON_MARKETS: readonly MarketSegmentId[] = [
  "crypto",
  "forex",
  "commodities",
  "indices",
  "us-stocks",
];

const POLYGON_NOTES: Record<PolygonPlanKey, string> = {
  basic:
    "Basic/EOD entitlement: daily+ aggregates only, ~5 calls/min, provider returns DELAYED status (smoke-tested 2026-10-16).",
  starter:
    "Starter entitlement: intraday aggregates with ~15-minute delay per published plan terms.",
  developer:
    "Developer entitlement: intraday aggregates, delayed, higher rate allowance per published plan terms.",
  advanced:
    "Advanced entitlement: real-time aggregates per published plan terms — REST reads still classify as delayed snapshots, never live.",
};

/**
 * Resolves the configured Polygon plan from env. Unset → the smoke-tested
 * Basic-equivalent surface, marked `inferred` — the dashboard tier has never
 * been confirmed (MARKET_DATA_COVERAGE_DISCOVERY §2).
 */
export function resolvePolygonPlan(
  raw: string | undefined,
): { plan: PolygonPlanKey; confidence: CapabilityConfidence } {
  const key = (raw ?? "").trim().toLowerCase();
  if (key === "basic" || key === "starter" || key === "developer" || key === "advanced") {
    return { plan: key, confidence: "declared" };
  }
  // Unset or unrecognized → infer Basic: the only tier consistent with the
  // observed DELAYED-status / intraday-fragment behavior. Never upgrade on a guess.
  return { plan: "basic", confidence: "inferred" };
}

/** The capability row for Polygon under the given entitlement. */
export function polygonCapability(
  plan: PolygonPlanKey,
  confidence: CapabilityConfidence,
): ProviderCapability {
  const calendarOnly = plan === "basic";
  return {
    providerId: "polygon",
    // NSE/indian-markets is deliberately absent — Polygon has no Indian coverage
    // on any plan, and the adapter rejects it before any request.
    markets: POLYGON_MARKETS,
    technicalTimeframes: CANONICAL_TIMEFRAMES, // every canonical TF maps to a Polygon aggregate
    entitledTimeframes: calendarOnly ? CALENDAR_TIMEFRAMES : CANONICAL_TIMEFRAMES,
    // Intraday history depth is only documented for paid tiers; Basic EOD depth is
    // unverified in our smoke test — no limit declared rather than guessed.
    historyLimitDays: undefined,
    classification: "delayed", // every observed Polygon response reports DELAYED status
    confidence,
    displayRights: "unknown", // redistribution requires a separate vendor agreement
    note: POLYGON_NOTES[plan],
  };
}
