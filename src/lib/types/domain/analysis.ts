import type { BacktestDeveloping, BacktestOpportunity } from "./backtest-system";
import type { Bias, ISODateTime, Score, Timeframe, UnixMs } from "./common";
import type { LiquidityEvent } from "./liquidity";
import type {
  AssetIdentifier,
  DataQualityReport,
  MarketDataSource,
  MarketSegmentId,
} from "./market";
import type { Opportunity } from "./opportunity";
import type { Setup, SetupType } from "./setup";
import type { MarketStructure } from "./structure";
import type { Zone } from "./zone";

export type MomentumState = "strengthening" | "weakening" | "neutral" | "diverging";

/**
 * Momentum feature set (docs/engine/09). Small, ATR-normalised, closed-bars-only.
 * Optional secondary features (e.g. RSI) exist for display/ML — no rule may depend on them.
 */
export interface MomentumFeatures {
  /** Signed Σ(close−open) over lookback ÷ ATR — net initiative in ATR units. */
  directionalMove?: number;
  /** (close[t] − close[t−n]) ÷ ATR — ATR-normalised rate of change. */
  rateOfChange?: number;
  /** ATR(14) now ÷ ATR(14) 20 bars ago — expansion/compression. */
  atrTrend?: number;
  /** Mean |close−open| ÷ ATR over lookback. */
  bodyStrength?: number;
  /** Current run of same-direction closes, signed. */
  consecDirection?: number;
  /** 5-bar mean volume ÷ 20-bar mean — absent where volume is unreliable. */
  volumeRatio?: number;
  /** Secondary only — display/ML, never decision input. */
  rsi14?: number;
}

export interface Momentum {
  state: MomentumState;
  bias: Bias;
  /** 0–100 conviction score for the last measured leg (docs/engine/09 Part A). */
  displacementScore?: Score;
  features?: MomentumFeatures;
}

/** Per-timeframe directional vote: +1 bullish, −1 bearish, 0 neutral/transition. */
export type MtfVote = -1 | 0 | 1;

/**
 * Named confluence/conflict states (docs/engine/10 truth table).
 * `realigning_*` and `countertrend_*` are watch states — never a directional bias.
 */
export type MtfAlignmentState =
  | "aligned_bull"
  | "aligned_bear"
  | "pullback_in_trend_bull"
  | "pullback_in_trend_bear"
  | "realigning_bull"
  | "realigning_bear"
  | "countertrend_bull"
  | "countertrend_bear"
  | "htf_dominant"
  | "ltf_directed"
  | "no_context"
  | "neutral";

/** Multi-timeframe combination output (docs/engine/10). Recomputed, never persisted as truth. */
export interface MultiTimeframeAlignment {
  symbol: string;
  /** The timeframe set, e.g. { htf: "4h", itf: "1h", etf: "15m" }. */
  timeframes: { htf: Timeframe; itf: Timeframe; etf: Timeframe };
  votes: { htf: MtfVote; itf: MtfVote; etf: MtfVote };
  /** Which stage supplied each non-zero vote — "the stage that defined it" (spec 10). */
  sources?: { htf?: "structure" | "momentum"; itf?: "structure" | "momentum"; etf?: "structure" | "momentum" };
  /** 0.5·htf + 0.3·itf + 0.2·etf, in [−1, 1]. */
  alignmentScore: number;
  state: MtfAlignmentState;
  computedAt: ISODateTime;
}

/** A section of analysis with a human-readable summary and its structured data. */
export interface AnalysisSection<T> {
  summary: string;
  data: T;
}

/**
 * Snapshot of the engine's analysis for one symbol/timeframe.
 * Consumed by the Chart Intelligence panel.
 */
export interface AnalysisSnapshot {
  symbol: string;
  timeframe: Timeframe;
  generatedAt: ISODateTime;
  structure: AnalysisSection<MarketStructure>;
  liquidity: AnalysisSection<LiquidityEvent[]>;
  zones: AnalysisSection<Zone[]>;
  momentum: AnalysisSection<Momentum>;
  setup?: Setup;
  opportunity?: Opportunity;
}

// ---------------------------------------------------------------------------
// POST /api/analysis contract — point-in-time market analysis over the configured
// historical provider (aggregates only; never streaming). Reuses spec-25/26 record
// types verbatim — no parallel "live" vocabulary is invented.
// ---------------------------------------------------------------------------

/** Parameters for one bounded analysis run. Maps onto the /api/analysis request body. */
export interface AnalysisRequest {
  /** Explicit symbol list; absent → the static catalog universe filtered by `market`. */
  symbols?: string[];
  /** Scan extent when `symbols` is absent (spec-25 universe construction). */
  market?: MarketSegmentId;
  /** Single evaluation timeframe — one cell per symbol (spec-26 cell grammar). */
  timeframe: Timeframe;
  /**
   * Evaluation timestamp. The anchor bar is the last bar whose CLOSE ≤ asOf
   * (spec-18 closed-bar rule via `closedIndexAt`). Absent → the route resolves it to
   * the last closed bar as of request time.
   */
  asOf?: ISODateTime;
  /**
   * History depth fetched behind asOf — lookback, not evaluation span. Evaluated
   * records are emitted at the anchor bar only; deeper history exists solely to give
   * detection/scoring their honest PIT context. Bounded per request.
   */
  lookbackDays?: number;
  /** Analytical marking only (spec-25/26 semantics — never removes records). */
  setupTypes?: SetupType[];
  minScore?: Score;
}

/** One evaluated cell — what the engine actually saw at the anchor. */
export interface AnalysisCell {
  symbol: string;
  timeframe: Timeframe;
  /** Bars consumed by detection (the full fetched window). */
  barCount: number;
  /** Index of the anchor bar — the evaluation point every record shares. */
  evaluatedIndex: number;
  /** `series.candles[evaluatedIndex].time` — the per-cell asOf (UnixMs). */
  evaluatedAt: UnixMs;
  /** The instrument metadata used for this request — catalog data or the identifier. */
  asset: AssetIdentifier;
  /** The provider's own quality report for the fetched window — verbatim. */
  quality: DataQualityReport;
}

/**
 * One provider-backed analysis result. `opportunities`/`developing` are the spec-25/26
 * frozen records emitted AT the anchor bar only — outcome records, aggregates, and
 * post-hoc `outcomeRef` joins are deliberately absent (they are measured over bars
 * after the anchor and would leak the future).
 */
export interface AnalysisResult {
  /** The requested evaluation timestamp (ISO echo of `asOf`/`end`). */
  asOf: ISODateTime;
  /** Per-cell anchor — evaluatedAt is per-cell because calendars differ. */
  cells: AnalysisCell[];
  /** Ranked records at the anchor (spec-25 `ranked` semantics, frozen at emit). */
  opportunities: BacktestOpportunity[];
  /** Developing records at the anchor — unmet-reasons only (spec-25 `SetupRef`). */
  developing: BacktestDeveloping[];
  /** Symbols that could not be evaluated — diagnostics, never silently dropped. */
  skipped: { symbol: string; reason: string }[];
  /** Which provider served the candles (`kind: "rest"` — historical aggregates). */
  dataSource: MarketDataSource;
  /** Engine/scanner version stamps — results comparable only within them. */
  versions: { methodVersion: string; paramsVersion: string; configVersion: string };
}
