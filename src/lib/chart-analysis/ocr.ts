/**
 * OCR candidate processing (evaluation-only layer).
 *
 * This module is deliberately dependency-free: it consumes generic OCR word
 * boxes and never imports an OCR engine. It exists so the benchmark and any
 * future opt-in suggestion path share exactly one, testable set of rules:
 *
 * - Normalization is explicit about decimal/thousands ambiguity — a token
 *   that can be read two plausible ways is flagged, never silently chosen.
 * - Pairing ties a recognized value to a measured tick position only when
 *   the word's box actually covers that row inside the axis strip.
 * - Suggestion acceptance reuses the manual-calibration rules: ≥2
 *   unambiguous, monotonically-decreasing-down-screen anchors. Anything
 *   contradictory is rejected with reasons — it never overrides user input
 *   and never becomes a calibrated price by itself.
 */

export interface OcrWord {
  text: string;
  /** Pixel bounds in the source image. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** Engine confidence 0–100. */
  confidence: number;
}

export interface PriceToken {
  raw: string;
  value?: number;
  /** True when a second plausible reading exists — never auto-accept. */
  ambiguous: boolean;
  /** True when OCR character confusions were repaired to form the token. */
  corrected: boolean;
  reason?: string;
}

const CURRENCY = /^[+$€£₹¥\s]+|[+€£₹¥\s]+$/g;

/**
 * Parse an OCR token as a price. Handles currency symbols, thousands and
 * decimal separators, negatives, and common glyph confusions (O→0, l/I/|→1,
 * S→5, B→8) only inside otherwise-numeric tokens — repairs mark the token
 * `corrected`, which downstream acceptance treats as lower-trust.
 */
export function parsePriceToken(raw: string): PriceToken {
  let s = raw.trim().replace(CURRENCY, "").trim();
  if (s.length === 0) return { raw, ambiguous: false, corrected: false, reason: "empty after currency strip" };

  const negative = /^[-−–—]/.test(s);
  s = s.replace(/^[-−–—\s]+|[-−–—\s]+$/g, "");
  // Remove internal whitespace between digits ("24 500").
  s = s.replace(/(?<=\d)\s+(?=\d)/g, "");

  // Glyph repair inside numeric-ish tokens.
  let corrected = false;
  if (/[0-9]/.test(s) && /^[0-9OoIl|SB.,]+$/.test(s) && /[OoIl|SB]/.test(s)) {
    corrected = true;
    s = s.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1").replace(/S/g, "5").replace(/B/g, "8");
  }

  if (!/^[0-9.,]+$/.test(s)) return { raw, ambiguous: false, corrected, reason: "not numeric" };

  const dots = s.split(".").length - 1;
  const commas = s.split(",").length - 1;
  let value: number;
  let ambiguous = corrected;

  if (dots > 0 && commas > 0) {
    // Both separators: the LAST one is the decimal — unambiguous by position.
    const decSep = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    const thouSep = decSep === "," ? "." : ",";
    value = Number(s.split(thouSep).join("").replace(decSep, "."));
  } else if (commas > 0) {
    if (commas === 1) {
      const frac = s.split(",")[1];
      if (frac.length === 3) {
        // "24,500": thousands → 24500 (US) or decimal → 24.5 (EU). Genuinely ambiguous.
        value = Number(s.replace(",", ""));
        ambiguous = true;
      } else {
        value = Number(s.replace(",", ".")); // "24,50" → 24.50 decimal
      }
    } else {
      value = Number(s.split(",").join("")); // multiple commas = thousands
    }
  } else if (dots > 0) {
    if (dots === 1) {
      const frac = s.split(".")[1];
      if (frac.length === 3) {
        // "24.500": decimal 24.5 (US) or thousands 24500 (EU). Ambiguous — prefer decimal.
        value = Number(s);
        ambiguous = true;
      } else {
        value = Number(s);
      }
    } else {
      value = Number(s.split(".").join("")); // "1.234.567" European thousands
      ambiguous = true; // could equally be a misread — flag it
    }
  } else {
    value = Number(s);
  }

  if (!Number.isFinite(value)) return { raw, ambiguous: false, corrected, reason: "not finite" };
  return { raw, value: negative ? -value : value, ambiguous, corrected };
}

export interface PairedLabel {
  tickIndex: number;
  rowY: number;
  token: PriceToken;
  word: OcrWord;
}

/**
 * Pair OCR words to detected tick rows. A word pairs when its vertical center
 * lies within `tolerancePx` of the tick row AND its box intersects the axis
 * strip region. Words inside the strip that pair to nothing are returned as
 * `stray` — the false-positive pool.
 */
