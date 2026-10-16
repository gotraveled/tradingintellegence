/**
 * Evidence regions — deterministic geometry validation (Phase P3).
 * Synthetic sharp-drawn charts: known features in → measured regions out.
 * Rects are normalized [0,1] against the ORIGINAL image; pixel bounds are
 * preserved so any preview size maps back exactly — these tests validate the
 * coordinate math, not real-world screenshot accuracy.
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { analyzeChartImage } from "../image-metrics";
import { buildEvidence, sanitizeEvidence, type EvidenceRegion } from "../evidence";
import { buildScreenshotReport } from "../report";
import { resolveAxisCalibration } from "../axis-calibration";

const GREEN = { r: 20, g: 200, b: 60 };
const RED = { r: 220, g: 40, b: 40 };
const BG = { r: 15, g: 15, b: 20 };
const TEXT = { r: 200, g: 200, b: 210 };

type Overlay = NonNullable<Parameters<ReturnType<typeof sharp>["composite"]>[0]>[number];

interface ChartSpec {
  w?: number; h?: number;
  tickRows?: number[];
  candles?: { x: number; top: number; bottom: number; bull: boolean }[];
  side?: "right" | "left";
}

async function synth(spec: ChartSpec): Promise<Buffer> {
  const w = spec.w ?? 600;
  const h = spec.h ?? 400;
  const composites: Overlay[] = [];
  const stripX = spec.side === "left" ? 8 : w - 60;
  for (const ty of spec.tickRows ?? []) {
    composites.push({ input: { create: { width: 24, height: 12, channels: 3, background: TEXT } }, top: ty - 6, left: stripX });
  }
  for (const c of spec.candles ?? []) {
    const color = c.bull ? GREEN : RED;
    composites.push({ input: { create: { width: 1, height: c.bottom - c.top, channels: 3, background: color } }, top: c.top, left: c.x });
    const bodyH = Math.max(2, Math.round((c.bottom - c.top) * 0.6));
    composites.push({ input: { create: { width: 4, height: bodyH, channels: 3, background: color } }, top: c.top + Math.round((c.bottom - c.top - bodyH) / 2), left: c.x - 1 });
  }
  return sharp({ create: { width: w, height: h, channels: 3, background: BG } }).composite(composites).png().toBuffer();
}

const rising = (n: number, x0 = 60): NonNullable<ChartSpec["candles"]> =>
  Array.from({ length: n }, (_, i) => ({ x: x0 + i * 24, top: 300 - i * 10, bottom: 340 - i * 10, bull: i % 3 !== 2 }));


describe("buildEvidence — regions trace to measured features", () => {
  it("emits one candle-cluster region per detected candle, observed basis", async () => {
    const png = await synth({ candles: rising(10) });
    const m = await analyzeChartImage(png);
    const ev = buildEvidence(m, []);
    const candles = ev.filter((r) => r.kind === "candle-cluster");
    expect(candles.length).toBe(m.candles.length);
    expect(candles.length).toBeGreaterThanOrEqual(8);
    for (const r of candles) {
      expect(r.basis).toBe("observed");
      expect(r.id).toMatch(/^candle-\d+$/);
    }
  });

  it("zone regions are inferred and carry levelIndex linkage", async () => {
    const chop = Array.from({ length: 12 }, (_, i) => ({ x: 60 + i * 24, top: i % 2 === 0 ? 60 : 100, bottom: i % 2 === 0 ? 100 : 140, bull: i % 2 === 0 }));
    const png = await synth({ candles: chop });
    const m = await analyzeChartImage(png);
    const r = buildScreenshotReport(m, {});
    const ev = buildEvidence(m, r.levels);
    const zones = ev.filter((e) => e.kind === "zone");
    expect(zones.length).toBe(m.zones.length);
    for (const z of zones) {
      expect(z.basis).toBe("inferred");
      expect(z.levelIndex).toBeDefined();
      expect(r.levels[z.levelIndex!]).toBeDefined();
      expect(z.id).toBe(`zone-${z.levelIndex}`);
    }
  });

  it("tick regions are observed, carry top→bottom tickIndex, not prices", async () => {
    const png = await synth({ tickRows: [80, 160, 240, 320] });
    const m = await analyzeChartImage(png);
    const ev = buildEvidence(m, []);
    const ticks = ev.filter((e) => e.kind === "axis-tick");
    expect(ticks.length).toBe(m.axis.ticks.length);
    expect(ticks.map((t) => t.tickIndex)).toEqual([0, 1, 2, 3]);
    for (const t of ticks) {
      expect(t.basis).toBe("observed");
      expect(t.method).toMatch(/NOT OCR/i);
    }
  });

  it("no features → no regions; nothing is fabricated", async () => {
    const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: BG } }).png().toBuffer();
    const m = await analyzeChartImage(png);
    expect(buildEvidence(m, [])).toHaveLength(0);
  });

  it("normalized rects round-trip to pixel bounds at any preview size", async () => {
    const png = await synth({ candles: rising(8), tickRows: [100, 200, 300] });
    const m = await analyzeChartImage(png);
    const ev = buildEvidence(m, []);
    for (const previewW of [300, 451, 1024]) {
      const scale = previewW / m.width;
      const previewH = m.height * scale;
      for (const r of ev) {
        const x = r.rect.x * previewW;
        const y = r.rect.y * previewH;
        const w = r.rect.w * previewW;
        const h = r.rect.h * previewH;
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + w).toBeLessThanOrEqual(previewW + 0.01);
        expect(y + h).toBeLessThanOrEqual(previewH + 0.01);
        // Round-trip: normalized × preview ≈ px × (preview/original)
        expect(x).toBeCloseTo(r.px.x0 * scale, 1);
        expect(w).toBeCloseTo((r.px.x1 - r.px.x0) * scale, 1);
      }
    }
  });

  it("rects stay inside [0,1] at varying image dimensions", async () => {
    for (const [w, h] of [[400, 300], [900, 500], [1280, 720]]) {
      const png = await synth({ w, h, candles: rising(6, 40), tickRows: [60, Math.round(h / 2), h - 60] });
      const m = await analyzeChartImage(png);
      const ev = buildEvidence(m, []);
      for (const r of ev) {
        expect(r.rect.x).toBeGreaterThanOrEqual(0);
        expect(r.rect.y).toBeGreaterThanOrEqual(0);
        expect(r.rect.x + r.rect.w).toBeLessThanOrEqual(1.001);
        expect(r.rect.y + r.rect.h).toBeLessThanOrEqual(1.001);
      }
    }
  });

  it("a bounding box carries no price meaning — basis is separate from calibration", async () => {
    const chop = Array.from({ length: 12 }, (_, i) => ({ x: 60 + i * 24, top: i % 2 === 0 ? 60 : 100, bottom: i % 2 === 0 ? 100 : 140, bull: i % 2 === 0 }));
    const png = await synth({ candles: chop });
    const m = await analyzeChartImage(png);
    const r = buildScreenshotReport(m, {});
    const ev = buildEvidence(m, r.levels);
    for (const e of ev) {
      expect(e).not.toHaveProperty("price");
      expect(e).not.toHaveProperty("priceTop");
    }
  });
});

describe("sanitizeEvidence — malformed regions are dropped, not repaired", () => {
  const good: EvidenceRegion = {
    id: "zone-0", kind: "zone", basis: "inferred",
    rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 },
    px: { x0: 60, y0: 80, x1: 360, y1: 200 },
    levelIndex: 0, method: "test", limitation: "test",
  };

  it("keeps valid regions untouched", () => {
    expect(sanitizeEvidence([good])).toEqual([good]);
  });

  it("drops non-finite rect values", () => {
    for (const bad of [
      { ...good, id: "a", rect: { ...good.rect, x: NaN } },
      { ...good, id: "b", rect: { ...good.rect, w: Infinity } },
      { ...good, id: "c", px: { ...good.px, x1: -Infinity } },
    ]) {
      expect(sanitizeEvidence([bad])).toHaveLength(0);
    }
  });

  it("drops out-of-bounds and zero-area rects", () => {
    for (const bad of [
      { ...good, id: "a", rect: { ...good.rect, x: -0.1 } },
      { ...good, id: "b", rect: { ...good.rect, x: 0.8, w: 0.4 } }, // x+w > 1
      { ...good, id: "c", rect: { ...good.rect, w: 0 } },
      { ...good, id: "d", rect: { ...good.rect, y: 0.95, h: 0.2 } },
    ]) {
      expect(sanitizeEvidence([bad])).toHaveLength(0);
    }
  });

  it("caps the region count", () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ ...good, id: `r-${i}` }));
    expect(sanitizeEvidence(many).length).toBe(500);
  });
});

describe("calibration guidance — candidates are not treated as confirmed labels", () => {
  it("detected ticks count is exposed for guidance, not auto-priced", async () => {
    const png = await synth({ candles: rising(12), tickRows: [80, 180, 280] });
    const m = await analyzeChartImage(png);
    const r = buildScreenshotReport(m, {});
    expect(r.calibration.ticksDetected).toBe(3);
    expect(r.calibration.status).toBe("unavailable"); // positions ≠ values
    for (const l of r.levels) expect(l.priceTop).toBeUndefined();
  });

  it("tick prices match candidate count → calibrated; mismatch → rejected guidance", async () => {
    const png = await synth({ candles: rising(12), tickRows: [80, 180, 280, 380] });
    const m = await analyzeChartImage(png);
    const ok = resolveAxisCalibration(m, m.axis, { tickPrices: [200, 150, 100, 50] }, undefined);
    expect(ok.status).toBe("calibrated");
    const bad = resolveAxisCalibration(m, m.axis, { tickPrices: [200, 150, 100] }, undefined);
    expect(bad.status).toBe("unavailable");
    expect(bad.warnings.join(" ")).toMatch(/ambiguous pairing/i);
  });

  it("zero anchors → unavailable; one → user-anchored; two+ → calibrated", async () => {
    const png = await synth({ candles: rising(12), tickRows: [80, 280] });
    const m = await analyzeChartImage(png);
    expect(resolveAxisCalibration(m, m.axis, undefined, undefined).status).toBe("unavailable");
    const one = resolveAxisCalibration(m, m.axis, undefined, 24500);
    expect(one.status).toBe("user-anchored");
    const two = resolveAxisCalibration(m, m.axis, { topPrice: 200, bottomPrice: 100 }, undefined);
    expect(two.status).toBe("calibrated");
    const multi = resolveAxisCalibration(m, { ...m.axis, ticks: [...m.axis.ticks, { y: 180, height: 12 }] }, { tickPrices: [200, 150, 100] }, undefined);
    expect(multi.status).toBe("calibrated");
    expect(multi.scale).toBeDefined();
  });
});
