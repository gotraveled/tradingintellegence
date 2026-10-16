/**
 * Evidence regions (Phase P3) — inspectable rectangles for the features the
 * deterministic pipeline actually detected. Rules:
 *
 * - Every region traces to a measured feature: a candle cluster, an S/R zone,
 *   or a detected axis-tick position. Nothing is invented.
 * - `observed` = direct pixel measurement; `inferred` = interpretation built
 *   on top of measurements (e.g., a zone's price interpretation). Both carry
 *   the same normalized rect; the distinction is honest labelling.
 * - Rects are normalized to [0,1] against the ORIGINAL image dimensions and
 *   always carry pixel bounds too, so a preview at any size maps them back
 *   exactly: `displayRect = normalized × displayedSize`.
 * - A bounding box carries no price meaning — calibration status lives on the
 *   linked level, not on the rectangle.
 */
import type { ImageCandle, ImageMetrics, AxisTick } from "./image-metrics";
import type { PriceLevel } from "./report";

export type EvidenceKind = "candle-cluster" | "zone" | "axis-tick";

export interface RegionRect {
  /** Normalized [0,1] bounds against the original image size. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EvidenceRegion {
  /** Stable identifier — deterministic from feature type + index. */
  id: string;
  kind: EvidenceKind;
  /** `observed` = measured from pixels; `inferred` = interpretation. */
  basis: "observed" | "inferred";
  rect: RegionRect;
  /** Original-image pixel bounds for exact reconstruction. */
  px: { x0: number; y0: number; x1: number; y1: number };
  /** Index into `report.levels` for zones — links region → finding. */
  levelIndex?: number;
  /** Axis ticks: 0-based top→bottom order — the position the user prices. */
  tickIndex?: number;
  method: string;
  limitation: string;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function toRect(x0: number, y0: number, x1: number, y1: number, w: number, h: number): { rect: RegionRect; px: EvidenceRegion["px"] } {
  const cx0 = Math.min(Math.max(0, x0), w - 1);
  const cy0 = Math.min(Math.max(0, y0), h - 1);
  const cx1 = Math.min(Math.max(cx0 + 1, x1), w);
  const cy1 = Math.min(Math.max(cy0 + 1, y1), h);
  return {
    rect: { x: clamp01(cx0 / w), y: clamp01(cy0 / h), w: clamp01((cx1 - cx0) / w), h: clamp01((cy1 - cy0) / h) },
    px: { x0: cx0, y0: cy0, x1: cx1, y1: cy1 },
  };
}

function candleRegion(c: ImageCandle, i: number, w: number, h: number): EvidenceRegion {
  const { rect, px } = toRect(c.x0, c.top, c.x1 + 1, c.bottom + 1, w, h);
  return {
    id: `candle-${i}`,
    kind: "candle-cluster",
    basis: "observed",
    rect,
    px,
    method: "column clustering of bullish/bearish colored pixels",
    limitation: "Cluster bounds follow colored-pixel extent — a thin-bodied candle reads narrow; merge/split errors possible on dense charts.",
  };
}

function zoneRegion(
  z: { top: number; bottom: number; touches: number; kind: string },
  level: PriceLevel | undefined,
  i: number,
  metrics: ImageMetrics,
): EvidenceRegion {
  const { width: w, height: h } = metrics;
  const plotX0 = metrics.axis.side === "left" ? Math.min(110, Math.floor(w * 0.14)) : 0;
  const plotX1 = metrics.axis.side === "right" ? w - Math.min(110, Math.floor(w * 0.14)) : w;
  const { rect, px } = toRect(plotX0, z.top * h, plotX1, z.bottom * h + 1, w, h);
  const calibrated = level !== undefined && (level.calibration === "calibrated" || level.calibration === "approximate");
  return {
    id: `zone-${i}`,
    kind: "zone",
    basis: "inferred",
    rect,
    px,
    levelIndex: i,
    method: `row-density histogram of ${z.kind === "resistance" ? "high" : "low"} extremes — ${z.touches} touches`,
    limitation: calibrated
      ? "Zone band is measured; its price labels come from the user's calibration anchors, not from the image."
      : "Zone band is measured from pixel clustering — it has no price meaning without calibration.",
  };
}

function tickRegion(t: AxisTick, i: number, side: "left" | "right", w: number, h: number): EvidenceRegion {
  const strip = Math.min(110, Math.floor(w * 0.14));
  const x0 = side === "right" ? w - strip : 0;
  const { rect, px } = toRect(x0, t.y - t.height / 2, x0 + strip, t.y + t.height / 2 + 1, w, h);
  return {
    id: `tick-${i}`,
    kind: "axis-tick",
    basis: "observed",
    rect,
    px,
    tickIndex: i,
    method: "low-saturation text-blob grouping in the axis strip (geometric detection — NOT OCR)",
    limitation: "Position only — the label's numeric value is unknown; supply it explicitly to calibrate.",
  };
}

/**
 * Build evidence regions from measured features. Zones link to their report
 * level by index — the link is positional (zones → levels are 1:1 by
 * construction in `toLevels`).
 */
export function buildEvidence(metrics: ImageMetrics, levels: PriceLevel[]): EvidenceRegion[] {
  const w = metrics.width;
  const h = metrics.height;
  const out: EvidenceRegion[] = [];
  metrics.candles.forEach((c, i) => out.push(candleRegion(c, i, w, h)));
  metrics.zones.forEach((z, i) => out.push(zoneRegion(z, levels[i], i, metrics)));
  if (metrics.axis.side !== "none") {
    metrics.axis.ticks.forEach((t, i) => out.push(tickRegion(t, i, metrics.axis.side as "left" | "right", w, h)));
  }
  return out;
}

const MAX_REGIONS = 500;

/**
 * Validate + sanitize regions before they leave the server — drop non-finite
 * or out-of-bounds rects, cap the count. Never repairs a malformed rect into
 * a plausible-looking one.
 */
export function sanitizeEvidence(regions: EvidenceRegion[]): EvidenceRegion[] {
  const ok: EvidenceRegion[] = [];
  for (const r of regions.slice(0, MAX_REGIONS)) {
    const { rect, px } = r;
    const finite =
      [rect.x, rect.y, rect.w, rect.h, px.x0, px.y0, px.x1, px.y1].every(Number.isFinite);
    if (!finite) continue;
    if (rect.x < 0 || rect.y < 0 || rect.w <= 0 || rect.h <= 0) continue;
    if (rect.x + rect.w > 1.0001 || rect.y + rect.h > 1.0001) continue;
    ok.push({
      ...r,
      rect: { x: clamp01(rect.x), y: clamp01(rect.y), w: clamp01(rect.w), h: clamp01(rect.h) },
    });
  }
  return ok;
}
