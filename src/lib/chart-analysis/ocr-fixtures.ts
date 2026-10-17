/**
 * OCR benchmark fixtures — SYNTHETIC images with fully known ground truth.
 * Rendered via sharp SVG composites (real antialiased text where sharp's
 * font stack supports it). These validate the pipeline's geometry and
 * parsing; they are NOT representative of every real trading screenshot —
 * real-world coverage is a documented benchmark limitation.
 */
import sharp from "sharp";

export interface FixtureLabel {
  /** Exact text drawn on the image. */
  text: string;
  /** Numeric value it unambiguously represents (undefined when ambiguous). */
  value?: number;
  /** Drawn bounding box in pixels. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrFixture {
  id: string;
  category: "clean" | "difficult" | "false-positive" | "no-axis";
  description: string;
  side: "left" | "right" | "none";
  /** True when the labeled axis could support calibration. */
  eligible: boolean;
  difficulty?: string;
  labels: FixtureLabel[];
  /** Non-axis text drawn on the image (false-positive candidates). */
  decoys: FixtureLabel[];
  render: () => Promise<Buffer>;
}

interface TextSpec {
  text: string;
  x: number;
  y: number;
  size: number;
  color: string;
  rotate?: number;
}

const svgText = (t: TextSpec): { input: Buffer; top: number; left: number } => {
  const w = Math.ceil(t.text.length * t.size * 0.62) + 8;
  const h = Math.ceil(t.size * 1.4) + 8;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w + 20}" height="${h + 20}">` +
      `<g transform="${t.rotate ? `rotate(${t.rotate} ${w / 2} ${h / 2})` : ""}">` +
      `<text x="8" y="${t.size + 4}" font-family="Arial" font-size="${t.size}" fill="${t.color}">${t.text}</text></g></svg>`,
  );
  return { input: svg, top: t.y, left: t.x };
};

const candles = (n: number, x0: number, dir: 1 | -1, bull = true) =>
  Array.from({ length: n }, (_, i) => ({
    input: {
      create: {
        width: 6,
        height: 40,
        channels: 3 as const,
        background: (i % 3 === 2) !== bull ? { r: 220, g: 40, b: 40 } : { r: 20, g: 200, b: 60 },
      },
    },
    top: 200 - dir * i * 8,
    left: x0 + i * 26,
  }));

interface BaseSpec {
  w: number; h: number; bg: { r: number; g: number; b: number };
  side: "left" | "right"; axisLabels: { text: string; value?: number; y: number }[];
  axisSize?: number; axisColor?: string;
  decoyTexts?: { text: string; x: number; y: number; size?: number }[];
  extra?: { input: Buffer; top: number; left: number }[];
}

function makeFixture(
  id: string,
  category: OcrFixture["category"],
  description: string,
  spec: BaseSpec,
  opts: { eligible?: boolean; difficulty?: string } = {},
): OcrFixture {
  const stripW = Math.min(110, Math.floor(spec.w * 0.14));
  const labelX = spec.side === "right" ? spec.w - stripW + 8 : 8;
  const size = spec.axisSize ?? 18;
  const labels: FixtureLabel[] = spec.axisLabels.map((l) => ({
    text: l.text,
    value: l.value,
    bbox: { x0: labelX, y0: l.y, x1: labelX + Math.ceil(l.text.length * size * 0.62), y1: l.y + Math.ceil(size * 1.4) },
  }));
  const decoys: FixtureLabel[] = (spec.decoyTexts ?? []).map((d) => ({
    text: d.text,
    bbox: { x0: d.x, y0: d.y, x1: d.x + Math.ceil(d.text.length * (d.size ?? 14) * 0.62), y1: d.y + Math.ceil((d.size ?? 14) * 1.4) },
  }));
  const render = async () => {
    const comps = [
      ...candles(12, spec.side === "left" ? stripW + 20 : 40, 1),
      ...spec.axisLabels.map((l) => svgText({ text: l.text, x: labelX, y: l.y, size, color: spec.axisColor ?? "#b8b8c8" })),
      ...(spec.decoyTexts ?? []).map((d) => svgText({ text: d.text, x: d.x, y: d.y, size: d.size ?? 14, color: "#888899" })),
      ...(spec.extra ?? []),
    ];
    return sharp({ create: { width: spec.w, height: spec.h, channels: 3, background: spec.bg } }).composite(comps).png().toBuffer();
  };
  return { id, category, description, side: spec.side, eligible: opts.eligible ?? category === "clean", difficulty: opts.difficulty, labels, decoys, render };
}

