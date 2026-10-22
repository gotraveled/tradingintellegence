import type { Candle } from "@/lib/types";
import { atr, ema, type TradeSignal } from "./analysis";

/**
 * S/R + Trend — the whole trading engine, kept deliberately simple:
 *
 *  1. Find MAJOR levels: swing pivots (3-bar fractals) over the recent tape,
 *    clustered within 0.4×ATR — a level is only real once price has
 *    respected it ≥2 times.
 *  2. Read the trend: EMA20 vs EMA50 plus where price sits vs EMA50.
 *    No trend → no trade. We only trade WITH it.
 *  3. Entry: price tagged a level and held it (wick through allowed, close
 *    back on the level's side required) — the classic "support held" /
 *    "resistance rejected" play every discretionary trader takes.
 *  4. Stop just beyond the level's tag extreme (level invalidated = out).
 *     Target the next opposing level — the trade is always level-to-level,
 *     never a blind multiple. If no opposing level exists yet (fresh
 *     trend territory) the fallback is 2R.
 *
 * One signal per tape, evaluated on CLOSED bars only by the caller.
 */

export const SR_STRATEGY_ID = "sr";

export interface SrLevel {
  price: number;
  kind: "support" | "resistance";
  /** How many swing pivots made this level — strength of the level. */
  touches: number;
}

const LOOKBACK = 160; // bars scanned for pivots
const PIVOT_W = 3; // fractal half-window
const CLUSTER_ATR = 0.4; // pivots closer than this merge into one level
const MIN_TOUCHES = 2; // a level needs this many respects to be "major"
const TAG_ATR = 0.35; // "price is at the level" tolerance
const TAG_BARS = 4; // the tag may be this many closed bars old
const STOP_PAD_ATR = 0.25; // stop buffer beyond the tag extreme
const MIN_RR = 1.2; // target must clear this or the trade is skipped
const FALLBACK_RR = 2; // no opposing level → fixed target
const RUNNER_RR = 3.5; // TP2 fallback when no further level exists

interface Pivot {
  price: number;
  kind: "support" | "resistance";
}

function pivots(hist: Candle[]): Pivot[] {
  const out: Pivot[] = [];
  const start = Math.max(PIVOT_W, hist.length - LOOKBACK);
  for (let i = start; i < hist.length - PIVOT_W; i += 1) {
    const c = hist[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - PIVOT_W; j <= i + PIVOT_W; j += 1) {
      if (j === i) continue;
      if (hist[j].high >= c.high) isHigh = false;
      if (hist[j].low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ price: c.high, kind: "resistance" });
    if (isLow) out.push({ price: c.low, kind: "support" });
  }
  return out;
}

/** Cluster pivots into levels — merged center weighted by touch count. */
function cluster(ps: Pivot[], radius: number): SrLevel[] {
  const lvls: SrLevel[] = [];
  for (const p of [...ps].sort((a, b) => a.price - b.price)) {
    const hit = lvls.find((l) => l.kind === p.kind && Math.abs(l.price - p.price) <= radius);
    if (hit === undefined) {
      lvls.push({ price: p.price, kind: p.kind, touches: 1 });
    } else {
      hit.price = (hit.price * hit.touches + p.price) / (hit.touches + 1);
      hit.touches += 1;
    }
  }
  return lvls;
}

/** Major support/resistance levels over the recent tape — chart + engine share these. */
export function majorLevels(hist: Candle[]): SrLevel[] {
  if (hist.length < 40) return [];
  const width = atr(hist, 14) || hist[hist.length - 1].close * 0.002;
  return cluster(pivots(hist), width * CLUSTER_ATR).filter((l) => l.touches >= MIN_TOUCHES);
}