export function pairWordsToTicks(
  words: OcrWord[],
  ticks: { y: number; height: number }[],
  strip: { x0: number; x1: number },
  tolerancePx: number,
): { pairs: PairedLabel[]; stray: OcrWord[]; unpairedTicks: number[] } {
  const inStrip = (w: OcrWord) => w.bbox.x1 > strip.x0 && w.bbox.x0 < strip.x1;
  const pairs: PairedLabel[] = [];
  const stray: OcrWord[] = [];
  const usedTicks = new Set<number>();
  const usedWords = new Set<OcrWord>();

  for (const w of words.filter(inStrip)) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    let best = -1;
    let bestD = tolerancePx + 1;
    ticks.forEach((t, i) => {
      if (usedTicks.has(i)) return;
      const d = Math.abs(cy - t.y);
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    });
    if (best >= 0) {
      const token = parsePriceToken(w.text);
      if (token.value !== undefined) {
        pairs.push({ tickIndex: best, rowY: ticks[best].y, token, word: w });
        usedTicks.add(best);
        usedWords.add(w);
      } else {
        stray.push(w); // non-numeric text sitting in the axis strip
      }
    } else {
      stray.push(w);
    }
  }
  const unpairedTicks = ticks.map((_, i) => i).filter((i) => !usedTicks.has(i));
  return { pairs, stray, unpairedTicks };
}

export type OcrSuggestionStatus = "suggested" | "ambiguous" | "rejected";

export interface OcrSuggestion {
  status: OcrSuggestionStatus;
  /** Accepted anchors — ONLY unambiguous, confident, monotonic-consistent pairs. */
  anchors: { rowY: number; price: number; raw: string; confidence: number; corrected: boolean }[];
  reasons: string[];
  /** Coverage: paired-anchors / detected ticks. */
  coverage: number;
  strayCount: number;
}

export interface SuggestionOptions {
  minConfidence?: number;
  /** Minimum fraction of detected ticks that must pair to accept. */
  minCoverage?: number;
}

/**
 * Decide whether OCR pairs may be offered as a calibration SUGGESTION.
 * The bar mirrors manual calibration: ≥2 anchors, strictly decreasing values
 * down-screen, no ambiguous tokens. Contradictions are reported, not repaired.
 */
export function evaluateSuggestion(
  pairs: PairedLabel[],
  tickCount: number,
  strayCount: number,
  opts: SuggestionOptions = {},
): OcrSuggestion {
  const minConf = opts.minConfidence ?? 60;
  const minCoverage = opts.minCoverage ?? 0.6;
  const reasons: string[] = [];
  const confident = pairs.filter((p) => p.word.confidence >= minConf);
  const dropped = pairs.length - confident.length;
  if (dropped > 0) reasons.push(`${dropped} low-confidence label${dropped > 1 ? "s" : ""} dropped (<${minConf}).`);
  const unamb = confident.filter((p) => !p.token.ambiguous);
  const amb = confident.length - unamb.length;
  if (amb > 0) reasons.push(`${amb} label${amb > 1 ? "s" : ""} rejected — ambiguous separator/confusion reading.`);
  const corrected = unamb.filter((p) => p.token.corrected).length;
  if (corrected > 0) reasons.push(`${corrected} anchor${corrected > 1 ? "s" : ""} used glyph-confusion repair — lower trust.`);

  const anchors = unamb
    .sort((a, b) => a.rowY - b.rowY)
    .map((p) => ({ rowY: p.rowY, price: p.token.value!, raw: p.token.raw, confidence: p.word.confidence, corrected: p.token.corrected }));
  const coverage = tickCount > 0 ? anchors.length / tickCount : 0;

  let contradiction = false;
  for (let i = 1; i < anchors.length; i += 1) {
    if (anchors[i].price >= anchors[i - 1].price) {
      contradiction = true;
      reasons.push(`OCR values not strictly decreasing down-screen: ${anchors[i - 1].price} → ${anchors[i].price} — read error or duplicate.`);
    }
  }

  let status: OcrSuggestionStatus = "suggested";
  if (anchors.length < 2) {
    status = "rejected";
    reasons.push(anchors.length === 1 ? "Only one usable label — a point, not a scale." : "No usable numeric labels paired to tick positions.");
  } else if (contradiction) {
    status = "rejected";
  } else if (coverage < minCoverage) {
    status = "ambiguous";
    reasons.push(`Only ${anchors.length}/${tickCount} tick positions matched (${Math.round(coverage * 100)}% < ${Math.round(minCoverage * 100)}%).`);
  } else if (corrected > 0 || amb > 0) {
    status = "ambiguous";
  }
  return { status, anchors, reasons, coverage, strayCount: strayCount };
}
