/**
 * Primitive building blocks shared by every domain type.
 * Field names and shapes are chosen to map 1:1 onto backend / database records.
 */

/** Opaque identifier issued by the backend (UUID, ULID, etc.). */
export type ID = string;

/** ISO-8601 UTC date-time string, e.g. "2026-10-12T09:15:00Z". */
export type ISODateTime = string;

/** Unix epoch milliseconds. */
export type UnixMs = number;

/** Price in the instrument's quote currency. */
export type Price = number;

/** Normalised score in the range 0–100. */
export type Score = number;

/**
 * Canonical timeframe set (docs/market-data + docs/engine/01).
 * Minute/hour timeframes have a deterministic duration; "1M" is calendar-based (variable length).
 */
export type Timeframe =
  "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "12h" | "1D" | "1W" | "1M";

/** Directional bias of a setup or signal. */
export type Direction = "bullish" | "bearish";

/** Directional context, which may also be neutral (e.g. ranging markets). */
export type Bias = Direction | "neutral";

export interface Timestamps {
  createdAt: ISODateTime;
  updatedAt?: ISODateTime;
}

/** Free-form, engine-specific attributes. Keeps records extensible without schema churn. */
export type Metadata = Record<string, string | number | boolean | null>;

/**
 * Named, versioned engine parameter set (docs/engine). Flat keys such as "swing.leftBars".
 * Engine outputs record the parameter set used so results are reproducible and comparable.
 */
export interface EngineParams {
  version: string;
  values: Record<string, number | string | boolean>;
}
