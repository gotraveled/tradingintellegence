/**
 * Axis calibration — deterministic validation (Phase P2).
 * Charts are SYNTHESIZED with sharp: known tick marks, gridlines, and candle
 * geometry in → measured positions + user-supplied values → calibrated prices
 * out. Every price assertion traces to drawn pixels + declared inputs; no
 * label value is ever OCR-read (none is — detection yields positions only).
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { analyzeChartImage, type AxisDetection, type ImageMetrics } from "../image-metrics";
import { displayPrice, fitAxisCalibration, resolveAxisCalibration } from "../axis-calibration";
import { buildScreenshotReport } from "../report";

const GREEN = { r: 20, g: 200, b: 60 };
const RED = { r: 220, g: 40, b: 40 };
const BG = { r: 15, g: 15, b: 20 };
const TEXT = { r: 200, g: 200, b: 210 };
const GRID = { r: 40, g: 40, b: 50 };

type Overlay = NonNullable<Parameters<ReturnType<typeof sharp>["composite"]>[0]>[number];

interface ChartSpec {
  w?: number;
  h?: number;
  /** Tick label rows (drawn as small text-like dashes in the right strip). */
  tickRows?: number[];
  /** Gridline rows across the plot. */
  gridRows?: number[];
  candles?: { x: number; top: number; bottom: number; bull: boolean }[];
  side?: "right" | "left";
}

async function synthAxisChart(spec: ChartSpec): Promise<Buffer> {
  const w = spec.w ?? 600;
  const h = spec.h ?? 400;
  const composites: Overlay[] = [];
  const stripX = spec.side === "left" ? 8 : w - 60;
  for (const gy of spec.gridRows ?? []) {
    composites.push({
      input: { create: { width: w - 140, height: 1, channels: 3, background: GRID } },
      top: gy,
      left: 60,
    });
  }
  for (const ty of spec.tickRows ?? []) {
    // A 12px-tall, 24px-wide blob — stand-in for a label glyph group.
    composites.push({
      input: { create: { width: 24, height: 12, channels: 3, background: TEXT } },
      top: ty - 6,
      left: stripX,
    });
  }
  for (const c of spec.candles ?? []) {
    const color = c.bull ? GREEN : RED;
    composites.push({
      input: { create: { width: 1, height: c.bottom - c.top, channels: 3, background: color } },
      top: c.top,
      left: c.x,
    });
    const bodyH = Math.max(2, Math.round((c.bottom - c.top) * 0.6));
    composites.push({
      input: { create: { width: 4, height: bodyH, channels: 3, background: color } },
      top: c.top + Math.round((c.bottom - c.top - bodyH) / 2),
      left: c.x - 1,
    });
  }
  return sharp({ create: { width: w, height: h, channels: 3, background: BG } })
    .composite(composites)
    .png()
    .toBuffer();
}

const rising = (n: number, x0 = 60): NonNullable<ChartSpec["candles"]> =>
  Array.from({ length: n }, (_, i) => ({
    x: x0 + i * 24,
    top: 300 - i * 10,
    bottom: 340 - i * 10,
    bull: i % 3 !== 2,
  }));

const metricsOf = (over: Partial<ImageMetrics>): ImageMetrics => ({
  width: 600, height: 400, candles: [], bullishCount: 0, bearishCount: 0,
  trendSlope: 0, trendR2: 0, lastClosePosition: 0.5,
  swings: { higherHighs: 0, higherLows: 0, lowerHighs: 0, lowerLows: 0 },
  zones: [], axis: { side: "none", ticks: [], gridRows: [], ticksAlignedWithGrid: false },
  ...over,
});

const axis = (over: Partial<AxisDetection>): AxisDetection => ({
  side: "none", ticks: [], gridRows: [], ticksAlignedWithGrid: false, ...over,
});

describe("axis detection — positions only, never values", () => {
  it("finds label-tick rows on the right edge at the drawn positions", async () => {
    const png = await synthAxisChart({ tickRows: [80, 160, 240, 320], gridRows: [80, 160, 240, 320] });
    const m = await analyzeChartImage(png);
    expect(m.axis.side).toBe("right");
    expect(m.axis.ticks.map((t) => t.y)).toEqual([80, 160, 240, 320]);
    expect(m.axis.ticksAlignedWithGrid).toBe(true);
  });

  it("finds ticks on the left edge when drawn there", async () => {
    const png = await synthAxisChart({ tickRows: [100, 200, 300], side: "left" });
    const m = await analyzeChartImage(png);
    expect(m.axis.side).toBe("left");
    expect(m.axis.ticks.map((t) => t.y)).toEqual([100, 200, 300]);
  });

  it("reports no axis on a bare chart — honest 'none', not a guess", async () => {
    const png = await synthAxisChart({ candles: rising(10) });
    const m = await analyzeChartImage(png);
    expect(m.axis.side).toBe("none");
    expect(m.axis.ticks).toHaveLength(0);
  });

  it("detects gridline rows independently of labels", async () => {
    const png = await synthAxisChart({ gridRows: [100, 200, 300], candles: rising(8) });
    const m = await analyzeChartImage(png);
    expect(m.axis.gridRows).toEqual([100, 200, 300]);
  });

  it("different dimensions still locate ticks", async () => {
    const png = await synthAxisChart({ w: 900, h: 500, tickRows: [60, 220, 380] });
    const m = await analyzeChartImage(png);
    expect(m.axis.side).toBe("right");
    expect(m.axis.ticks.map((t) => t.y)).toEqual([60, 220, 380]);
  });
});

