import type { Candle, Direction } from "@/lib/types";
import {
  analyzeCandles,
  atr,
  efficiencyRatio,
  ema,
  type TradeSignal,
} from "./analysis";
import { pinBar, victorSignal } from "./victor";
import { srTrendSignal } from "./srtrend";
import { tciKeySignal } from "./tci-key-levels";
import { donchianSignal, superTrendSignal, zarattiniOrbFactory } from "./algos";
/**
 * Strategy tournament — a registry of named, published intraday methods,
 * each distilled to its mechanical core so the backtest harness can rank
 * them on the SAME exit/management rules (TP1 banks half, stop trails,
 * costs deducted) and the same journal gates. Every entry below is causal:
 * only closed bars in `hist` are read.
 *
 * The seven cover the three intraday regimes, so the tournament itself
 * answers "which regime does this pair spend time in?":
 *   trend days  → ORB breakouts, VWAP bounces, EMA pullbacks, Victor pins
 *   range days  → VWAP fades, range fades
 *   trap days   → liquidity-sweep reversals
 * Confluence is the baseline engine — the others are the challengers.
 */

/** What a strategy emits per bar — undefined/wait means "no setup". */
export type StrategyFn = (hist: Candle[]) => TradeSignal | undefined;

export interface StrategyDef {
  /** Journal tag — stored on the TradeRecord. */
  id: string;
  label: string;
  /** One line: what it waits for and which regime it wants. */
  blurb: string;
  /**
   * Factory, not a bare function: stateful methods (ORB's one-trade-per-day)
   * keep run-local memory inside the closure so replays stay deterministic.
   */
  create: () => StrategyFn;
}

const DAY_MS = 86_400_000;
const MIN_RR = 1;

function sig(
  direction: Direction,
  entry: number,
  stopLoss: number,
  tp1: number,
  confidence: number,
  reasons: string[],
  minRr = MIN_RR,
): TradeSignal | undefined {
  const risk = Math.abs(entry - stopLoss);
  const rr = risk === 0 ? 0 : Math.abs(tp1 - entry) / risk;
  const valid =
    risk > 0 &&
    (direction === "bullish"
      ? stopLoss < entry && tp1 > entry
      : stopLoss > entry && tp1 < entry);
  if (!valid || rr < minRr) return undefined;
  return {
    direction,
    confidence,
    factors: [],
    reasons,
    entry,
    stopLoss,
    riskReward: Math.round(rr * 10) / 10,
    targets: [{ label: "TP1", price: tp1, rr: Math.round(rr * 10) / 10 }],
  };
}

/** Start index of the current UTC day's bars within `hist` (-1: none). */
function sessionStart(hist: Candle[]): number {
  const day0 = Math.floor(hist[hist.length - 1].time / DAY_MS) * DAY_MS;
  let i = hist.length - 1;
  while (i >= 0 && hist[i].time >= day0) i -= 1;
  return i + 1;
}

/**
 * Session VWAP + population stdev of typical price around it, anchored at
 * the UTC day — crypto's "session". Volume-less feeds fall back to a plain
 * average so index tapes still produce a level.
 */
function vwapBand(hist: Candle[]): { vwap: number; stdev: number } | undefined {
  const i0 = sessionStart(hist);
  const n = hist.length - i0;
  if (n < 10) return undefined;
  let pv = 0;
  let vv = 0;
  for (let i = i0; i < hist.length; i += 1) {
    const c = hist[i];
    const tp = (c.high + c.low + c.close) / 3;
    const v = (c.volume ?? 0) > 0 ? c.volume! : 1;
    pv += tp * v;
    vv += v;
  }
  const vwap = pv / vv;
  let sq = 0;
  for (let i = i0; i < hist.length; i += 1) {
    const c = hist[i];
    const tp = (c.high + c.low + c.close) / 3;
    const v = (c.volume ?? 0) > 0 ? c.volume! : 1;
    sq += v * (tp - vwap) * (tp - vwap);
  }
  return { vwap, stdev: Math.sqrt(sq / vv) };
}

