/**
 * analyzeChartImage — deterministic pixel-analysis tests (Phase P1).
 * Charts are SYNTHESIZED with sharp itself: known candle geometry in,
 * measured metrics out — every assertion traces to drawn pixels.
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { analyzeChartImage, MIN_CANDLES_FOR_ANALYSIS } from "../image-metrics";
import { buildScreenshotReport } from "../report";

const GREEN = { r: 20, g: 200, b: 60 };
const RED = { r: 220, g: 40, b: 40 };
const BG = { r: 15, g: 15, b: 20 };

/** OverlayOptions via the composite signature — this sharp version doesn't
 *  export the namespace type on the default import. */
type Overlay = NonNullable<Parameters<ReturnType<typeof sharp>["composite"]>[0]>[number];

interface DrawnCandle { x: number; top: number; bottom: number; bull: boolean }

/** Rasterize candles: body 4px wide centered at x, wicks 1px at x. */
async function synthChart(candles: DrawnCandle[], w = 400, h = 300): Promise<Buffer> {
  const composites: Overlay[] = [];
  for (const c of candles) {
    const color = { create: { width: 0, height: 0, channels: 3 as const, background: c.bull ? GREEN : RED } };
    // wick (thin, full range)
    composites.push({
      input: { create: { ...color.create, width: 1, height: c.bottom - c.top } },
      top: c.top,
      left: c.x,
    });
    // body (wide, middle 60% of range)
    const bodyH = Math.max(2, Math.round((c.bottom - c.top) * 0.6));
    const bodyTop = c.top + Math.round((c.bottom - c.top - bodyH) / 2);
    composites.push({
      input: { create: { ...color.create, width: 4, height: bodyH } },
      top: bodyTop,
      left: c.x - 1,
    });
  }
  return sharp({ create: { width: w, height: h, channels: 3, background: BG } })
    .composite(composites)
    .png()
    .toBuffer();
}

/** Rising series: each candle's range shifts up (smaller y) → rising on screen. */
const rising = (n: number): DrawnCandle[] =>
  Array.from({ length: n }, (_, i) => ({
    x: 20 + i * 20,
    top: 200 - i * 8,
    bottom: 240 - i * 8,
    bull: i % 3 !== 2,
  }));

describe("analyzeChartImage — measured facts", () => {
  it("detects candle clusters in order with directions", async () => {
    const png = await synthChart(rising(10));
    const m = await analyzeChartImage(png);
    expect(m.candles.length).toBeGreaterThanOrEqual(8);
    expect(m.candles[0].x).toBeLessThan(m.candles[m.candles.length - 1].x);
    expect(m.bullishCount + m.bearishCount).toBe(m.candles.length);
  });

  it("measures a rising trend — negative screen slope, strong fit", async () => {
    const png = await synthChart(rising(12));
    const m = await analyzeChartImage(png);
    expect(m.trendSlope).toBeLessThan(0);
    expect(m.trendR2).toBeGreaterThan(0.5);
  });

  it("locates the last candle high in the range for a rising chart", async () => {
    const png = await synthChart(rising(10));
    const m = await analyzeChartImage(png);
    expect(m.lastClosePosition).toBeGreaterThan(0.7);
  });

  it("reports zero candles for a blank or non-chart image", async () => {
    const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: BG } })
      .png()
      .toBuffer();
    const m = await analyzeChartImage(png);
    expect(m.candles).toHaveLength(0);
  });

  it("rejects an undecodable buffer — the route maps it to 422", async () => {
    await expect(analyzeChartImage(Buffer.from("definitely not an image"))).rejects.toThrow();
  });
});

describe("buildScreenshotReport — honest verdicts", () => {
  it("no_trade when nothing was detected — never a forced read", async () => {
    const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: BG } })
      .png()
      .toBuffer();
    const m = await analyzeChartImage(png);
    const r = buildScreenshotReport(m, {});
    expect(r.verdict).toBe("no_trade");
    expect(r.scenarios).toHaveLength(0);
    expect(r.limitations.length).toBeGreaterThan(0);
  });

  it("produces a structured analysis on a clear trend", async () => {
    const png = await synthChart(rising(12));
    const m = await analyzeChartImage(png);
    const r = buildScreenshotReport(m, { symbol: "TEST", horizon: "swing" });
    expect(r.facts.candleCount).toBeGreaterThanOrEqual(MIN_CANDLES_FOR_ANALYSIS);
    expect(["analysis", "wait"]).toContain(r.verdict);
    expect(r.facts.trendDirection).toBeDefined();
  });

  it("zones report range fractions — not invented prices — when no anchor is given", async () => {
    // Chop: alternating highs/lows at the same levels → repeated touches.
    const chop: DrawnCandle[] = Array.from({ length: 12 }, (_, i) => ({
      x: 20 + i * 20,
      top: i % 2 === 0 ? 60 : 100,
      bottom: i % 2 === 0 ? 100 : 140,
      bull: i % 2 === 0,
    }));
    const png = await synthChart(chop);
    const m = await analyzeChartImage(png);
    const r = buildScreenshotReport(m, {});
    expect(r.limitations.some((l) => l.includes("fractions"))).toBe(true);
    for (const z of r.supplyDemand) {
      expect(z).toContain("image height"); // relative, never an invented price
    }
  });
});
