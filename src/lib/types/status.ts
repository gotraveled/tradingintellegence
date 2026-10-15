/**
 * Semantic tones used across the UI.
 * bullish = positive, bearish = negative, developing = warning / forming,
 * neutral = informational, inactive = unavailable.
 */
export type Tone = "bullish" | "bearish" | "developing" | "neutral" | "inactive";

/**
 * connected       — last real interaction succeeded.
 * degraded        — last real interaction failed at the service/transport level.
 * disconnected    — wired but not reachable (no recent success).
 * unverified      — configured, but no real interaction has verified reachability yet.
 *                   A credential's existence alone is never reported as connectivity.
 * not_configured  — nothing to connect: no credentials, or the feature isn't implemented.
 */
export type ConnectionStatus =
  | "connected"
  | "degraded"
  | "disconnected"
  | "unverified"
  | "not_configured";

export type ModuleAvailability = "available" | "preview" | "planned";
