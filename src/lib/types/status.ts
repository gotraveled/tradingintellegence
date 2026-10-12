/**
 * Semantic tones used across the UI.
 * bullish = positive, bearish = negative, developing = warning / forming,
 * neutral = informational, inactive = unavailable.
 */
export type Tone = "bullish" | "bearish" | "developing" | "neutral" | "inactive";

export type ConnectionStatus = "connected" | "degraded" | "disconnected" | "not_configured";

export type ModuleAvailability = "available" | "preview" | "planned";
