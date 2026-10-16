/**
 * Price-axis calibration (Phase P2) — converts image rows into prices ONLY when
 * a defensible mapping exists. No OCR is installed, so numeric axis labels are
 * never read from pixels: detection supplies candidate tick POSITIONS, and
 * numeric values come exclusively from the user (or from a verified anchor).
 *
 * Calibration sources, strongest first:
 *   1. `tickPrices` — one price per detected label tick (top→bottom).
 *   2. `topPrice` + `bottomPrice` — the visible range of the plot area.
 *   3. `currentPrice` — a single anchor at the last close; WITHOUT a scale it
 *      cannot produce prices, so it yields "user-anchored" status (a known
 *      reference row, not a calibration).
 *   4. nothing → "unavailable" — every level stays a screen-space estimate.
 *
 * Scale rule: ≥3 anchors let us compare a linear vs logarithmic fit and pick
 * the better one. With 2 anchors both fits are exact, so the scale is ASSUMED
 * linear (unless the caller overrides) and flagged accordingly. When the two
 * fits are statistically indistinguishable the result is downgraded to
 * "approximate" — prices are emitted coarsely rounded, never with false
 * precision. Contradictory anchors (price rising down the screen) reject the
 * calibration outright.
 */
import type { AxisDetection, ImageMetrics } from "./image-metrics";

export type AxisScale = "linear" | "log";
export type CalibrationStatus = "calibrated" | "approximate" | "user-anchored" | "unavailable";

export interface CalibrationAnchor {
  /** Image row (pixels from top). Smaller y = higher on screen = higher price. */
  row: number;
  price: number;
}

export interface PriceAxisInput {
  /** One price per detected axis tick, ordered top→bottom of screen. */
  tickPrices?: number[];
  /** Price at the top of the visible plot area. */
  topPrice?: number;
  /** Price at the bottom of the visible plot area. */
  bottomPrice?: number;
  /** Scale preference — "auto" infers from ≥3 anchors. */
  scale?: "auto" | AxisScale;
}

export interface AxisCalibration {
  status: CalibrationStatus;
  /** Present whenever a row→price mapping was fitted (calibrated/approximate). */
  scale?: AxisScale;
  /** How the anchors were derived — drives the UI's honesty labels. */
  source: "detected-ticks" | "visible-range" | "last-close-anchor" | "none";
  anchors: CalibrationAnchor[];
  /** RMS relative error of the fit over the anchors (0 for a 2-point fit). */
  rmsRelError?: number;
  /** Whether the tick blobs aligned with detected gridlines. */
  ticksAlignedWithGrid?: boolean;
  warnings: string[];
  /** Map an image row to a price — undefined unless a scale was fitted. */
  rowToPrice?: (row: number) => number;
}

/** Round for display: full precision for calibrated, 2 sig figs when approximate. */
export function displayPrice(v: number, approximate: boolean): number {
  if (!approximate) return v;
  if (v === 0) return 0;
  const mag = 10 ** Math.floor(Math.log10(Math.abs(v)));
  return Math.round(v / (mag / 10)) * (mag / 10);
}

/** Least-squares y→value fit over anchors; returns scale fn + stats. */
function fit(
  anchors: CalibrationAnchor[],
  transform: (p: number) => number,
  inverse: (t: number) => number,
): { slope: number; intercept: number; r2: number; rmsRel: number; rowToPrice: (row: number) => number } {
  const n = anchors.length;
  const xs = anchors.map((a) => a.row);
  const ys = anchors.map((a) => transform(a.price));
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const rowToPrice = (row: number) => inverse(intercept + slope * row);
  let sse = 0;
  let sst = 0;
  let rel = 0;
  for (let i = 0; i < n; i += 1) {
    const fitY = intercept + slope * xs[i];
    sse += (ys[i] - fitY) ** 2;
    sst += (ys[i] - my) ** 2;
    rel += ((rowToPrice(xs[i]) - anchors[i].price) / anchors[i].price) ** 2;
  }
  return {
    slope,
    intercept,
    r2: sst === 0 ? 1 : Math.max(0, 1 - sse / sst),
    rmsRel: Math.sqrt(rel / n),
    rowToPrice,
  };
}

const R2_AMBIGUITY = 0.02; // fits closer than this → scale undetermined
const MIN_PRICE = 1e-9;

