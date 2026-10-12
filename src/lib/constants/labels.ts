import type {
  AssetClass,
  Bias,
  ConfidenceLevel,
  Direction,
  MarketRegime,
  MomentumState,
  OpportunityStatus,
  SetupStatus,
  SetupType,
  Timeframe,
  Tone,
  TrendState,
  ZoneFreshness,
} from "@/lib/types";
import { TIMEFRAMES } from "./markets";

export const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  equities: "Equities",
  indices: "Index",
  forex: "Forex",
  crypto: "Crypto",
  commodities: "Commodity",
  futures: "Futures",
};

export const SETUP_TYPE_LABEL: Record<SetupType, string> = {
  reversal: "Reversal",
  breakout: "Breakout",
  continuation: "Continuation",
};

export const BIAS_LABEL: Record<Bias, string> = {
  bullish: "Bullish",
  bearish: "Bearish",
  neutral: "Neutral",
};

export const BIAS_TONE: Record<Bias, Tone> = {
  bullish: "bullish",
  bearish: "bearish",
  neutral: "neutral",
};

export const REGIME_LABEL: Record<MarketRegime, string> = {
  trending: "Trending",
  ranging: "Ranging",
  compressing: "Compressing",
  expanding: "Expanding volatility",
};

export const SETUP_STATUS_LABEL: Record<SetupStatus, string> = {
  developing: "Developing",
  confirmed: "Confirmed",
  active: "Active",
  partial_target: "Partial target",
  target_reached: "Target reached",
  invalidated: "Invalidated",
  expired: "Expired",
  cancelled: "Cancelled",
};

export const SETUP_STATUS_TONE: Record<SetupStatus, Tone> = {
  developing: "developing",
  confirmed: "neutral",
  active: "bullish",
  partial_target: "neutral",
  target_reached: "inactive",
  invalidated: "bearish",
  expired: "inactive",
  cancelled: "inactive",
};

export const NO_SETUP_LABEL = "No active setup";

export const OPPORTUNITY_STATUSES: OpportunityStatus[] = [
  "developing",
  "confirmed",
  "active",
  "partial_target",
  "target_reached",
  "invalidated",
  "expired",
  "cancelled",
];

export const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

export const TREND_LABEL: Record<TrendState, string> = {
  uptrend: "Uptrend",
  downtrend: "Downtrend",
  range: "Range",
  transition: "Transition",
};

export const MOMENTUM_LABEL: Record<MomentumState, string> = {
  strengthening: "Strengthening",
  weakening: "Weakening",
  neutral: "Neutral",
  diverging: "Diverging",
};

export const ZONE_FRESHNESS_LABEL: Record<ZoneFreshness, string> = {
  fresh: "Fresh",
  tested: "Tested",
  mitigated: "Mitigated",
};

export function timeframeLabel(value: Timeframe) {
  return TIMEFRAMES.find((tf) => tf.value === value)?.label ?? value;
}

/** e.g. "Potential Bullish Reversal" while developing, "Bullish Reversal" otherwise. */
export function describeSetup(
  direction: Direction,
  setupType: SetupType,
  status: SetupStatus = "developing",
) {
  const base = `${BIAS_LABEL[direction]} ${SETUP_TYPE_LABEL[setupType]}`;
  return status === "developing" ? `Potential ${base}` : base;
}
