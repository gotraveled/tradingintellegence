import type { Bias, Direction, ID, ISODateTime, Metadata, Price, Score, Timeframe } from "./common";
import type { AssetClass } from "./market";

/**
 * HH = higher high, HL = higher low, LH = lower high, LL = lower low.
 * EH/EL = equal high/low (within classifyToleranceAtr) — liquidity cluster, not trend info.
 */
export type SwingType = "HH" | "HL" | "LH" | "LL" | "EH" | "EL";

export type SwingKind = "high" | "low";

/**
 * Lifecycle per docs/engine/02-swing-detection.md:
 * developing (candidate, unconfirmed) → confirmed → invalidated.
 * "superseded" candidates are diagnostics only and are never emitted as swings.
 */
export type SwingStatus = "developing" | "confirmed" | "superseded" | "invalidated";

export interface SwingPoint {
  /** Deterministic id derived from symbol/timeframe/kind/pivot time — never random. */
  id?: ID;
  symbol?: string;
  timeframe?: Timeframe;
  /** Whether the pivot is a high or a low — intrinsic. */
  kind: SwingKind;
  /**
   * HH/HL/LH/LL relative to the previous confirmed swing of the same kind.
   * Assigned by structure detection; absent until classified.
   */
  classification?: SwingType;
  price: Price;
  /** Bar index of the extreme in the source series. */
  pivotIndex?: number;
  /** Open time of the pivot bar. */
  pivotAt: ISODateTime;
  /** First bar index at which the swing was knowable (no look-ahead). */
  confirmedIndex?: number;
  confirmedAt?: ISODateTime;
  status?: SwingStatus;
  invalidatedAt?: ISODateTime;
  metadata?: Metadata;
}

/** BOS = break of structure (continuation), CHOCH = change of character (potential reversal). */
export type StructureBreakType = "BOS" | "CHOCH";

export interface StructureBreak {
  /** Deterministic id — symbol/timeframe/type/direction/ref-swing/break time. Never random. */
  id?: ID;
  type: StructureBreakType;
  direction: Direction;
  price: Price;
  time: ISODateTime;
  /** Whether the break was confirmed by a candle close beyond the level. */
  confirmed: boolean;
  /** Swing whose level was broken. */
  refSwingId?: ID;
  /** Level that was broken (the reference swing's price). */
  refPrice?: Price;
  /** Bar index of the breaking close. */
  breakIndex?: number;
  /** Trend state before/after the event. */
  structureBefore?: TrendState;
  structureAfter?: TrendState;
  /**
   * Price closed back inside the broken level within `structure.failedBreakBars`.
   * The break still happened — `failed` marks its assessment, not the event (spec 03).
   */
  failed?: boolean;
  failedAt?: ISODateTime;
}

export type TrendState = "uptrend" | "downtrend" | "range" | "transition";

export interface MarketStructure {
  symbol: string;
  timeframe: Timeframe;
  trend: TrendState;
  bias: Bias;
  swings: SwingPoint[];
  lastBreak?: StructureBreak;
  /** All confirmed breaks in chronological order — `lastBreak` is the tail. */
  breaks?: StructureBreak[];
  /** Key levels derived from structure (e.g. last protected high/low). */
  keyLevels?: { label: string; price: Price }[];
  updatedAt: ISODateTime;
}

/**
 * Engine regime label (docs/engine/19) — direction + volatility collapsed to one state by
 * precedence. Distinct from `MarketRegime` (the UI's snapshot taxonomy, unchanged).
 */
export type RegimeLabel =
  | "trending_bullish"
  | "trending_bearish"
  | "ranging"
  | "high_volatility"
  | "low_volatility"
  | "transition";

export type MarketRegime = "trending" | "ranging" | "compressing" | "expanding";

export interface MarketRegimeSnapshot {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  direction: Bias;
  regime: MarketRegime;
  /** Regime strength, 0–100. */
  strength: Score;
  timeframe: Timeframe;
}
