/**
 * Screenshot chart pixel analysis (Phase P1) — deterministic computer-vision
 * facts extracted from a chart image. NO model, no fabrication: every number
 * here is measured from pixels by `sharp`.
 *
 * Method (documented so results are auditable):
 *  1. Decode to raw RGB via sharp.
 *  2. Classify each pixel: bullish-green, bearish-red, or neutral by channel
 *     dominance (candlestick palette detection — works for the standard
 *     green/red themes; exotic palettes degrade to insufficient evidence).
 *  3. Group colored columns into candle clusters (adjacent colored columns
 *     separated by gaps). Per cluster: high/low from colored-pixel extremes,
 *     body band from row density, direction from dominant color.
 *  4. Facts: cluster count, bull/bear ratio, per-cluster extents, trend slope
 *     (regression over mid-body rows), last-candle range position, swing
 *     structure (local extrema HH/HL/LH/LL), and S/R zones (row histogram of
 *     cluster extremes — where price repeatedly stopped).
 *
 * What this deliberately does NOT do: read axis labels (no OCR dependency —
 * price levels are reported as fractions of the visible range, or as
 * estimates ONLY when the user supplies the last price), detect indicators
 * beyond candlesticks, or invent values it cannot measure.
 */
import sharp from "sharp";

export interface ImageCandle {
  /** Pixel column center — ordering key, left → right = past → present. */
  x: number;
  /** Column bounds of the cluster (inclusive pixels) — evidence-region bounds. */
  x0: number;
  x1: number;
  /** Pixel rows (smaller y = higher on screen = higher price). */
  top: number;
  bottom: number;
  /** Dense body band edges (pixel rows). */
  bodyTop: number;
  bodyBottom: number;
  direction: "bullish" | "bearish";
  /** Dominant color coverage ratio — low values mean a thin/sparse drawing. */
  coverage: number;
}

/** Candidate axis-label tick: position + size only — values are NEVER OCR-read. */
export interface AxisTick {
  /** Center row of the label blob (pixels from image top). */
  y: number;
  height: number;
}

export interface AxisDetection {
  /** Which edge carried label-like blobs; "none" = no usable axis strip. */
  side: "left" | "right" | "none";
  /** Detected label-tick positions, top→bottom. Values unknown without OCR. */
  ticks: AxisTick[];
  /** Rows of detected horizontal gridlines across the plot area. */
  gridRows: number[];
  /** ≥60% of detected ticks sit on/near a gridline row. */
  ticksAlignedWithGrid: boolean;
}

export interface ImageMetrics {
  width: number;
  height: number;
  /** Detected candle clusters, ordered left → right. */
  candles: ImageCandle[];
  bullishCount: number;
  bearishCount: number;
  /** Linear-regression slope of mid-body rows over candle order.
   *  NEGATIVE = rising on screen (price up); POSITIVE = falling. */
  trendSlope: number;
  /** Strength of the trend fit 0..1 (1 = perfectly monotonic). */
  trendR2: number;
  /** Last candle's position inside the visible price range (0 = bottom, 1 = top). */
  lastClosePosition: number;
  /** Swing-structure counts from local extrema of cluster extremes. */
  swings: { higherHighs: number; higherLows: number; lowerHighs: number; lowerLows: number };
  /** Row bands (fractions of image height) where highs/lows repeatedly cluster. */
  zones: { top: number; bottom: number; touches: number; kind: "resistance" | "support" }[];
  /** Axis-strip detection — tick POSITIONS and gridlines only (no OCR values). */
  axis: AxisDetection;
}

export const MIN_CANDLES_FOR_ANALYSIS = 8;

const BULL_DOMINANCE = 1.25; // g must exceed r,b by this factor to count as bullish
const BEAR_DOMINANCE = 1.25;
const MIN_CHANNEL = 40; // ignore near-grey pixels — chart grid/text, not candles
const BODY_DENSITY_FACTOR = 0.55; // rows above this share of peak column-density → body

interface PixelClass {
  /** Per-column: min/max colored row + dominant class counts. */
  columns: {
    minY: number;
    maxY: number;
    bull: number;
    bear: number;
    rowCount: Map<number, number>; // colored-row density for body detection
  }[];
}