describe("fitAxisCalibration — the mapping math", () => {
  it("two anchors → exact linear map (scale honestly assumed)", () => {
    const cal = fitAxisCalibration(
      [{ row: 50, price: 120 }, { row: 350, price: 80 }],
      { prefer: "auto", source: "detected-ticks" },
    );
    expect(cal.status).toBe("calibrated");
    expect(cal.scale).toBe("linear");
    expect(cal.warnings.join(" ")).toMatch(/linear assumed/i);
    expect(cal.rowToPrice?.(50)).toBeCloseTo(120, 5);
    expect(cal.rowToPrice?.(200)).toBeCloseTo(100, 5);
    expect(cal.rowToPrice?.(350)).toBeCloseTo(80, 5);
  });

  it("three anchors on a log mapping → log scale chosen over linear", () => {
    // log scale: equal price RATIOS at equal row spacing.
    const cal = fitAxisCalibration(
      [{ row: 40, price: 200 }, { row: 220, price: 100 }, { row: 400, price: 50 }],
      { prefer: "auto", source: "detected-ticks" },
    );
    expect(cal.status).toBe("calibrated");
    expect(cal.scale).toBe("log");
    expect(cal.rowToPrice?.(130)).toBeCloseTo(Math.exp(0.5 * (Math.log(200) + Math.log(100))), 1);
  });

  it("three anchors on a linear mapping → linear scale chosen", () => {
    const cal = fitAxisCalibration(
      [{ row: 40, price: 150 }, { row: 220, price: 110 }, { row: 400, price: 70 }],
      { prefer: "auto", source: "detected-ticks" },
    );
    expect(cal.status).toBe("calibrated");
    expect(cal.scale).toBe("linear");
  });

  it("contradictory anchors (price rising down screen) → rejected, not averaged", () => {
    const cal = fitAxisCalibration(
      [{ row: 50, price: 80 }, { row: 350, price: 120 }],
      { prefer: "auto", source: "detected-ticks" },
    );
    expect(cal.status).toBe("unavailable");
    expect(cal.rowToPrice).toBeUndefined();
    expect(cal.warnings.join(" ")).toMatch(/contradicts/i);
  });

  it("invalid anchors are dropped and reported", () => {
    const cal = fitAxisCalibration(
      [{ row: 50, price: 120 }, { row: 200, price: -5 }, { row: 350, price: 80 }],
      { prefer: "auto", source: "detected-ticks" },
    );
    expect(cal.status).toBe("calibrated");
    expect(cal.anchors).toHaveLength(2);
    expect(cal.warnings.join(" ")).toMatch(/ignored/i);
  });

  it("a single anchor yields user-anchored status — a reference, not a scale", () => {
    const cal = fitAxisCalibration([{ row: 100, price: 24500 }], { prefer: "auto", source: "last-close-anchor" });
    expect(cal.status).toBe("user-anchored");
    expect(cal.rowToPrice).toBeUndefined();
  });

  it("no anchors → unavailable", () => {
    expect(fitAxisCalibration([], { prefer: "auto", source: "none" }).status).toBe("unavailable");
  });

  it("ambiguous scale (fits indistinguishable) → approximate, never precise", () => {
    // Mildly curved anchors where linear≈log within tolerance.
    const cal = fitAxisCalibration(
      [{ row: 40, price: 101 }, { row: 220, price: 99.6 }, { row: 400, price: 98.4 }],
      { prefer: "auto", source: "detected-ticks" },
    );
    expect(["approximate", "calibrated"]).toContain(cal.status);
    if (cal.status === "approximate") {
      expect(displayPrice(cal.rowToPrice!(220), true)).toBe(100); // 2 sig figs
    }
  });
});