function trendOf(hist: Candle[]): Direction | undefined {
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

// ---------------------------------------------------------------------------
// Baseline — the existing engines, wrapped so they replay identically.
// ---------------------------------------------------------------------------

const srTrend: StrategyDef = {
  id: "sr",
  label: "S/R + trend",
  blurb: "The live engine: major swing levels only — buy a held support or a broken resistance, sell a held resistance or a broken support. Bounce or breakout, level-to-level targets.",
  create: () => (hist) => srTrendSignal(hist),
};

const superTrend: StrategyDef = {
  id: "supertrend-ai",
  label: "SuperTrend AI",
  blurb: "Published algo (DefinedEdge-style): SuperTrend(10,3) flip + AI score — ADX regime, EMA50, volume, displacement ≥65. 2.5×ATR stop, 2.5R target.",
  create: () => (hist) => superTrendSignal(hist),
};

const zarattiniOrb: StrategyDef = {
  id: "zorb",
  label: "ORB · Stocks in Play",
  blurb: "Zarattini/Barbon/Aziz (SSRN, 7k stocks 2016–23): 5-min opening-range breakout ONLY on high-RVOL opens — the published 2.81-Sharpe variant, independently replicated.",
  create: () => zarattiniOrbFactory(),
};

const donchian: StrategyDef = {
  id: "donchian",
  label: "Donchian breakout",
  blurb: "Turtle-style: close through the prior 20-bar extreme with the 200-EMA trend. The only viral strategy above break-even in StratCoreAlpha's test.",
  create: () => (hist) => donchianSignal(hist),
};

const confluence: StrategyDef = {
  id: "confluence",
  label: "Confluence",
  blurb: "House engine: pooled confirmations (trend/structure/momentum/zone/RR + patterns) at a 5m zone.",
  create: () => (hist) => analyzeCandles(hist)?.signal,
};

/** Aggregate consecutive bars into a higher-timeframe candle set (×3). */
function resampleX3(hist: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + 2 < hist.length; i += 3) {
    const g = hist.slice(i, i + 3);
    out.push({
      time: g[0].time,
      open: g[0].open,
      high: Math.max(...g.map((c) => c.high)),
      low: Math.min(...g.map((c) => c.low)),
      close: g[2].close,
      volume: g.reduce((s, c) => s + (c.volume ?? 0), 0),
    });
  }
  return out;
}

const victor: StrategyDef = {
  id: "victor",
  label: "Victor scalp",
  blurb: "Pin-bar rejection of a leg–base–leg S/D zone + confirming follow-up candle. 5m entries, zones measured on 5m + resampled 15m.",
  create: () => (hist) => victorSignal(hist, [hist, resampleX3(hist)])?.signal,
};

// ---------------------------------------------------------------------------
// Challenger 1 — Opening Range Breakout (UTC-day variant for 24/7 crypto).
// The first 15 minutes set the day's battle lines; a close beyond them with
// volume continuation is the trigger. One trade per day, stop at range mid,
// target one full range-width — the published ~2R profile.
// ---------------------------------------------------------------------------

const ORB_RANGE_MS = 15 * 60_000;
const ORB_WINDOW_MS = 4 * 3_600_000; // breaks after 4h of the day are stale
const ORB_MAX_WIDTH_PCT = 0.015;
const ORB_MIN_WIDTH_PCT = 0.0015;
const ORB_VOL_MULT = 1.5;

