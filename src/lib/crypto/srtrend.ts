import type { Candle } from "@/lib/types";
import { atr, type TradeSignal } from "./analysis";

/**
 * S/R — the whole trading engine, kept deliberately simple:
 *
 *  1. Find MAJOR swing levels: a swing pivot is only real when a high/low
 *    is the extreme for 10 bars on each side (~50 min on 5m — the small
 *    wiggles don't count). Pivots within 0.5×ATR of each other merge into
 *    one zone, so repeated attempts at roughly the same price strengthen a
 *    level rather than duplicating it.
 *  2. Whichever level price interacts with decides direction — TWO plays:
 *       BOUNCE — support tagged and held → BUY; resistance tagged and
 *        rejected → SELL (the demand-zone / supply-zone play).
 *       BREAK — a decisive close through the level → trade the break:
 *        resistance broken → BUY, support broken → SELL.
 *     No trend filter — the level is the trade, in any regime.
 *  3. Stop just beyond the level — the tag extreme for bounces, the
 *     reclaim side for breaks (price back through = thesis dead).
 *     Target the next opposing level — always level-to-level, never a
 *     blind multiple. If no opposing level exists the fallback is 2R.
 *  4. Confluence scoring: an UNTESTED zone (first touch since formation),
 *     a LIQUIDITY SWEEP (wick through the level that closes back — the
 *     stop-run grab), and entry inside a matching FVG all raise
 *     confidence and are listed in the trade's reasons.
 *
 * One signal per tape, evaluated on CLOSED bars only by the caller.
 */

export const SR_STRATEGY_ID = "sr";

export interface SrLevel {
  price: number;
  kind: "support" | "resistance";
  /** How many swing pivots made this level — strength of the level. */
  touches: number;
  /** Bar index of the most recent pivot that formed this level. */
  formedIdx: number;
}
const LOOKBACK = 240; // bars scanned for pivots
const PIVOT_W = 10; // fractal half-window — only MAJOR swings qualify
const CLUSTER_ATR = 0.5; // pivots closer than this merge into one level
const MIN_TOUCHES = 2; // a level must be respected ≥2× — a lone wick is a pivot, not a zone
const TAG_ATR = 0.5; // "price is at the level" tolerance
const TAG_BARS = 4; // the tag may be this many closed bars old
const NEAR_ATR = 2.5; // candidate levels must be within this of price
const BREAK_PAD_ATR = 0.1; // a close must clear the level by this much = a break
const STOP_PAD_ATR = 0.25; // stop buffer beyond the tag extreme
const MIN_RR = 1.0; // target must clear this or the trade is skipped
const FALLBACK_RR = 2; // no opposing level → fixed target
const RUNNER_RR = 3.5; // TP2 fallback when no further level exists

interface Pivot {
  price: number;
  kind: "support" | "resistance";
  idx: number;
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
    if (isHigh) out.push({ price: c.high, kind: "resistance", idx: i });
    if (isLow) out.push({ price: c.low, kind: "support", idx: i });
  }
  return out;
}

/** Cluster pivots into levels — merged center weighted by touch count. */
function cluster(ps: Pivot[], radius: number): SrLevel[] {
  const lvls: SrLevel[] = [];
  for (const p of [...ps].sort((a, b) => a.price - b.price)) {
    const hit = lvls.find((l) => l.kind === p.kind && Math.abs(l.price - p.price) <= radius);
    if (hit === undefined) {
      lvls.push({ price: p.price, kind: p.kind, touches: 1, formedIdx: p.idx });
    } else {
      hit.price = (hit.price * hit.touches + p.price) / (hit.touches + 1);
      hit.touches += 1;
      hit.formedIdx = Math.max(hit.formedIdx, p.idx);
    }
  }
  return lvls;
}

