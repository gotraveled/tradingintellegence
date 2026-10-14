import type {
  MarketStructure,
  MomentumFeatures,
  RegimeConfig,
  RegimeLabel,
} from "@/lib/types";
import type { EngineResult, MarketRegimeEngine } from "@/lib/services/engine";

/**
 * Market Regime Engine (docs/engine/27-market-regime-engine.md — implementation closure
 * of the spec-19 model, docs/engine/19-regime.md).
 *
 * A deliberately small 6-state per-bar label answering "which setup types work in which
 * conditions". Two orthogonal inputs — `structure.trend` and `features.atrTrend` —
 * map to a single label by first-match precedence; volatility dominates direction.
 *
 * The classifier is PURE over snapshot inputs: the caller supplies the point-in-time
 * `structure` (i.e. `structureStateAt(t)`) and `features` (i.e. `momentumStateAt(t)`
 * .features / `featuresByBar[t]`). Causality is inherited from those inputs — this
 * module never touches candles, swings, or final-series artifacts.
 *
 * `RegimeConfig.atrLength`/`atrLookback`/`minBars` are reserved (spec 19 defers the
 * `minBars` hysteresis slot) — only `expandAtrTrend`/`compressAtrTrend` are consumed.
 */

const STAGE = "regime";
/** Snapshot consumer — classifies a point-in-time input, not a bar range. */
const SNAPSHOT_BARS = { from: -1, to: -1 } as const;

/** Spec 27: finite `expandAtrTrend > compressAtrTrend > 0`, strict. */
function configOk(cfg: RegimeConfig): boolean {
  return (
    Number.isFinite(cfg.compressAtrTrend) &&
    cfg.compressAtrTrend > 0 &&
    Number.isFinite(cfg.expandAtrTrend) &&
    cfg.expandAtrTrend > cfg.compressAtrTrend
  );
}

/** Non-finite atrTrend (NaN/±∞) is treated as absent — never an error. */
function atrOf(f: MomentumFeatures | undefined): number | undefined {
  const a = f?.atrTrend;
  return typeof a === "number" && Number.isFinite(a) ? a : undefined;
}

/**
 * classifyRegime — spec-19 first-match precedence over point-in-time inputs:
 *   1 high_volatility  atr ≥ expand
 *   2 low_volatility   atr ≤ compress
 *   3 trending_bullish uptrend   ∧ atr > compress
 *   4 trending_bearish downtrend ∧ atr > compress
 *   5 ranging          trend = range (no volatility requirement)
 *   6 transition       everything else — honest "don't know"
 */
export function classifyRegime(input: {
  structure: MarketStructure;
  features: MomentumFeatures | undefined;
  config: RegimeConfig;
}): EngineResult<{ regime: RegimeLabel }> {
  const { structure, features, config } = input;
  const meta = {
    stage: STAGE,
    paramsVersion: `e${config.expandAtrTrend}|c${config.compressAtrTrend}`,
    barsConsumed: { ...SNAPSHOT_BARS },
    events: [],
  };

  if (!configOk(config)) {
    return {
      ok: false,
      errors: [
        {
          code: "invalid_config",
          message:
            "regime: requires finite expandAtrTrend > compressAtrTrend > 0",
        },
      ],
      meta,
    };
  }

  const trend = structure.trend;
  const atr = atrOf(features);

  let regime: RegimeLabel;
  let rule: number;
  if (atr !== undefined && atr >= config.expandAtrTrend) {
    regime = "high_volatility";
    rule = 1;
  } else if (atr !== undefined && atr <= config.compressAtrTrend) {
    regime = "low_volatility";
    rule = 2;
  } else if (trend === "uptrend" && atr !== undefined && atr > config.compressAtrTrend) {
    regime = "trending_bullish"; // middle band — rules 1–2 already excluded atr extremes
    rule = 3;
  } else if (trend === "downtrend" && atr !== undefined && atr > config.compressAtrTrend) {
    regime = "trending_bearish";
    rule = 4;
  } else if (trend === "range") {
    regime = "ranging"; // atr absent or mid-band — rule 5 needs no volatility read
    rule = 5;
  } else {
    regime = "transition";
    rule = 6;
  }

  return {
    ok: true,
    data: { regime },
    errors: [],
    meta: {
      ...meta,
      diagnostics: { trend, atrTrend: atr ?? "absent", rule },
    },
  };
}

/**
 * regimeStateAt — point-in-time label for the historical `at(t)` join. Causality is
 * entirely inherited: pass `structureStateAt(t)` + `momentumStateAt(t).features`.
 * Invalid config degrades to `transition` — never throws, never fabricates direction.
 */
export function regimeStateAt(
  structure: MarketStructure,
  features: MomentumFeatures | undefined,
  config: RegimeConfig,
): RegimeLabel {
  const r = classifyRegime({ structure, features, config });
  return r.ok && r.data ? r.data.regime : "transition";
}

export function createMarketRegimeEngine(): MarketRegimeEngine {
  return {
    classify(input) {
      return classifyRegime(input);
    },
  };
}
