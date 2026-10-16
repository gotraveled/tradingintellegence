/**
 * Screenshot → structured report (Phase P1). Consumes measured `ImageMetrics`
 * and user-supplied context; produces the honest verdict + sections. Every
 * claim traces to a measured fact or a user-supplied value — assumptions and
 * limitations are always attached, never implied away.
 *
 * Hard rules:
 * - Insufficient pixels → verdict "no_trade" with reason, never a forced read.
 * - Price levels exist only when `currentPrice` was supplied; otherwise zones
 *   are reported as fractions of the visible range.
 * - This report is NOT engine output — it is a screen-derived reading that
 *   deliberately stays separate from the canonical OHLC pipeline.
 */
import { MIN_CANDLES_FOR_ANALYSIS, type ImageMetrics } from "./image-metrics";
import { displayPrice, type AxisCalibration, type PriceAxisInput } from "./axis-calibration";
import type { EvidenceRegion } from "./evidence";

export interface ChartContext {
  symbol?: string;
  market?: string;
  timeframe?: string;
  /** User-supplied last price — a single anchor; reference only, not a scale. */
  currentPrice?: number;
  /** Optional user-supplied axis calibration — the only source of numeric prices. */
  priceAxis?: PriceAxisInput;
  horizon?: "intraday" | "swing" | "position";
}

export type ReportVerdict = "analysis" | "wait" | "no_trade";

export interface Scenario {
  side: "bullish" | "bearish";
  trigger: string;
  invalidation: string;
  /** Price-level notes — real prices only when anchored, else relative. */
  entryNote: string;
  targetNote: string;
  riskRewardNote?: string;
}

/** How a level's price was produced — never let a pixel estimate wear a price. */
export type LevelCalibration = "calibrated" | "user-anchored" | "approximate" | "uncalibrated";

export interface PriceLevel {
  kind: "resistance" | "support";
  touches: number;
  /** Screen-space band — always present. */
  bandPct: string;
  /** Present ONLY when a defensible scale exists. */
  priceTop?: number;
  priceBottom?: number;
  calibration: LevelCalibration;
}

