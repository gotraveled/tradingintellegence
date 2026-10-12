import type { Direction, ID, Price, Score, Timeframe, UnixMs } from "./common";
import type { PriceTarget } from "./opportunity";
import type { ProbabilityEstimate } from "./statistics";
import type {
  OpportunityScoreResult,
  ScoreContribution,
  Setup,
  SetupReason,
  SetupStatus,
  SetupType,
} from "./setup";

/**
 * Spec 25 — Scanner: opportunity discovery & ranking. The scanner is a downstream consumer of
 * caller-produced point-in-time artifacts — it never receives candles and never recomputes any
 * upstream stage.
 */

/** Declared scan extent — the caller owns population; the engine never discovers symbols. */
export interface ScanUniverse {
  symbols: string[];
  timeframes: Timeframe[];
}

/**
 * Narrowing dims for one scan — the `ScanRequest` filter surface, domain-owned so the engine
 * layer stays dependency-free (a `ScanRequest` is directly assignable: every field here is
 * optional and `timeframes` is required there). Absent dim = unconstrained. `markets`/
 * `assetClasses` are deliberately absent — candidates carry no market identity, so market
 * scoping belongs to universe construction, never to a silently-ignored filter dim.
 */
export interface ScanFilters {
  symbols?: string[];
  timeframes?: Timeframe[];
  setupTypes?: SetupType[];
  directions?: Direction[];
  /** Filters `setup.status` — e.g. ["active"] shows only activated opportunities. */
  statuses?: SetupStatus[];
  minScore?: number;
}

/** Declared causal anchor — stamped by the producer, validated (not verified) by the scanner. */
export interface ScanProvenance {
  evaluatedAt: UnixMs;
  evaluatedBar?: number;
}

/** Caller-produced spec-24 evidence — passes through verbatim, incl. its version stamps. */
export interface StatisticalEvidence {
  /** The τ the caller gated history at — validated against the scan's `asOf`. */
  decisionTime: UnixMs;
  estimate?: ProbabilityEstimate;
  unavailable?: "insufficient_data";
}

/** Spec-16 plan fields, projected — `targets` reuses the existing `PriceTarget` shape. */
export interface ScanPlan {
  entry?: Price;
  stopLoss?: Price;
  targets?: PriceTarget[];
  riskReward?: number;
}

/**
 * One caller-produced PIT artifact — the scanner's only data. `setup`/`score` are upstream
 * outputs verbatim; provenance is the declared evaluation anchor the scan validates.
 */
export interface ScanCandidate {
  setup: Setup;
  score: OpportunityScoreResult;
  plan?: ScanPlan;
  cell: { symbol: string; timeframe: Timeframe };
  provenance?: ScanProvenance;
  statisticalEvidence?: StatisticalEvidence;
}

/** A ranked opportunity — a projection of produced artifacts, never re-derived. */
export interface ScannedOpportunity {
  rank: number;
  setupId: ID;
  symbol: string;
  timeframe: Timeframe;
  setupType: SetupType;
  direction: Direction;
  status: SetupStatus;
  score: Score;
  scoreContributions?: ScoreContribution[];
  entry?: Price;
  stopLoss?: Price;
  targets?: PriceTarget[];
  riskReward?: number;
  reasons?: SetupReason[];
  statisticalEvidence?: StatisticalEvidence;
}

/** Informational, unranked developing setup — identity + what's missing, nothing more. */
export interface SetupRef {
  setupId: ID;
  symbol: string;
  timeframe: Timeframe;
  setupType: SetupType;
  direction: Direction;
  /** Unmet conditions only (`met === false`) — "what's missing" per spec 11. */
  reasons?: SetupReason[];
  evaluatedAt?: UnixMs;
}

/** One scan's total-order result — comparable only within its version stamps. */
export interface ScanResult {
  asOf: UnixMs;
  universe: ScanUniverse;
  filters?: ScanFilters;
  ranked: ScannedOpportunity[];
  developing: SetupRef[];
  methodVersion: string;
  paramsVersion: string;
}