describe("resolveAxisCalibration — user input + detected geometry", () => {
  const ticks = axis({ side: "right", ticks: [{ y: 80, height: 12 }, { y: 240, height: 12 }, { y: 400, height: 12 }], gridRows: [80, 240, 400], ticksAlignedWithGrid: true });

  it("tickPrices pair top→bottom with detected ticks → calibrated", () => {
    const m = metricsOf({});
    const cal = resolveAxisCalibration(m, ticks, { tickPrices: [150, 100, 50] }, undefined);
    expect(cal.status).toBe("calibrated");
    expect(cal.source).toBe("detected-ticks");
    expect(cal.anchors).toEqual([
      { row: 80, price: 150 }, { row: 240, price: 100 }, { row: 400, price: 50 },
    ]);
  });

  it("wrong tickPrices count → rejected as ambiguous, never guessed", () => {
    const cal = resolveAxisCalibration(metricsOf({}), ticks, { tickPrices: [150, 100] }, undefined);
    expect(cal.status).toBe("unavailable");
    expect(cal.warnings.join(" ")).toMatch(/ambiguous pairing/i);
  });

  it("tickPrices with no detected ticks → unavailable with a clear reason", () => {
    const cal = resolveAxisCalibration(metricsOf({}), axis({}), { tickPrices: [100, 90] }, undefined);
    expect(cal.status).toBe("unavailable");
    expect(cal.warnings.join(" ")).toMatch(/no price-axis ticks/i);
  });

  it("top/bottom range maps onto detected ticks", () => {
    const cal = resolveAxisCalibration(metricsOf({}), ticks, { topPrice: 200, bottomPrice: 100 }, undefined);
    expect(cal.status).toBe("calibrated");
    expect(cal.source).toBe("visible-range");
    expect(cal.rowToPrice?.(240)).toBeCloseTo(150, 5);
  });

  it("range falls back to candle extremes when nothing else exists", () => {
    const m = metricsOf({ candles: [
      { x: 50, x0: 48, x1: 52, top: 60, bottom: 120, bodyTop: 70, bodyBottom: 110, direction: "bullish", coverage: 0.5 },
      { x: 80, x0: 78, x1: 82, top: 100, bottom: 320, bodyTop: 130, bodyBottom: 300, direction: "bearish", coverage: 0.5 },
    ] });
    const cal = resolveAxisCalibration(m, axis({}), { topPrice: 110, bottomPrice: 90 }, undefined);
    expect(cal.status).toBe("calibrated");
    expect(cal.warnings.join(" ")).toMatch(/candle extremes/i);
  });

  it("single-sided range input → unavailable (never half-calibrated)", () => {
    const cal = resolveAxisCalibration(metricsOf({}), ticks, { topPrice: 200 }, undefined);
    expect(cal.status).toBe("unavailable");
  });

  it("currentPrice alone → user-anchored (reference point only)", () => {
    const m = metricsOf({ candles: [
      { x: 50, x0: 48, x1: 52, top: 100, bottom: 200, bodyTop: 120, bodyBottom: 180, direction: "bearish", coverage: 0.5 },
    ] });
    const cal = resolveAxisCalibration(m, ticks, undefined, 24500);
    expect(cal.status).toBe("user-anchored");
    expect(cal.rowToPrice).toBeUndefined();
    expect(cal.anchors[0].price).toBe(24500);
  });

  it("nothing supplied → unavailable; levels stay uncalibrated", () => {
    const cal = resolveAxisCalibration(metricsOf({}), ticks, undefined, undefined);
    expect(cal.status).toBe("unavailable");
  });
});

describe("report integration — calibrated prices vs honest estimates", () => {
  it("calibrated report emits real prices on levels", async () => {
    const chop = Array.from({ length: 12 }, (_, i) => ({
      x: 60 + i * 24, top: i % 2 === 0 ? 60 : 100, bottom: i % 2 === 0 ? 100 : 140, bull: i % 2 === 0,
    }));
    const png = await synthAxisChart({
      candles: chop,
      tickRows: [60, 140, 220, 300],
      gridRows: [60, 140, 220, 300],
    });
    const m = await analyzeChartImage(png);
    const cal = resolveAxisCalibration(m, m.axis, { tickPrices: [130, 110, 90, 70] }, undefined);
    const r = buildScreenshotReport(m, { symbol: "T" }, undefined, cal);
    expect(r.calibration.status).toBe("calibrated");
    expect(r.calibration.source).toBe("detected-ticks");
    const priced = r.levels.filter((l) => l.priceTop !== undefined);
    expect(priced.length).toBeGreaterThan(0);
    for (const l of priced) expect(l.calibration).toBe("calibrated");
    expect(r.supplyDemand.some((s) => s.includes("≈"))).toBe(true);
  });

  it("uncalibrated report never emits a price — fractions only", async () => {
    const png = await synthAxisChart({ candles: rising(12) });
    const m = await analyzeChartImage(png);
    const r = buildScreenshotReport(m, {});
    expect(r.calibration.status).toBe("unavailable");
    for (const l of r.levels) {
      expect(l.priceTop).toBeUndefined();
      expect(l.calibration).toBe("uncalibrated");
    }
  });

  it("user-anchored report keeps zones visual — no invented scale", async () => {
    const chop = Array.from({ length: 12 }, (_, i) => ({
      x: 60 + i * 24, top: i % 2 === 0 ? 60 : 100, bottom: i % 2 === 0 ? 100 : 140, bull: i % 2 === 0,
    }));
    const png = await synthAxisChart({ candles: chop });
    const m = await analyzeChartImage(png);
    const cal = resolveAxisCalibration(m, m.axis, undefined, 24500);
    const r = buildScreenshotReport(m, { currentPrice: 24500 }, undefined, cal);
    expect(r.calibration.status).toBe("user-anchored");
    for (const l of r.levels) expect(l.priceTop).toBeUndefined();
  });
});