const orb: StrategyDef = {
  id: "orb",
  label: "Opening Range Breakout",
  blurb: "First-15-min UTC range; a close beyond it with ≥1.5× volume is the trigger. One trade per day, stop inside the broken edge, target 1.5× the range width.",
  create: () => {
    let tradedDay = -1;
    return (hist) => {
      if (hist.length < 30) return undefined;
      const last = hist[hist.length - 1];
      const day0 = Math.floor(last.time / DAY_MS) * DAY_MS;
      if (tradedDay === day0) return undefined;
      const i0 = sessionStart(hist);
      const range = hist.slice(i0).filter((c) => c.time < day0 + ORB_RANGE_MS);
      // ≥1 bar: on a 15m+ tape a single bar IS the opening range; on 1m/5m
      // the window holds 15/3 bars. The width filters below reject a
      // degenerate one-bar range whose span is meaningless.
      if (range.length === 0 || last.time < day0 + ORB_RANGE_MS) return undefined;
      if (last.time >= day0 + ORB_WINDOW_MS) return undefined;
      const hi = Math.max(...range.map((c) => c.high));
      const lo = Math.min(...range.map((c) => c.low));
      const width = hi - lo;
      const price = last.close;
      if (width / price > ORB_MAX_WIDTH_PCT || width / price < ORB_MIN_WIDTH_PCT) {
        return undefined; // too wide = move already happened; too tight = noise
      }
      const dir: Direction | undefined =
        last.close > hi ? "bullish" : last.close < lo ? "bearish" : undefined;
      if (dir === undefined) return undefined;
      const rangeAvg = range.reduce((s, c) => s + (c.volume ?? 0), 0) / range.length;
      if (rangeAvg > 0 && (last.volume ?? 0) < rangeAvg * ORB_VOL_MULT) return undefined;
      // Published profile: stop tucks just inside the broken edge (a fill
      // back into the range kills the thesis), target 1.5× the range width
      // measured from the edge — lands near ~1.5–2R from a breakout close.
      const stop = dir === "bullish" ? hi - 0.25 * width : lo + 0.25 * width;
      const tp1 = dir === "bullish" ? hi + 1.5 * width : lo - 1.5 * width;
      const out = sig(dir, last.close, stop, tp1, 62, [
        `ORB: closed ${dir === "bullish" ? "above" : "below"} the first-15-min range`,
      ]);
      if (out !== undefined) tradedDay = day0;
      return out;
    };
  },
};

// ---------------------------------------------------------------------------
// Challenger 2 — VWAP bounce. Trending session: price has stayed on one side
// of session VWAP; a pullback that tags VWAP and rejects back in trend is the
// institutional fill zone. Stop through VWAP, target the day's extreme.
// ---------------------------------------------------------------------------

const vwapBounce: StrategyDef = {
  id: "vwap-bounce",
  label: "VWAP bounce",
  blurb: "Trending session: pullback tags session VWAP and rejects back in the trend direction. Stop through VWAP, target the day's extreme.",
  create: () => (hist) => {
    if (hist.length < 70) return undefined;
    const band = vwapBand(hist);
    const dir = trendOf(hist);
    if (band === undefined || dir === undefined) return undefined;
    const closes = hist.map((c) => c.close);
    if (efficiencyRatio(closes, 20) < 0.3) return undefined; // needs a trend day
    const last = hist[hist.length - 1];
    const atr14 = atr(hist, 14);
    if (atr14 === 0) return undefined;
    // Tag: recent bar dipped to VWAP; trigger: last bar closes back in trend.
    const touch = hist.slice(-6, -1).some((c) => c.low <= band.vwap && c.high >= band.vwap);
    const back = dir === "bullish" ? last.close > band.vwap : last.close < band.vwap;
    const body = dir === "bullish" ? last.close > last.open : last.close < last.open;
    if (!touch || !back || !body) return undefined;
    const pullLow = Math.min(...hist.slice(-6).map((c) => c.low));
    const pullHigh = Math.max(...hist.slice(-6).map((c) => c.high));
    const i0 = sessionStart(hist);
    const dayBars = hist.slice(i0);
    const stop =
      dir === "bullish" ? Math.min(pullLow, band.vwap) - 0.3 * atr14
                        : Math.max(pullHigh, band.vwap) + 0.3 * atr14;
    const tp1 = dir === "bullish"
      ? Math.max(...dayBars.map((c) => c.high))
      : Math.min(...dayBars.map((c) => c.low));
    return sig(dir, last.close, stop, tp1, 60, [
      `VWAP bounce: pullback tagged session VWAP (${Math.round(band.vwap * 100) / 100}) and rejected`,
    ]);
  },
};

// ---------------------------------------------------------------------------
// Challenger 3 — VWAP mean-reversion fade. Ranging session: price stretched
// ≥1.5σ from VWAP prints a rejection candle; VWAP is the magnet target. The
// high-win-rate, small-R complement to the trend strategies.
// ---------------------------------------------------------------------------

