import type { Direction, ID, ISODateTime, Price, Score, Timeframe } from "./common";
import type { MarketSegmentId } from "./market";
import type { RegimeLabel } from "./structure";
import type { SetupType } from "./setup";

/**
 * Flattened normalized engine inputs at confirmedAt (docs/engine/17).
 * Namespaced keys ("zone.strength", "mtf.score") for a stable ML schema.
 */
export type FeatureVector = Record<string, number>;

/**
 * Measured result of one setup instance — the labelled row the deterministic engine exists to
 * produce (docs/engine/17). Append-only; a setup never becomes a row before `confirmed`.
 */
export interface SetupOutcome {
  setupId: ID;
  symbol: string;
  market?: MarketSegmentId;
  timeframe: Timeframe;
  setupType: SetupType;
  direction: Direction;

  /** Regime label at confirmedAt — answers "which setups work where" (spec 19). */
  regime?: RegimeLabel;
  scoreAtDetection?: Score;
  scoreAtConfirmation: Score;
  paramsVersion: string;

  /** First-touched price of the entry band; null when the setup never activated. */
  entryPrice?: Price;
  /** |entry − invalidation| at activation, in price. */
  initialRisk?: Price;
  /** Same, in ATR units. */
  riskAtr?: number;
  /** Max favorable excursion in R (mfe / initialRisk), on extremes. */
  mfeR?: number;
  /** Max adverse excursion in R, on extremes. */
  maeR?: number;
  /** Final result in R: weighted targets, −1 on invalidation, 0 unactivated. */
  rMultiple?: number;
  targetsReached: number;
  /** Bars from confirmation to each target hit; null entries = never hit. */
  timeToTarget?: (number | null)[];
  /** Bars from confirmation to the invalidating close; null when not invalidated. */
  timeToInvalidation?: number | null;
  /** Bars from confirmation to activation; null when never activated. */
  barsToActive?: number | null;
  stopReached: boolean;
  expired: boolean;

  /** Flattened normalized inputs at confirmedAt — the ML feature row. */
  featureVector?: FeatureVector;

  confirmedAt: ISODateTime;
  resolvedAt?: ISODateTime;
  /** When a correction re-issues a row, links to the row it replaces. */
  supersedes?: ID;
}