/**
 * Fit a defensible row→price mapping from user-supplied anchors.
 * Never repairs contradictory input — it rejects with a reason instead.
 */
export function fitAxisCalibration(
  anchorsIn: CalibrationAnchor[],
  opts: { prefer?: "auto" | AxisScale; source: AxisCalibration["source"]; aligned?: boolean } ,
): AxisCalibration {
  const warnings: string[] = [];
  const anchors = [...anchorsIn]
    .filter((a) => Number.isFinite(a.row) && Number.isFinite(a.price) && a.price > 0)
    .sort((a, b) => a.row - b.row);
  const dropped = anchorsIn.length - anchors.length;
  if (dropped > 0) warnings.push(`${dropped} anchor${dropped > 1 ? "s" : ""} ignored — non-positive or non-numeric price.`);

  const base = { source: opts.source, anchors, warnings, ...(opts.aligned !== undefined ? { ticksAlignedWithGrid: opts.aligned } : {}) };

  if (anchors.length === 0) return { ...base, status: "unavailable", warnings: [...warnings, "No usable price anchors."] };
  if (anchors.length === 1) {
    return {
      ...base,
      status: "user-anchored",
      warnings: [...warnings, "One anchor gives a reference point but no scale — prices cannot be derived."],
    };
  }

  // Contradiction check: price must DECREASE as the row increases (down screen).
  for (let i = 1; i < anchors.length; i += 1) {
    if (anchors[i].price >= anchors[i - 1].price) {
      return {
        ...base,
        status: "unavailable",
        warnings: [
          ...warnings,
          `Anchor order contradicts a price axis: row ${anchors[i].row} claims a price (≥ ${anchors[i].price}) ` +
            "higher than a row above it — the calibration was rejected rather than averaged away.",
        ],
      };
    }
  }

  const lin = fit(anchors, (p) => p, (t) => t);
  const canLog = anchors.every((a) => a.price > MIN_PRICE);
  const log = canLog ? fit(anchors, (p) => Math.log(p), (t) => Math.exp(t)) : undefined;

  // Slope sanity: fitted price must fall as rows go down.
  const slopeCheck = (f: { slope: number }) => f.slope < 0;
  if (!slopeCheck(lin) && (log === undefined || !slopeCheck(log))) {
    return { ...base, status: "unavailable", warnings: [...warnings, "Fitted scale is not decreasing down the screen — rejected."] };
  }

  const prefer = opts.prefer ?? "auto";
  let scale: AxisScale;
  let chosen = lin;
  let assumed = false;
  let ambiguous = false;
  if (prefer === "log") {
    if (log === undefined || !slopeCheck(log)) {
      return { ...base, status: "unavailable", warnings: [...warnings, "Log scale requested but not supported by these anchors."] };
    }
    scale = "log";
    chosen = log;
  } else if (prefer === "linear") {
    scale = "linear";
    chosen = lin;
  } else if (anchors.length === 2) {
    scale = "linear";
    chosen = lin;
    assumed = true; // two points fit both families exactly — the assumption is honest, not derived
  } else if (lin.r2 >= 0.999) {
    // An essentially exact fit is evidence, not a coin flip.
    scale = "linear";
    chosen = lin;
  } else if (log !== undefined && log.r2 >= 0.999) {
    scale = "log";
    chosen = log;
  } else {
    const better = lin.r2 - (log?.r2 ?? -1);
    if (Math.abs(better) < R2_AMBIGUITY) {
      scale = "linear";
      chosen = lin;
      ambiguous = true;
    } else if (better > 0) {
      scale = "linear";
      chosen = lin;
    } else {
      scale = "log";
      chosen = log as typeof lin;
    }
  }

  const extra: string[] = [];
  if (assumed) extra.push("Two anchors cannot distinguish linear from log — linear assumed.");
  if (ambiguous) extra.push("Linear and log fits are statistically indistinguishable — prices are coarse estimates only.");
  if (chosen.rmsRel > 0.002 && anchors.length > 2) {
    extra.push(`Fit residual ${(chosen.rmsRel * 100).toFixed(2)}% — the anchors do not sit on one clean scale.`);
  }

  const status: CalibrationStatus = ambiguous || (chosen.rmsRel > 0.005 && anchors.length > 2) ? "approximate" : "calibrated";
  return {
    ...base,
    status,
    scale,
    rmsRelError: chosen.rmsRel,
    warnings: [...warnings, ...extra],
    rowToPrice: chosen.rowToPrice,
  };
}