export interface ScreenshotReport {
  verdict: ReportVerdict;
  verdictReason: string;
  context: ChartContext;
  /** Axis-calibration summary — status, scale, source, honesty warnings. */
  calibration: {
    status: AxisCalibration["status"];
    scale?: AxisCalibration["scale"];
    source: AxisCalibration["source"];
    anchorCount: number;
    ticksDetected: number;
    notes: string[];
  };
  /** Structured levels — calibrated prices only when the scale is defensible. */
  levels: PriceLevel[];
  facts: {
    candleCount: number;
    bullishCount: number;
    bearishCount: number;
    trendDirection: "rising" | "falling" | "mixed/flat";
    trendStrength: number; // R² 0..1
    lastPositionNote: string;
    swings: ImageMetrics["swings"];
    imageSize: { width: number; height: number };
  };
  trend: string;
  structure: string;
  supplyDemand: string[];
  scenarios: Scenario[];
  riskNotes: string[];
  assumptions: string[];
  limitations: string[];
  /** Set only when a local vision runtime supplied a narrative — marked provenance. */
  /** Inspectable evidence regions — attached by the route after buildEvidence. */
  evidence?: EvidenceRegion[];
  modelNarrative?: { text: string; runtime: string };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

const FALLBACK_CALIBRATION: AxisCalibration = {
  status: "unavailable",
  source: "none",
  anchors: [],
  warnings: ["No price-axis calibration — all levels remain screen-space estimates."],
};

function calibrationSummary(cal: AxisCalibration, metrics: ImageMetrics): ScreenshotReport["calibration"] {
  return {
    status: cal.status,
    ...(cal.scale !== undefined ? { scale: cal.scale } : {}),
    source: cal.source,
    anchorCount: cal.anchors.length,
    ticksDetected: metrics.axis.ticks.length,
    notes: cal.warnings,
  };
}

/** Zone → structured level. Prices are emitted ONLY when a real scale exists. */
function toLevels(metrics: ImageMetrics, cal: AxisCalibration): PriceLevel[] {
  const h = metrics.height;
  const canPrice = cal.rowToPrice !== undefined && (cal.status === "calibrated" || cal.status === "approximate");
  return metrics.zones.map((z) => {
    const band = `${pct(z.top)}–${pct(z.bottom)} of image height from top`;
    if (!canPrice || cal.rowToPrice === undefined) {
      return {
        kind: z.kind,
        touches: z.touches,
        bandPct: band,
        calibration: cal.status === "user-anchored" ? ("user-anchored" as const) : ("uncalibrated" as const),
      };
    }
    const approximate = cal.status === "approximate";
    const pTop = displayPrice(cal.rowToPrice(z.top * h), approximate);
    const pBot = displayPrice(cal.rowToPrice(z.bottom * h), approximate);
    return {
      kind: z.kind,
      touches: z.touches,
      bandPct: band,
      priceTop: pTop,
      priceBottom: pBot,
      calibration: approximate ? ("approximate" as const) : ("calibrated" as const),
    };
  });
}

export function buildScreenshotReport(
  metrics: ImageMetrics,
  context: ChartContext,
  modelNarrative?: ScreenshotReport["modelNarrative"],
  axisCalibration?: AxisCalibration,
): ScreenshotReport {
  const n = metrics.candles.length;
  const cal = axisCalibration ?? FALLBACK_CALIBRATION;
  const calibrated = cal.status === "calibrated" || cal.status === "approximate";
  const anchored = calibrated || (context.currentPrice !== undefined && context.currentPrice > 0);
  const levels = toLevels(metrics, cal);
  const calSummary = calibrationSummary(cal, metrics);

  const limitations = [
    "Analysis is derived from the screenshot's pixels — no OCR exists in this deployment, so axis values are never read from the image.",
    "Candle detection assumes a standard green/red (or bullish/bearish) palette.",
    "Volume, indicators, and drawings outside the candle area are not read.",
    ...(calibrated
      ? []
      : cal.status === "user-anchored"
        ? ["A price anchor was supplied but no scale — zones stay in screen fractions; only the anchor point is a real price."]
        : ["No usable price axis — S/R zones are reported as fractions of the visible range, not prices."]),
    ...(cal.status === "approximate" ? ["Linear vs log scale could not be distinguished — calibrated prices are coarse estimates."] : []),
    "This is a visual read only — it is not engine output and never feeds the canonical pipeline.",
  ];

  if (n < MIN_CANDLES_FOR_ANALYSIS) {
    return {
      verdict: n === 0 ? "no_trade" : "wait",
      verdictReason:
        n === 0
          ? "No candlestick patterns were detected in this image — it may not be a standard candle chart, or the palette is non-standard."
          : `Only ${n} candles were detected — below the ${MIN_CANDLES_FOR_ANALYSIS}-candle minimum for a structural read.`,
      context,
      calibration: calSummary,
      levels,
      facts: factsOf(metrics),
      trend: "Insufficient evidence.",
      structure: "Insufficient evidence.",
      supplyDemand: [],
      scenarios: [],
      riskNotes: ["No trade recommendation — evidence is insufficient."],
      assumptions: [],
      limitations,
      ...(modelNarrative ? { modelNarrative } : {}),
    };
  }

  const rising = metrics.trendSlope < 0;
  const strong = metrics.trendR2 >= 0.6;
  const trendDirection = strong ? (rising ? "rising" : "falling") : "mixed/flat";
  const { swings } = metrics;
  const bullishStructure = swings.higherHighs + swings.higherLows;
  const bearishStructure = swings.lowerHighs + swings.lowerLows;
  const posNote =
    metrics.lastClosePosition >= 0.8
      ? "near the top of the visible range"
      : metrics.lastClosePosition <= 0.2
        ? "near the bottom of the visible range"
        : "mid-range";

  const zoneNotes = levels.map((l) => {
    const side = l.kind === "resistance" ? "supply/resistance" : "demand/support";
    const priced =
      l.priceTop !== undefined && l.priceBottom !== undefined
        ? ` — ≈${l.priceBottom}–${l.priceTop}${l.calibration === "approximate" ? " (approximate: scale undetermined)" : ""}`
        : l.calibration === "user-anchored"
          ? " (visual estimate — anchor has no scale)"
          : " (visual estimate — uncalibrated)";
    return `${l.touches} touch${l.touches > 1 ? "es" : ""} — ${side} zone at ${l.bandPct}${priced}`;
  });

  const scenarios: Scenario[] = [];
  const nearest = metrics.zones[0];
  if (trendDirection === "rising" || bullishStructure > bearishStructure) {
    scenarios.push({
      side: "bullish",
      trigger: `Continuation long if price holds structure${nearest && nearest.kind === "support" ? " above the nearest demand zone" : ""}.`,
      invalidation: `Below the most recent higher low${anchored ? " (exact price requires a verified read)" : ""}.`,
      entryNote: "Entry on confirmed hold/rejection at the demand zone — not on a break of visible range alone.",
      targetNote: `Prior resistance zone${metrics.zones.find((z) => z.kind === "resistance") ? " (top histogram cluster)" : " — visible range top"}.`,
      ...(anchored ? { riskRewardNote: "R/R is estimable only against a verified price scale — treat zone-derived R/R as approximate." } : {}),
    });
  }
  if (trendDirection === "falling" || bearishStructure > bullishStructure) {
    scenarios.push({
      side: "bearish",
      trigger: `Continuation short if the rally fails${nearest && nearest.kind === "resistance" ? " at the nearest supply zone" : ""}.`,
      invalidation: "Above the most recent lower high.",
      entryNote: "Entry on rejection evidence at supply — wick rejection or bearish engulfing on the right edge.",
      targetNote: "Prior demand zone (bottom histogram cluster).",
    });
  }
  if (scenarios.length === 0) {
    return {
      verdict: "wait",
      verdictReason:
        "The visible structure is mixed — no dominant trend or clear swing sequence. WAIT is the honest call.",
      context,
      calibration: calSummary,
      levels,
      facts: factsOf(metrics),
      trend: `Slope ${metrics.trendSlope.toFixed(2)} px/bar, fit R² ${metrics.trendR2.toFixed(2)} — no dominant direction.`,
      structure: `Swings: ${swings.higherHighs}HH/${swings.higherLows}HL vs ${swings.lowerHighs}LH/${swings.lowerLows}LL — ambiguous.`,
      supplyDemand: zoneNotes,
      scenarios: [],
      riskNotes: ["WAIT — no edge visible in this screenshot."],
      assumptions: assumptionsOf(context, anchored),
      limitations,
      ...(modelNarrative ? { modelNarrative } : {}),
    };
  }

  return {
    verdict: "analysis",
    verdictReason: `Measured ${n} candles with a ${trendDirection} read (R² ${metrics.trendR2.toFixed(2)}).`,
    context,
    calibration: calSummary,
    levels,
    facts: factsOf(metrics),
    trend: `Visible trend is ${trendDirection} (slope ${metrics.trendSlope.toFixed(2)} px/bar, fit R² ${metrics.trendR2.toFixed(2)}); last close sits ${posNote}.`,
    structure:
      `Swing sequence: ${swings.higherHighs} higher-highs / ${swings.higherLows} higher-lows ` +
      `vs ${swings.lowerHighs} lower-highs / ${swings.lowerLows} lower-lows — ` +
      `${bullishStructure > bearishStructure ? "bullish-leaning structure" : bearishStructure > bullishStructure ? "bearish-leaning structure" : "no dominant sequence"}.`,
    supplyDemand: zoneNotes,
    scenarios,
    riskNotes: [
      `Invalidation must sit beyond structure, not inside it — beyond the most recent ${trendDirection === "falling" ? "lower high" : "higher low"}.`,
      calibrated
        ? "Prices are derived from your supplied axis anchors — verify them against the real chart before sizing."
        : anchored
          ? "Position sizing still needs the real instrument's stop distance — a single anchor gives no scale."
          : "Without a verified price axis, R/R cannot be stated in absolute terms — define it from the real chart.",
      context.horizon === "intraday"
        ? "Intraday horizon: the visible bars are a small sample — treat zone touches as weak evidence."
        : "Longer horizons need more history than one screenshot shows — confirm on the full chart.",
    ],
    assumptions: assumptionsOf(context, anchored),
    limitations,
    ...(modelNarrative ? { modelNarrative } : {}),
  };
}

function factsOf(m: ImageMetrics): ScreenshotReport["facts"] {
  return {
    candleCount: m.candles.length,
    bullishCount: m.bullishCount,
    bearishCount: m.bearishCount,
    trendDirection: m.trendR2 >= 0.6 ? (m.trendSlope < 0 ? "rising" : "falling") : "mixed/flat",
    trendStrength: m.trendR2,
    lastPositionNote:
      m.lastClosePosition >= 0.8 ? "top of range" : m.lastClosePosition <= 0.2 ? "bottom of range" : "mid-range",
    swings: m.swings,
    imageSize: { width: m.width, height: m.height },
  };
}

function assumptionsOf(ctx: ChartContext, anchored: boolean): string[] {
  const out = [
    "The image is a standard candlestick chart read left→right (past→present).",
    "Screen-space measurements are proportional — not absolute prices.",
  ];
  if (ctx.timeframe === undefined) out.push("Timeframe not supplied — horizon notes assume the visible range only.");
  if (anchored) out.push("The user-supplied price is assumed to be the last visible close — zone prices are proportional estimates from it.");
  return out;
}