function classifyPixels(data: Buffer, width: number, height: number, channels: number): PixelClass {
  const columns: PixelClass["columns"] = Array.from({ length: width }, () => ({
    minY: Infinity,
    maxY: -Infinity,
    bull: 0,
    bear: 0,
    rowCount: new Map<number, number>(),
  }));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const col = columns[x];
      if (g > MIN_CHANNEL && g > r * BULL_DOMINANCE && g > b * BULL_DOMINANCE) {
        col.bull += 1;
      } else if (r > MIN_CHANNEL && r > g * BEAR_DOMINANCE && r > b * BEAR_DOMINANCE) {
        col.bear += 1;
      } else {
        continue;
      }
      if (y < col.minY) col.minY = y;
      if (y > col.maxY) col.maxY = y;
      col.rowCount.set(y, (col.rowCount.get(y) ?? 0) + 1);
    }
  }
  return { columns };
}

/** Group adjacent colored columns into candle clusters. */
function clusterColumns(columns: PixelClass["columns"], maxGap: number): ImageCandle[] {
  const clusters: ImageCandle[] = [];
  let group: { start: number; end: number } | undefined;
  let gap = 0;
  for (let x = 0; x < columns.length; x += 1) {
    const colored = columns[x].bull + columns[x].bear > 0;
    if (colored) {
      if (group === undefined) group = { start: x, end: x };
      group.end = x;
      gap = 0;
    } else if (group !== undefined) {
      gap += 1;
      if (gap > maxGap) {
        clusters.push(finishCluster(group.start, group.end));
        group = undefined;
      }
    }
  }
  if (group !== undefined) clusters.push(finishCluster(group.start, group.end));
  return clusters.filter((c) => c.bottom - c.top >= 2);

  function finishCluster(x0: number, x1: number): ImageCandle {
    let top = Infinity;
    let bottom = -Infinity;
    let bull = 0;
    let bear = 0;
    const rowDensity = new Map<number, number>();
    for (let x = x0; x <= x1; x += 1) {
      const col = columns[x];
      if (col.minY < top) top = col.minY;
      if (col.maxY > bottom) bottom = col.maxY;
      bull += col.bull;
      bear += col.bear;
      col.rowCount.forEach((n, y) => rowDensity.set(y, (rowDensity.get(y) ?? 0) + n));
    }
    // Body band: contiguous densest rows — the wicks are thin by definition.
    let peak = 0;
    rowDensity.forEach((n) => {
      if (n > peak) peak = n;
    });
    const threshold = Math.max(1, peak * BODY_DENSITY_FACTOR);
    let bodyTop = top;
    let bodyBottom = bottom;
    const dense = [...rowDensity.entries()].filter(([, n]) => n >= threshold).map(([y]) => y);
    if (dense.length > 0) {
      bodyTop = Math.min(...dense);
      bodyBottom = Math.max(...dense);
    }
    const widthPx = x1 - x0 + 1;
    const colored = bull + bear;
    return {
      x: (x0 + x1) / 2,
      x0,
      x1,
      top,
      bottom,
      bodyTop,
      bodyBottom,
      direction: bull >= bear ? "bullish" : "bearish",
      coverage: colored / Math.max(1, widthPx * Math.max(1, bottom - top + 1)),
    };
  }
}

/** O(n) least-squares over mid-body row vs candle index. Negative slope = price rising. */
function trendRegression(candles: ImageCandle[]): { slope: number; r2: number } {
  const n = candles.length;
  if (n < 3) return { slope: 0, r2: 0 };
  const ys = candles.map((c) => (c.bodyTop + c.bodyBottom) / 2);
  const xs = candles.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (xs[i] - meanX) ** 2;
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  let sse = 0;
  let sst = 0;
  for (let i = 0; i < n; i += 1) {
    const fit = meanY + slope * (xs[i] - meanX);
    sse += (ys[i] - fit) ** 2;
    sst += (ys[i] - meanY) ** 2;
  }
  const r2 = sst === 0 ? 1 : Math.max(0, 1 - sse / sst);
  return { slope, r2 };
}