/** EMA20/50 + price position → the regime, or undefined when mixed. */
function trendOf(hist: Candle[]): "bullish" | "bearish" | undefined {
  const closes = hist.map((c) => c.close);
  const f = ema(closes, 20);
  const s = ema(closes, 50);
  if (f.length === 0 || s.length === 0) return undefined;
  const emaF = f[f.length - 1];
  const emaS = s[s.length - 1];
  const price = closes[closes.length - 1];
  if (emaF > emaS && price > emaS) return "bullish";
  if (emaF < emaS && price < emaS) return "bearish";
  return undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The single entry evaluator — needs ≥60 closed bars.
 * Bullish: nearest support tagged & held in an uptrend → buy, stop under
 * the level, target the next resistance. Bearish: mirror at resistance.
 */
export function srTrendSignal(hist: Candle[]): TradeSignal | undefined {
  if (hist.length < 60) return undefined;
  const last = hist[hist.length - 1];
  const entry = last.close;
  const width = atr(hist, 14);
  if (width === 0) return undefined;
  const dir = trendOf(hist);
  if (dir === undefined) return undefined;

  const levels = majorLevels(hist);
  const bull = dir === "bullish";
  // Levels that qualify for this side: below price for longs, above for
  // shorts — nearest first.
  const near = levels
    .filter((l) => l.kind === (bull ? "support" : "resistance"))
    .filter((l) => (bull ? l.price <= entry + TAG_ATR * width : l.price >= entry - TAG_ATR * width))
    .sort((a, b) => (bull ? b.price - a.price : a.price - b.price));

  for (const lvl of near) {
    // The tag: within the last TAG_BARS closed bars price reached the
    // level (wick tolerance TAG_ATR) and the last bar closed back on the
    // level's side — "held".
    const window = hist.slice(-TAG_BARS);
    const tagged = window.some((c) =>
      bull ? c.low <= lvl.price + TAG_ATR * width : c.high >= lvl.price - TAG_ATR * width,
    );
    const held = bull ? last.close > lvl.price : last.close < lvl.price;
    if (!tagged || !held) continue;

    const extreme = bull
      ? Math.min(...window.map((c) => c.low))
      : Math.max(...window.map((c) => c.high));
    const stop = bull ? Math.min(extreme, lvl.price) - STOP_PAD_ATR * width
                      : Math.max(extreme, lvl.price) + STOP_PAD_ATR * width;
    const risk = Math.abs(entry - stop);
    if (risk <= 0) continue;

    // Target: nearest OPPOSING level (level-to-level trading); fixed
    // fallback when the tape runs into uncharted territory.
    const opp = levels
      .filter((l) => (bull ? l.price > entry : l.price < entry))
      .sort((a, b) => (bull ? a.price - b.price : b.price - a.price));
    const tp1 = opp[0] !== undefined && Math.abs(opp[0].price - entry) >= MIN_RR * risk
      ? opp[0].price
      : opp[0] === undefined
        ? entry + (bull ? 1 : -1) * FALLBACK_RR * risk
        : undefined;
    if (tp1 === undefined) continue; // opposing level too close — no room
    const rr1 = Math.abs(tp1 - entry) / risk;
    const tp2 =
      opp[1] !== undefined && Math.abs(opp[1].price - entry) > Math.abs(tp1 - entry)
        ? opp[1].price
        : entry + (bull ? 1 : -1) * RUNNER_RR * risk;

    const confidence = Math.min(
      88,
      55 + lvl.touches * 4 + (Math.abs(tp1 - entry) >= 2 * risk ? 6 : 0),
    );
    return {
      direction: dir,
      confidence,
      factors: [],
      reasons: [
        `${dir === "bullish" ? "Uptrend" : "Downtrend"} — EMA20 ${bull ? "above" : "below"} EMA50, price ${bull ? "holding over" : "under"} it`,
        `${lvl.kind === "support" ? "Support" : "Resistance"} ${round2(lvl.price)} respected ${lvl.touches}× — ${bull ? "bounced off" : "rejected at"} the level`,
        `Plan: risk ${round2(risk)} to ${bull ? "resistance" : "support"} ${round2(tp1)} (${round2(rr1)}R); stop ${round2(stop)} sits ${bull ? "below" : "above"} the level`,
      ],
      entry,
      stopLoss: stop,
      riskReward: round2(rr1),
      targets: [
        { label: "TP1", price: tp1, rr: round2(rr1) },
        { label: "TP2", price: tp2, rr: round2(Math.abs(tp2 - entry) / risk) },
      ],
    };
  }
  return undefined;
}