const vwapFade: StrategyDef = {
  id: "vwap-fade",
  label: "VWAP fade",
  blurb: "Ranging session: price ≥1.5σ from session VWAP prints a rejection — fade it back to VWAP. Counter-trend mean reversion.",
  create: () => (hist) => {
    if (hist.length < 70) return undefined;
    const band = vwapBand(hist);
    if (band === undefined || band.stdev === 0) return undefined;
    const closes = hist.map((c) => c.close);
    if (efficiencyRatio(closes, 20) >= 0.25) return undefined; // needs a range day
    const last = hist[hist.length - 1];
    const dev = (last.close - band.vwap) / band.stdev;
    const dir: Direction | undefined = dev >= 1.5 ? "bearish" : dev <= -1.5 ? "bullish" : undefined;
    if (dir === undefined) return undefined;
    // Rejection candle: closes back toward VWAP, with a wick away from it.
    const toward = dir === "bearish" ? last.close < last.open : last.close > last.open;
    if (!toward) return undefined;
    const atr14 = atr(hist, 14);
    if (atr14 === 0) return undefined;
    const recent = hist.slice(-5);
    const stop =
      dir === "bearish"
        ? Math.max(...recent.map((c) => c.high)) + 0.3 * atr14
        : Math.min(...recent.map((c) => c.low)) - 0.3 * atr14;
    // Mean reversion legitimately runs a sub-1R first target — the edge
    // is hit-rate, not payoff; 0.7R is the documented profile.
    return sig(dir, last.close, stop, band.vwap, 55, [
      `VWAP fade: ${Math.abs(dev).toFixed(1)}σ stretch on a ranging tape — reverting to VWAP`,
    ], 0.7);
  },
};

// ---------------------------------------------------------------------------
// Challenger 4 — Liquidity sweep reversal. Stops resting beyond the recent
// extreme get run, price reclaims the level — the trap is the entry. Stop at
// the sweep wick, bank half at 1.5R and let the trail hunt the far side.
// ---------------------------------------------------------------------------

const sweepReverse: StrategyDef = {
  id: "sweep-reverse",
  label: "Liquidity sweep reversal",
  blurb: "A wick runs the 30-bar extreme and closes back inside — the stop-hunt is the entry. Stop at the sweep wick, bank at 1.5R, trail for the far side.",
  create: () => (hist) => {
    if (hist.length < 60) return undefined;
    const prior = hist.slice(-34, -3);
    const grab = hist.slice(-3);
    const last = hist[hist.length - 1];
    const priorLow = Math.min(...prior.map((c) => c.low));
    const priorHigh = Math.max(...prior.map((c) => c.high));
    const atr14 = atr(hist, 14);
    if (atr14 === 0) return undefined;
    const sweptLow = grab.some((c) => c.low < priorLow) && last.close > priorLow;
    const sweptHigh = grab.some((c) => c.high > priorHigh) && last.close < priorHigh;
    if (sweptLow) {
      const stop = Math.min(...grab.map((c) => c.low)) - 0.1 * atr14;
      // TP1 banks at a fixed 1.5R — the far side of the range is usually
      // closer than 1R to the reclaimed entry, so the trail hunts it.
      const tp1 = last.close + 1.5 * (last.close - stop);
      return sig("bullish", last.close, stop, tp1, 60, [
        `Sell-side sweep at ${Math.round(priorLow * 100) / 100} reclaimed — trap long`,
      ]);
    }
    if (sweptHigh) {
      const stop = Math.max(...grab.map((c) => c.high)) + 0.1 * atr14;
      const tp1 = last.close - 1.5 * (stop - last.close);
      return sig("bearish", last.close, stop, tp1, 60, [
        `Buy-side sweep at ${Math.round(priorHigh * 100) / 100} rejected — trap short`,
      ]);
    }
    return undefined;
  },
};

// ---------------------------------------------------------------------------
// Challenger 5 — EMA20 pullback. Established EMA20/50 trend; a 2–6 bar
// pullback to the fast EMA that closes back with the trend is the entry.
// Stop beyond the pullback extreme, target the prior swing.
// ---------------------------------------------------------------------------