/** Local extrema over cluster extremes → structural HH/HL/LH/LL counts. */
function swingStructure(candles: ImageCandle[]): ImageMetrics["swings"] {
  const swings = { higherHighs: 0, higherLows: 0, lowerHighs: 0, lowerLows: 0 };
  const highs: number[] = []; // top = higher price = smaller y — keep "price" = -y for clarity
  const lows: number[] = [];
  for (const c of candles) {
    highs.push(-c.top); // higher = visually higher
    lows.push(-c.bottom); // higher = less deep
  }
  const extrema = (arr: number[]): { idx: number; value: number; kind: "max" | "min" }[] => {
    const out: { idx: number; value: number; kind: "max" | "min" }[] = [];
    for (let i = 1; i < arr.length - 1; i += 1) {
      if (arr[i] > arr[i - 1] && arr[i] > arr[i + 1]) out.push({ idx: i, value: arr[i], kind: "max" });
      if (arr[i] < arr[i - 1] && arr[i] < arr[i + 1]) out.push({ idx: i, value: arr[i], kind: "min" });
    }
    return out;
  };
  const hiExt = extrema(highs).filter((e) => e.kind === "max");
  const loExt = extrema(lows).filter((e) => e.kind === "min");
  for (let i = 1; i < hiExt.length; i += 1) {
    if (hiExt[i].value > hiExt[i - 1].value) swings.higherHighs += 1;
    else swings.lowerHighs += 1;
  }
  for (let i = 1; i < loExt.length; i += 1) {
    // "lows" here are negated: a HIGHER value = a shallower (higher) low.
    if (loExt[i].value > loExt[i - 1].value) swings.higherLows += 1;
    else swings.lowerLows += 1;
  }
  return swings;
}

/**
 * S/R zones from cluster extremes: histogram rows where highs (resistance) and
 * lows (support) repeatedly stop. Reported as image-height fractions — price
 * mapping happens only when the caller supplies a verified anchor price.
 */
function priceZones(candles: ImageCandle[], height: number): ImageMetrics["zones"] {
  if (candles.length < 4) return [];
  const highs = candles.map((c) => c.top);
  const lows = candles.map((c) => c.bottom);
  const zones: ImageMetrics["zones"] = [];
  const collect = (rows: number[], kind: "resistance" | "support") => {
    const sorted = [...rows].sort((a, b) => a - b);
    const clusterTol = Math.max(2, height * 0.012);
    const groups: number[][] = [];
    for (const r of sorted) {
      const g = groups[groups.length - 1];
      if (g && r - g[g.length - 1] <= clusterTol) g.push(r);
      else groups.push([r]);
    }
    for (const g of groups) {
      if (g.length < 2) continue; // one touch is not a zone
      zones.push({
        top: Math.min(...g) / height,
        bottom: Math.max(...g) / height,
        touches: g.length,
        kind,
      });
    }
  };
  collect(highs, "resistance");
  collect(lows, "support");
  return zones.sort((a, b) => b.touches - a.touches).slice(0, 6);
}

/**
 * Detect the price-axis region WITHOUT reading values: label blobs are located
 * as low-saturation text-like pixel groups inside an edge strip, and gridlines
 * as faint horizontal rows spanning the plot. Positions only — no OCR exists
 * in this deployment, so no label value is ever derived from pixels.
 */