/**
 * Build anchors from user input + detected geometry, then calibrate.
 * `detection` supplies POSITIONS only — every numeric value here is user-supplied.
 */
export function resolveAxisCalibration(
  metrics: ImageMetrics,
  detection: AxisDetection | undefined,
  input: PriceAxisInput | undefined,
  currentPrice: number | undefined,
): AxisCalibration {
  const prefer = input?.scale ?? "auto";
  const ticks = (detection?.ticks ?? []).slice().sort((a, b) => a.y - b.y);

  // 1. One price per detected tick label — the strongest user calibration.
  if (input?.tickPrices && input.tickPrices.length > 0) {
    if (ticks.length === 0) {
      return {
        status: "unavailable",
        source: "none",
        anchors: [],
        warnings: ["Axis tick prices were supplied but no price-axis ticks were detected in the image — the anchor rows are unknown."],
      };
    }
    if (input.tickPrices.length !== ticks.length) {
      return {
        status: "unavailable",
        source: "detected-ticks",
        anchors: [],
        warnings: [
          `${input.tickPrices.length} tick price${input.tickPrices.length > 1 ? "s" : ""} supplied for ${ticks.length} detected tick${ticks.length > 1 ? "s" : ""} — ` +
            "an ambiguous pairing was rejected; supply exactly one price per detected label, top→bottom.",
        ],
      };
    }
    return fitAxisCalibration(
      ticks.map((t, i) => ({ row: t.y, price: input.tickPrices![i] })),
      { prefer, source: "detected-ticks", aligned: detection?.ticksAlignedWithGrid },
    );
  }

  // 2. Visible-range anchors: top/bottom price mapped to the plot extremes.
  if (input?.topPrice !== undefined || input?.bottomPrice !== undefined) {
    const warnings: string[] = [];
    if (input.topPrice === undefined || input.bottomPrice === undefined) {
      warnings.push("Both topPrice and bottomPrice are needed for a visible-range calibration — single-sided input ignored.");
      return { status: "unavailable", source: "none", anchors: [], warnings };
    }
    // Preferred rows: outermost detected ticks/gridlines; else candle extremes.
    let topRow: number | undefined;
    let bottomRow: number | undefined;
    if (ticks.length >= 2) {
      topRow = ticks[0].y;
      bottomRow = ticks[ticks.length - 1].y;
      warnings.push("Range anchors bound to the outermost detected axis ticks.");
    } else if (detection && detection.gridRows.length >= 2) {
      topRow = detection.gridRows[0];
      bottomRow = detection.gridRows[detection.gridRows.length - 1];
      warnings.push("No axis labels detected — range bound to detected gridlines instead.");
    } else if (metrics.candles.length > 0) {
      topRow = Math.min(...metrics.candles.map((c) => c.top));
      bottomRow = Math.max(...metrics.candles.map((c) => c.bottom));
      warnings.push("No axis or gridlines detected — range bound to candle extremes (coarser).");
    }
    if (topRow === undefined || bottomRow === undefined || bottomRow - topRow < 8) {
      return {
        status: "unavailable",
        source: "none",
        anchors: [],
        warnings: [...warnings, "No usable plot extent for a range calibration."],
      };
    }
    const res = fitAxisCalibration(
      [
        { row: topRow, price: input.topPrice },
        { row: bottomRow, price: input.bottomPrice },
      ],
      { prefer, source: "visible-range" },
    );
    return { ...res, warnings: [...warnings, ...res.warnings] };
  }

  // 3. A lone last-price anchor: a reference point, not a calibration.
  if (currentPrice !== undefined && currentPrice > 0 && metrics.candles.length > 0) {
    const last = metrics.candles[metrics.candles.length - 1];
    const closeRow = last.direction === "bullish" ? last.bodyTop : last.bodyBottom;
    return fitAxisCalibration([{ row: closeRow, price: currentPrice }], { prefer, source: "last-close-anchor" });
  }

  return {
    status: "unavailable",
    source: "none",
    anchors: [],
    warnings: ["No price-axis input — all levels remain screen-space estimates."],
  };
}