const emaPullback: StrategyDef = {
  id: "ema-pullback",
  label: "EMA20 trend pullback",
  blurb: "EMA20/50 trend; a 2–6 bar pullback to EMA20 closes back with the trend. Stop beyond the pullback, target the prior swing extreme.",
  create: () => (hist) => {
    if (hist.length < 70) return undefined;
    const dir = trendOf(hist);
    if (dir === undefined) return undefined;
    const closes = hist.map((c) => c.close);
    const f = ema(closes, 20);
    const emaF = f[f.length - 1];
    const last = hist[hist.length - 1];
    const atr14 = atr(hist, 14);
    if (atr14 === 0) return undefined;
    const recent = hist.slice(-6, -1);
    const dipped =
      dir === "bullish"
        ? recent.some((c) => c.low <= emaF)
        : recent.some((c) => c.high >= emaF);
    const resumed =
      dir === "bullish"
        ? last.close > emaF && last.close > last.open
        : last.close < emaF && last.close < last.open;
    if (!dipped || !resumed) return undefined;
    const stop =
      dir === "bullish"
        ? Math.min(...recent.map((c) => c.low), last.low) - 0.3 * atr14
        : Math.max(...recent.map((c) => c.high), last.high) + 0.3 * atr14;
    const tp1 =
      dir === "bullish"
        ? Math.max(...hist.slice(-30).map((c) => c.high))
        : Math.min(...hist.slice(-30).map((c) => c.low));
    return sig(dir, last.close, stop, tp1, 55, [
      `EMA20 pullback: ${dir} trend, pullback to the fast EMA resumed`,
    ]);
  },
};

// ---------------------------------------------------------------------------
// Challenger 6 — Range fade. Explicitly consolidating tape (low efficiency
// ratio) with a pin rejecting the established range edge — buy the bottom of
// the box, sell the top. Small-R, high-hit-rate complement to ORB.
// ---------------------------------------------------------------------------

const rangeFade: StrategyDef = {
  id: "range-fade",
  label: "Range fade",
  blurb: "Consolidating tape only: pin-bar rejection of the 30-bar range edge, target the range midpoint. The sideways-market earner.",
  create: () => (hist) => {
    if (hist.length < 60) return undefined;
    const closes = hist.map((c) => c.close);
    if (efficiencyRatio(closes, 20) >= 0.25) return undefined; // needs the box
    const box = hist.slice(-32, -2);
    const lo = Math.min(...box.map((c) => c.low));
    const hi = Math.max(...box.map((c) => c.high));
    const last = hist[hist.length - 1];
    const pin = pinBar(last);
    if (pin === undefined) return undefined;
    const atr14 = atr(hist, 14);
    if (atr14 === 0) return undefined;
    // Edge tag: pin printed AT the edge — within a third of the box.
    // Target the far edge (the classic box fade); sub-1R is inherent to
    // the method, so the floor relaxes to its documented 0.7R profile.
    const edgeBand = (hi - lo) / 3;
    if (pin === "bullish" && last.low <= lo + edgeBand) {
      const stop = last.low - 0.1 * atr14;
      return sig("bullish", last.close, stop, hi, 55, [
        "Range fade: demand-edge pin inside a consolidating box",
      ], 0.7);
    }
    if (pin === "bearish" && last.high >= hi - edgeBand) {
      const stop = last.high + 0.1 * atr14;
      return sig("bearish", last.close, stop, lo, 55, [
        "Range fade: supply-edge pin inside a consolidating box",
      ], 0.7);
    }
    return undefined;
  },
};

// ---------------------------------------------------------------------------
// TCI Key Institutional Levels — Smart Money Concepts engine based on the
// TradingView indicator by The_Stock_Yogi / Trading Cafe India.
// Tracks market structure (BOS/CHoCH), order blocks, FVGs, and premium/
// discount zones to find institutional entry levels.
// ---------------------------------------------------------------------------

const tciKey: StrategyDef = {
  id: "tci",
  label: "TCI Key Institutional Levels",
  blurb: "Smart Money Concepts: order blocks + market structure (BOS/CHoCH) + FVG + premium/discount zones. Inspired by the TCI Key Institutional Levels indicator by The_Stock_Yogi (Trading Cafe India).",
  create: () => (hist) => tciKeySignal(hist),
};

/** Registry order = display order in the tournament table. */
export const STRATEGIES: readonly StrategyDef[] = [
  tciKey,
  srTrend,
  zarattiniOrb,
  superTrend,
  donchian,
  confluence,
  victor,
  orb,
  vwapBounce,
  vwapFade,
  sweepReverse,
  emaPullback,
  rangeFade,
];