function detectAxis(data: Buffer, width: number, height: number, channels: number): AxisDetection {
  const px = (x: number, y: number) => {
    const i = (y * width + x) * channels;
    return { r: data[i], g: data[i + 1], b: data[i + 2] };
  };
  const lum = (p: { r: number; g: number; b: number }) => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;
  const sat = (p: { r: number; g: number; b: number }) => Math.max(p.r, p.g, p.b) - Math.min(p.r, p.g, p.b);

  // Background luminance = median of a sparse sample — chart backgrounds are dominant.
  const sample: number[] = [];
  for (let y = 0; y < height; y += 7) {
    for (let x = 0; x < width; x += 7) {
      sample.push(lum(px(x, y)));
      if (sample.length > 8_000) break;
    }
    if (sample.length > 8_000) break;
  }
  sample.sort((a, b) => a - b);
  const bgLum = sample[Math.floor(sample.length / 2)] ?? 128;

  // Text-ish: low saturation (not a candle color) and clearly off-background.
  const isText = (x: number, y: number): boolean => {
    const p = px(x, y);
    return sat(p) <= 45 && Math.abs(lum(p) - bgLum) > 40;
  };
  // Grid-ish: low saturation, faintly off-background (gridlines are subtle).
  const isGrid = (x: number, y: number): boolean => {
    const p = px(x, y);
    const d = Math.abs(lum(p) - bgLum);
    return sat(p) <= 45 && d >= 8 && d <= 70;
  };

  const STRIP = Math.min(110, Math.floor(width * 0.14));
  const scanSide = (x0: number, x1: number): AxisTick[] => {
    // Rows carrying ≥2 text-like pixels, grouped into label-height blobs.
    const rows: boolean[] = new Array<boolean>(height).fill(false);
    for (let y = 0; y < height; y += 1) {
      let count = 0;
      for (let x = x0; x < x1; x += 1) if (isText(x, y)) count += 1;
      rows[y] = count >= 2;
    }
    const blobs: { y0: number; y1: number }[] = [];
    let cur: { y0: number; y1: number } | undefined;
    let gap = 0;
    for (let y = 0; y < height; y += 1) {
      if (rows[y]) {
        if (cur === undefined) cur = { y0: y, y1: y };
        cur.y1 = y;
        gap = 0;
      } else if (cur !== undefined) {
        gap += 1;
        if (gap > 2) {
          blobs.push(cur);
          cur = undefined;
        }
      }
    }
    if (cur !== undefined) blobs.push(cur);
    // Label glyphs are roughly 4–32px tall; taller blobs are icons/borders, not ticks.
    return blobs
      .filter((b) => b.y1 - b.y0 + 1 >= 4 && b.y1 - b.y0 + 1 <= 32)
      .map((b) => ({ y: Math.round((b.y0 + b.y1) / 2), height: b.y1 - b.y0 + 1 }));
  };

  const right = scanSide(Math.max(0, width - STRIP), width);
  const left = scanSide(0, Math.min(width, STRIP));
  const side: AxisDetection["side"] =
    right.length >= 2 && right.length >= left.length ? "right"
    : left.length >= 2 ? "left"
    : "none";
  const ticks = side === "right" ? right : side === "left" ? left : [];

  // Gridlines: rows inside the plot region with broad faint-line coverage.
  const plotX0 = side === "left" ? STRIP : 0;
  const plotX1 = side === "right" ? width - STRIP : width;
  const plotW = Math.max(1, plotX1 - plotX0);
  const gridRows: number[] = [];
  {
    let cur: { y0: number; y1: number } | undefined;
    for (let y = 0; y < height; y += 1) {
      let count = 0;
      for (let x = plotX0; x < plotX1; x += 2) if (isGrid(x, y)) count += 1;
      const covered = count * 2 >= plotW * 0.3;
      if (covered) {
        if (cur === undefined) cur = { y0: y, y1: y };
        cur.y1 = y;
      } else if (cur !== undefined) {
        if (cur.y1 - cur.y0 <= 4) gridRows.push(Math.round((cur.y0 + cur.y1) / 2));
        cur = undefined;
      }
    }
    if (cur !== undefined && cur.y1 - cur.y0 <= 4) gridRows.push(Math.round((cur.y0 + cur.y1) / 2));
  }

  const aligned =
    ticks.length > 0 &&
    ticks.filter((t) => gridRows.some((g) => Math.abs(g - t.y) <= 4)).length / ticks.length >= 0.6;

  return { side, ticks, gridRows, ticksAlignedWithGrid: aligned };
}

/** Decode + measure. Throws on un-decodable input — callers map to 400. */
export async function analyzeChartImage(buffer: Buffer): Promise<ImageMetrics> {
  const image = sharp(buffer);
  const meta = await image.metadata();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const { columns } = classifyPixels(data, info.width, info.height, info.channels);
  const candles = clusterColumns(columns, Math.max(1, Math.round(info.width * 0.004)));

  const { slope, r2 } = trendRegression(candles);
  const minY = candles.length > 0 ? Math.min(...candles.map((c) => c.top)) : 0;
  const maxY = candles.length > 0 ? Math.max(...candles.map((c) => c.bottom)) : 1;
  const last = candles[candles.length - 1];
  const lastCloseRow = last === undefined ? 0.5
    : last.direction === "bullish" ? last.bodyTop : last.bodyBottom;
  const lastClosePosition =
    maxY === minY ? 0.5 : 1 - (lastCloseRow - minY) / (maxY - minY);

  return {
    width: meta.width ?? info.width,
    height: meta.height ?? info.height,
    candles,
    bullishCount: candles.filter((c) => c.direction === "bullish").length,
    bearishCount: candles.filter((c) => c.direction === "bearish").length,
    trendSlope: slope,
    trendR2: r2,
    lastClosePosition,
    swings: swingStructure(candles),
    zones: priceZones(candles, info.height),
    axis: detectAxis(data, info.width, info.height, info.channels),
  };
}
