/**
 * OCR candidate processing — pure-layer tests. No OCR engine required:
 * the parsing, pairing, and acceptance rules are dependency-free by design.
 * The engine-specific benchmark lives in ocr-benchmark.test.ts (env-gated).
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  evaluateSuggestion,
  pairWordsToTicks,
  parsePriceToken,
  type OcrWord,
} from "../ocr";
import { isOcrAvailable, runLocalOcr } from "../ocr-runtime";

describe("parsePriceToken — numeric normalization", () => {
  it.each([
    ["24,500.50", 24500.5],
    ["24.500,50", 24500.5],
    ["1.250,00", 1250],
    ["1,250.00", 1250],
    ["24,50", 24.5],
    ["4100", 4100],
    ["1.2550", 1.255],
    ["-50.00", -50],
    ["$50.00", 50],
    ["€1.234,56", 1234.56],
    ["24 500", 24500],
    ["0.00", 0],
  ])("parses %s → %f", (raw, value) => {
    const t = parsePriceToken(raw);
    expect(t.value).toBeCloseTo(value, 6);
    expect(t.ambiguous).toBe(false);
  });

  it.each([
    ["24,500", 24500],   // US thousands OR EU decimal 24.5 — ambiguous
    ["24.500", 24.5],    // decimal OR EU thousands 24500 — ambiguous
    ["1.234.567", 1234567],
  ])("flags %s ambiguous (value %f kept as best-effort)", (raw, value) => {
    const t = parsePriceToken(raw);
    expect(t.value).toBeCloseTo(value, 6);
    expect(t.ambiguous).toBe(true);
  });

  it("repairs glyph confusions inside numeric tokens and marks them corrected", () => {
    const a = parsePriceToken("l,250");
    expect(a.value).toBe(1250);
    expect(a.corrected).toBe(true);
    const b = parsePriceToken("S00");
    expect(b.value).toBe(500);
    expect(b.corrected).toBe(true);
  });

  it.each(["BTC/USD", "14:32", "Volume", "abc", ""])("rejects non-price text %s", (raw) => {
    expect(parsePriceToken(raw).value).toBeUndefined();
  });
});

describe("pairWordsToTicks — word↔tick geometric pairing", () => {
  const ticks = [{ y: 100, height: 12 }, { y: 200, height: 12 }, { y: 300, height: 12 }];
  const strip = { x0: 560, x1: 640 };
  const word = (text: string, cy: number, x0 = 570): OcrWord => ({
    text, confidence: 90, bbox: { x0, y0: cy - 7, x1: x0 + 60, y1: cy + 7 },
  });

  it("pairs words whose center lies inside tolerance of a tick row", () => {
    const { pairs, unpairedTicks } = pairWordsToTicks(
      [word("100", 103), word("90", 198)], ticks, strip, 14,
    );
    expect(pairs.map((p) => p.tickIndex)).toEqual([0, 1]);
    expect(unpairedTicks).toEqual([2]);
  });

  it("words outside tolerance become stray, never paired", () => {
    const { pairs, stray } = pairWordsToTicks([word("100", 150)], ticks, strip, 14);
    expect(pairs).toHaveLength(0);
    expect(stray).toHaveLength(1);
  });

  it("non-numeric text inside the strip is stray — a false positive caught", () => {
    const { pairs, stray } = pairWordsToTicks([word("Vol", 100), word("150", 100)], ticks, strip, 14);
    expect(pairs).toHaveLength(1);
    expect(stray).toHaveLength(1);
  });

  it("text outside the axis strip cannot pair at all", () => {
    const { pairs, stray } = pairWordsToTicks([word("150", 100, 100)], ticks, strip, 14);
    expect(pairs).toHaveLength(0);
    expect(stray).toHaveLength(0); // not an axis candidate — ignored entirely
  });

  it("nearest word wins when two compete for one tick", () => {
    const { pairs, stray } = pairWordsToTicks([word("100", 101), word("105", 110)], ticks, strip, 14);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].token.value).toBe(100);
    expect(stray).toHaveLength(1);
  });
});

describe("evaluateSuggestion — conservative acceptance rules", () => {
  const pair = (tickIndex: number, price: number, conf = 90, ambiguous = false) => ({
    tickIndex, rowY: tickIndex * 100 + 100,
    token: { raw: String(price), value: price, ambiguous, corrected: false },
    word: { text: String(price), confidence: conf, bbox: { x0: 570, y0: 0, x1: 630, y1: 10 } },
  });

  it("≥2 unambiguous monotonic pairs with full coverage → suggested", () => {
    const s = evaluateSuggestion([pair(0, 300), pair(1, 200), pair(2, 100)], 3, 0);
    expect(s.status).toBe("suggested");
    expect(s.anchors.map((a) => a.price)).toEqual([300, 200, 100]);
  });

  it("a single label is a point, not a scale — rejected like manual rules", () => {
    const s = evaluateSuggestion([pair(0, 300)], 3, 0);
    expect(s.status).toBe("rejected");
    expect(s.reasons.join(" ")).toMatch(/point, not a scale/i);
  });

  it("contradictory values (rising down-screen) → rejected, never repaired", () => {
    const s = evaluateSuggestion([pair(0, 300), pair(1, 350)], 2, 0);
    expect(s.status).toBe("rejected");
    expect(s.reasons.join(" ")).toMatch(/not strictly decreasing/i);
  });

  it("ambiguous separator readings are dropped — thin result downgrades", () => {
    const s = evaluateSuggestion([pair(0, 300), pair(1, 200, 90, true), pair(2, 100)], 3, 0);
    expect(s.anchors).toHaveLength(2); // ambiguous middle label excluded
    expect(s.status).toBe("ambiguous");
    expect(s.reasons.join(" ")).toMatch(/ambiguous/i);
  });

  it("low-confidence words are filtered before acceptance", () => {
    const s = evaluateSuggestion([pair(0, 300, 30), pair(1, 200, 30)], 2, 0, { minConfidence: 60 });
    expect(s.status).toBe("rejected");
    expect(s.reasons.join(" ")).toMatch(/low-confidence/i);
  });

  it("partial coverage below threshold → ambiguous, not suggested", () => {
    const s = evaluateSuggestion([pair(0, 300), pair(1, 200)], 5, 0, { minCoverage: 0.6 });
    expect(s.status).toBe("ambiguous");
    expect(s.coverage).toBeCloseTo(0.4, 5);
  });
});

describe("OCR runtime — disabled/absent path is honest and inert", () => {
  it("isOcrAvailable returns a boolean without throwing", async () => {
    expect(typeof (await isOcrAvailable())).toBe("boolean");
  });

  it("runLocalOcr degrades to unavailable or succeeds — never throws", async () => {
    // Real (blank) PNG: when the engine is installed the worker must still
    // return a structured result, not a thrown/unhandled worker error.
    const blank = await sharp({
      create: { width: 64, height: 24, channels: 3, background: { r: 20, g: 20, b: 20 } },
    }).png().toBuffer();
    const res = await runLocalOcr(blank);
    if (!res.available) {
      expect(res.words).toEqual([]);
      expect(res.reason).toBeTruthy();
    } else {
      expect(res.elapsedMs).toBeGreaterThan(0);
      expect(res.words).toEqual([]); // blank image → no words
    }
  });
});