const DARK = { r: 15, g: 15, b: 20 };
const LIGHT = { r: 242, g: 243, b: 245 };

export const OCR_FIXTURES: OcrFixture[] = [
  makeFixture("dark-right-ints", "clean", "Dark theme, right axis, integer prices", {
    w: 640, h: 400, bg: DARK, side: "right",
    axisLabels: [
      { text: "25,000", value: 25000, y: 40 },
      { text: "24,500", value: 24500, y: 130 },
      { text: "24,000", value: 24000, y: 220 },
      { text: "23,500", value: 23500, y: 310 },
    ],
  }),
  makeFixture("light-left-decimals", "clean", "Light theme, left axis, 4-decimal FX prices", {
    w: 640, h: 400, bg: LIGHT, side: "left", axisColor: "#3a3a44",
    axisLabels: [
      { text: "1.2550", value: 1.255, y: 40 },
      { text: "1.2450", value: 1.245, y: 130 },
      { text: "1.2350", value: 1.235, y: 220 },
      { text: "1.2250", value: 1.225, y: 310 },
    ],
  }),
  makeFixture("small-font-12", "clean", "12px axis labels — legibility floor", {
    w: 640, h: 400, bg: DARK, side: "right", axisSize: 12,
    axisLabels: [
      { text: "4100", value: 4100, y: 40 },
      { text: "4050", value: 4050, y: 140 },
      { text: "4000", value: 4000, y: 240 },
      { text: "3950", value: 3950, y: 330 },
    ],
  }, { difficulty: "borderline font size" }),
  makeFixture("euro-decimal-comma", "difficult", "European formatting: comma decimals, dot thousands", {
    w: 640, h: 400, bg: DARK, side: "right",
    axisLabels: [
      { text: "1.250,00", value: 1250, y: 60 },
      { text: "1.200,00", value: 1200, y: 160 },
      { text: "1.150,00", value: 1150, y: 260 },
      { text: "1.100,00", value: 1100, y: 340 },
    ],
  }, { difficulty: "both separators — positional rule required" }),
  makeFixture("negatives-and-currency", "difficult", "Negative values and a currency symbol", {
    w: 640, h: 400, bg: DARK, side: "right",
    axisLabels: [
      { text: "$50.00", value: 50, y: 50 },
      { text: "0.00", value: 0, y: 170 },
      { text: "-50.00", value: -50, y: 290 },
    ],
  }, { difficulty: "sign + symbol stripping" }),
  makeFixture("faint-low-contrast", "difficult", "Low-contrast axis text on dark bg", {
    w: 640, h: 400, bg: DARK, side: "right", axisColor: "#4a4a55",
    axisLabels: [
      { text: "100", value: 100, y: 60 },
      { text: "90", value: 90, y: 190 },
      { text: "80", value: 80, y: 320 },
    ],
  }, { difficulty: "contrast ratio ≈3:1" }),
  makeFixture("cropped-edge", "difficult", "Labels partially clipped by the image edge", {
    w: 640, h: 400, bg: DARK, side: "right",
    axisLabels: [
      { text: "2,400", value: 2400, y: 80 },
      { text: "2,300", value: 2300, y: 200 },
      { text: "2,200", value: 2200, y: 395 }, // bottom clip
    ],
  }, { difficulty: "last label overflows the canvas" }),
  makeFixture("slanted-8deg", "difficult", "Perspective-distorted axis (8° rotation)", {
    w: 640, h: 400, bg: DARK, side: "right",
    axisLabels: [],
    extra: [
      svgText({ text: "9800", x: 590, y: 60, size: 18, color: "#b8b8c8", rotate: 8 }),
      svgText({ text: "9600", x: 596, y: 200, size: 18, color: "#b8b8c8", rotate: 8 }),
    ],
  }, { eligible: false, difficulty: "rotated text — expected to degrade" }),
  makeFixture("legend-decoys", "false-positive", "Non-axis text near the strip: symbol, volume, timestamp", {
    w: 640, h: 400, bg: DARK, side: "right",
    axisLabels: [
      { text: "150", value: 150, y: 60 },
      { text: "140", value: 140, y: 200 },
      { text: "130", value: 130, y: 340 },
    ],
    decoyTexts: [
      { text: "BTC/USD", x: 20, y: 15 },
      { text: "Volume 1.2M", x: 20, y: 355 },
      { text: "14:32", x: 300, y: 355 },
    ],
  }),
  makeFixture("no-axis", "no-axis", "Candles only — no readable axis at all", {
    w: 640, h: 400, bg: DARK, side: "right", axisLabels: [],
  }, { eligible: false }),
];
