import type { Candle, Direction } from "@/lib/types";

/**
 * Candlestick / chart-pattern confirmations — the classic price-action
 * readings layered under the zone engines. Every detector is mechanical:
 * it reads only the tail of the tape it is given and returns named hits
 * with a direction, so engines can count how many patterns AGREE with a
 * proposed side before trusting it.
 *
 * Patterns and their confirmation weight:
 *  - Hammer / shooting star, bullish/bearish engulfing, morning/evening
 *    star, three soldiers/crows → 1 confirmation each.
 *  - W bottom / M top (double pivot with neckline break) → 2, the two
 *    swings are themselves two touches of the level.
 */

export interface PatternHit {
  name: string;
  direction: Direction;
  /** Confirmation weight — W/M count double (two defended swings). */
  weight: number;
}

const STAR_BODY_SHARE = 0.4; // middle star body ≤ this share of bar1 body
const ENGULF_EPS = 1e-9;

function body(c: Candle): number {
  return Math.abs(c.close - c.open);
}
function upperWick(c: Candle): number {
  return c.high - Math.max(c.open, c.close);
}
function lowerWick(c: Candle): number {
  return Math.min(c.open, c.close) - c.low;
}
function green(c: Candle): boolean {
  return c.close > c.open;
}
function red(c: Candle): boolean {
  return c.close < c.open;
}

/** Single-bar wick rejections — hammer at lows, shooting star at highs. */
function wickRejection(c: Candle): PatternHit[] {
  const b = Math.max(body(c), 1e-9);
  const lo = lowerWick(c);
  const up = upperWick(c);
  const out: PatternHit[] = [];
  if (lo >= 2 * b && lo >= 2.5 * up) {
    out.push({ name: "Hammer", direction: "bullish", weight: 1 });
  }
  if (up >= 2 * b && up >= 2.5 * lo) {
    out.push({ name: "Shooting star", direction: "bearish", weight: 1 });
  }
  return out;
}

/** Two-bar engulfing — the second body swallows the first. */
function engulfing(prev: Candle, cur: Candle): PatternHit | undefined {
  if (red(prev) && green(cur) && cur.open <= prev.close + ENGULF_EPS && cur.close > prev.open) {
    return { name: "Bullish engulfing", direction: "bullish", weight: 1 };
  }
  if (green(prev) && red(cur) && cur.open >= prev.close - ENGULF_EPS && cur.close < prev.open) {
    return { name: "Bearish engulfing", direction: "bearish", weight: 1 };
  }
  return undefined;
}

/** Three-bar stars — strong bar, small star, strong reversal bar. */
function star(a: Candle, s: Candle, c: Candle): PatternHit | undefined {
  const aBody = body(a);
  const sBody = body(s);
  const cBody = body(c);
  if (aBody === 0 || cBody === 0) return undefined;
  const mid = (a.open + a.close) / 2;
  if (red(a) && sBody <= STAR_BODY_SHARE * aBody && green(c) && cBody >= 0.5 * aBody && c.close > mid) {
    return { name: "Morning star", direction: "bullish", weight: 1 };
  }
  if (green(a) && sBody <= STAR_BODY_SHARE * aBody && red(c) && cBody >= 0.5 * aBody && c.close < mid) {
    return { name: "Evening star", direction: "bearish", weight: 1 };
  }
  return undefined;
}

/** Three consecutive strong same-direction bodies — soldiers / crows. */
function threeRun(a: Candle, b: Candle, c: Candle): PatternHit | undefined {
  const strong = (x: Candle): boolean => body(x) >= 0.55 * (x.high - x.low || 1e-9);
  if (green(a) && green(b) && green(c) && [a, b, c].every(strong) && c.close > b.close && b.close > a.close) {
    return { name: "Three white soldiers", direction: "bullish", weight: 1 };
  }
  if (red(a) && red(b) && red(c) && [a, b, c].every(strong) && c.close < b.close && b.close < a.close) {
    return { name: "Three black crows", direction: "bearish", weight: 1 };
  }
  return undefined;
}

interface Pivot {
  index: number;
  price: number;
}

function pivots(cs: Candle[], k: number): { highs: Pivot[]; lows: Pivot[] } {
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];
  for (let i = k; i < cs.length - k; i += 1) {
    let hi = true;
    let lo = true;
    for (let j = i - k; j <= i + k; j += 1) {
      if (j === i) continue;
      if (cs[j].high >= cs[i].high) hi = false;
      if (cs[j].low <= cs[i].low) lo = false;
    }
    if (hi) highs.push({ index: i, price: cs[i].high });
    if (lo) lows.push({ index: i, price: cs[i].low });
  }
  return { highs, lows };
}

/**
 * W bottom / M top over the last ~30 bars: two pivots of the same kind at
 * nearly the same price, the intervening swing as neckline, and a close
 * already through the neckline within the pattern's tail.
 */
function doublePattern(cs: Candle[]): PatternHit[] {
  const out: PatternHit[] = [];
  const window = cs.slice(-30);
  if (window.length < 12) return out;
  const { highs, lows } = pivots(window, 2);
  const lastClose = window[window.length - 1].close;
  const lastIdx = window.length - 1;
  const TOL = 0.0015; // twin pivots within 0.15% of each other

  for (let i = lows.length - 2; i >= 0; i -= 1) {
    const a = lows[i];
    const b = lows[i + 1];
    if (b.index - a.index < 3) continue;
    if (Math.abs(a.price - b.price) / Math.min(a.price, b.price) > TOL) continue;
    if (lastIdx - b.index > 8) continue; // stale — reaction must be fresh
    const neck = Math.max(...window.slice(a.index, b.index + 1).map((c) => c.high));
    if (lastClose > neck) {
      out.push({ name: "W bottom", direction: "bullish", weight: 2 });
      break; // latest pair only
    }
  }
  for (let i = highs.length - 2; i >= 0; i -= 1) {
    const a = highs[i];
    const b = highs[i + 1];
    if (b.index - a.index < 3) continue;
    if (Math.abs(a.price - b.price) / Math.max(a.price, b.price) > TOL) continue;
    if (lastIdx - b.index > 8) continue;
    const neck = Math.min(...window.slice(a.index, b.index + 1).map((c) => c.low));
    if (lastClose < neck) {
      out.push({ name: "M top", direction: "bearish", weight: 2 });
      break;
    }
  }
  return out;
}

/**
 * Every pattern visible on the tape's tail — the last 3 bars for
 * candlestick readings, the last ~30 for double pivots. Engines count the
 * weight of hits that AGREE with their proposed side.
 */
export function candlePatterns(candles: Candle[]): PatternHit[] {
  const out: PatternHit[] = [];
  const n = candles.length;
  if (n < 3) return out;
  const [a, b, c] = [candles[n - 3], candles[n - 2], candles[n - 1]];
  out.push(...wickRejection(c));
  const eng = engulfing(b, c);
  if (eng !== undefined) out.push(eng);
  const st = star(a, b, c);
  if (st !== undefined) out.push(st);
  const run = threeRun(a, b, c);
  if (run !== undefined) out.push(run);
  out.push(...doublePattern(candles));
  return out;
}

/** Total confirmation weight of patterns agreeing with `dir`. */
export function patternConfirmations(candles: Candle[], dir: Direction): { score: number; names: string[] } {
  const hits = candlePatterns(candles).filter((h) => h.direction === dir);
  return { score: hits.reduce((s, h) => s + h.weight, 0), names: hits.map((h) => h.name) };
}
