import type { AssetClass, Bias, MarketRegime, SetupStage, SetupType, Tone } from "@/lib/types";

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

export const STAGE_LABEL: Record<SetupStage, string> = {
  developing: "Developing",
  qualified: "Qualified",
  invalidated: "Invalidated",
  expired: "Expired",
};

export const STAGE_TONE: Record<SetupStage, Tone> = {
  developing: "developing",
  qualified: "neutral",
  invalidated: "bearish",
  expired: "inactive",
};

export function describeSetup(bias: Bias, setupType: SetupType) {
  return `Potential ${BIAS_LABEL[bias]} ${SETUP_TYPE_LABEL[setupType]}`;
}