/** Support/resistance levels over the recent tape — chart + engine share these. */
export function majorLevels(hist: Candle[]): SrLevel[] {
  if (hist.length < 40) return [];
  const width = atr(hist, 14) || hist[hist.length - 1].close * 0.002;
  return cluster(pivots(hist), width * CLUSTER_ATR).filter((l) => l.touches >= MIN_TOUCHES);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Recent fair-value gaps — the 3-candle imbalance zones price left unfilled. */
function recentFvgs(
  hist: Candle[],
  lookback = 30,
): { bullish: [number, number][]; bearish: [number, number][] } {
  const out = { bullish: [] as [number, number][], bearish: [] as [number, number][] };
  for (let i = Math.max(2, hist.length - lookback); i < hist.length; i += 1) {
    const up = hist[i].low - hist[i - 2].high; // bullish gap: bar i opened above bar i-2's high
    if (up > 0) out.bullish.push([hist[i - 2].high, hist[i].low]);
    const dn = hist[i - 2].low - hist[i].high; // bearish gap
    if (dn > 0) out.bearish.push([hist[i].high, hist[i - 2].low]);
  }
  return out;
}

/** True if price hasn't revisited the level since it formed — untested = stronger. */
function isFresh(hist: Candle[], lvl: SrLevel, width: number, tagBars: number): boolean {
  const band = TAG_ATR * width;
  const until = hist.length - tagBars; // exclude the current tag window
  // The bars right after the forming pivot are the departure, not a retest —
  // start counting only once price has fully left the level's band.
  let departed = -1;
  for (let i = lvl.formedIdx + 1; i < until; i += 1) {
    const c = hist[i];
    if (c.low > lvl.price + band || c.high < lvl.price - band) {
      departed = i;
      break;
    }
  }
  if (departed === -1) return false; // never left — this isn't a "return"
  for (let i = departed + 1; i < until; i += 1) {
    const c = hist[i];
    if (c.low <= lvl.price + band && c.high >= lvl.price - band) {
      return false; // it was retested before this tag
    }
  }
  return true;
}

/**
 * The single entry evaluator — needs ≥60 closed bars. Nearest major level
 * in play wins, and the play is whichever the tape shows:
 *   support held → BUY · resistance held → SELL        (bounce)
 *   resistance broke → BUY · support broke → SELL      (breakout)
 */
export function srTrendSignal(hist: Candle[]): TradeSignal | undefined {
  if (hist.length < 60) return undefined;
  const last = hist[hist.length - 1];
  const entry = last.close;
  const width = atr(hist, 14);
  if (width === 0) return undefined;

  const levels = majorLevels(hist);
  const window = hist.slice(-TAG_BARS);
  const winHigh = Math.max(...window.map((c) => c.high));
  const winLow = Math.min(...window.map((c) => c.low));
  // Candidates: price is ON the level (bounce side) OR the level sits
  // inside the recent range span where a break could just have crossed it.
  const near = levels
    .filter((l) => Math.abs(l.price - entry) <= NEAR_ATR * width)
    .filter((l) =>
      l.kind === "support"
        ? l.price <= entry + TAG_ATR * width || l.price <= winHigh
        : l.price >= entry - TAG_ATR * width || l.price >= winLow,
    )
    .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));

  for (const lvl of near) {
    const isSupport = lvl.kind === "support";
    // BOUNCE — the level was reached and the last bar closed on its side.
    const tagged = window.some((c) =>
      isSupport ? c.low <= lvl.price + TAG_ATR * width : c.high >= lvl.price - TAG_ATR * width,
    );
    const held = isSupport ? last.close > lvl.price : last.close < lvl.price;
    // BREAK — price was AT the level recently and the last bar closed
    // decisively through it (a margin of BREAK_PAD, not a wick poke).
    const wasAtLevel = window.some((c) =>
      isSupport ? c.high >= lvl.price - TAG_ATR * width : c.low <= lvl.price + TAG_ATR * width,
    );
    const broke = isSupport
      ? last.close < lvl.price - BREAK_PAD_ATR * width
      : last.close > lvl.price + BREAK_PAD_ATR * width;
    const bounce = held && tagged;
    const breakTrade = broke && wasAtLevel;
    if (!bounce && !breakTrade) continue;

    // Long when support holds OR resistance breaks; short on the mirrors.
    const long = isSupport ? bounce : breakTrade;
    const extreme = isSupport
      ? Math.min(...window.map((c) => c.low))
      : Math.max(...window.map((c) => c.high));
    // Bounce stop: beyond the tag extreme. Break stop: the far side of
    // the broken level — price reclaiming it kills the breakout.
    const stop = bounce
      ? long
        ? Math.min(extreme, lvl.price) - STOP_PAD_ATR * width
        : Math.max(extreme, lvl.price) + STOP_PAD_ATR * width
      : long
        ? lvl.price - STOP_PAD_ATR * width
        : lvl.price + STOP_PAD_ATR * width;
    const risk = Math.abs(entry - stop);
    if (risk <= 0) continue;

    // Confluences the user asked for — untested zone, liquidity sweep, FVG:
    //  • LIQUIDITY SWEEP — a recent bar's wick ran THROUGH the level (stop
    //    hunt / liquidity grab) and closed back on the level's side. The
    //    strongest form of the bounce: the stops already got taken.
    //  • UNTESTED — the level hasn't been revisited since it formed; the
    //    first touch of a fresh zone is the highest-quality tag.
    //  • FVG — entry or the level sits inside a recent fair-value gap on
    //    the trade's side — the imbalance backs the move.
    const swept = bounce && window.some((c) =>
      long
        ? c.low < lvl.price - BREAK_PAD_ATR * width && c.close > lvl.price
        : c.high > lvl.price + BREAK_PAD_ATR * width && c.close < lvl.price,
    );
    const fresh = isFresh(hist, lvl, width, TAG_BARS);
    const fvgs = recentFvgs(hist);
    const fvgHit = (long ? fvgs.bullish : fvgs.bearish).some(
      ([lo, hi]) =>
        (entry >= lo && entry <= hi) || (lvl.price >= lo && lvl.price <= hi),
    );

    // Target: nearest OPPOSING level (level-to-level trading); fixed
    // fallback when the tape runs into uncharted territory.
    const opp = levels
      .filter((l) => (long ? l.price > entry : l.price < entry))
      .sort((a, b) => (long ? a.price - b.price : b.price - a.price));
    const tp1 = opp[0] !== undefined && Math.abs(opp[0].price - entry) >= MIN_RR * risk
      ? opp[0].price
      : opp[0] === undefined
        ? entry + (long ? 1 : -1) * FALLBACK_RR * risk
        : undefined;
    if (tp1 === undefined) continue; // opposing level too close — no room
    const rr1 = Math.abs(tp1 - entry) / risk;
    const tp2 =
      opp[1] !== undefined && Math.abs(opp[1].price - entry) > Math.abs(tp1 - entry)
        ? opp[1].price
        : entry + (long ? 1 : -1) * RUNNER_RR * risk;

    const confidence = Math.min(
      94,
      55 + lvl.touches * 4 + (Math.abs(tp1 - entry) >= 2 * risk ? 6 : 0) +
        (breakTrade ? 4 : 0) + // a level break carries momentum
        (swept ? 8 : 0) + // stop-run grab = the pro entry
        (fresh ? 5 : 0) + // first touch of an untested zone
        (fvgHit ? 5 : 0), // entry inside a matching imbalance gap
    );
    const kindLabel = isSupport ? "Support" : "Resistance";
    const extras = [
      swept ? "liquidity sweep through the level" : "",
      fresh ? "untested zone — first touch" : "",
      fvgHit ? "inside a fair-value gap" : "",
    ].filter((x) => x !== "");
    return {
      direction: long ? "bullish" : "bearish",
      confidence,
      factors: [],
      reasons: [
        bounce
          ? `${kindLabel} ${round2(lvl.price)} respected ${lvl.touches}× — ${long ? "bounced off" : "rejected at"} the level`
          : `${kindLabel} ${round2(lvl.price)} broke on a decisive close — ${long ? "breakout" : "breakdown"} entry (level respected ${lvl.touches}× before)`,
        ...(extras.length > 0 ? [`Confluence: ${extras.join(" · ")}`] : []),
        `Plan: risk ${round2(risk)} to ${long ? "resistance" : "support"} ${round2(tp1)} (${round2(rr1)}R); stop ${round2(stop)} sits ${long ? "below" : "above"} ${bounce ? "the tag" : "the broken level"}`,
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
