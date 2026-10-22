import type { Candle } from "@/lib/types";
import { atr, ema, type TradeSignal } from "./analysis";

/**
 * Published algorithmic strategies — faithful ports of widely-tested public
 * methods so they can be compared against the house engine in the tournament.
 *
 *  1. "SuperTrend AI Adaptive" — DefinedEdge's playbook (the most-boosted
 *     TradingView AI strategy): a SuperTrend(10,3) flip is the trigger, but
 *     ONLY flips that pass the AI-style score (trend alignment, regime
 *     quality, volume, displacement, band distance) become entries. ATR
 *     stop, 2.5R target. Reported ~46% win rate at 2.5:1 RR on BTC 4H.
 *
 *  2. Donchian breakout — the Turtle/StratCoreAlpha trend play: close
 *     through the prior 20-bar extreme, filtered by the 200-period EMA.
 *     The only viral strategy that finished ABOVE break-even in the
 *     StratCoreAlpha 6-strategy test. ATR stop, 2.5R target.
 *
 * Both are causal: only closed bars in `hist` are read, and each returns a
 * single TradeSignal for the latest closed bar — same contract as the
 * house engine in srtrend.ts.
 */

const ST_PERIOD = 10;
const ST_MULT = 3;
const ADX_PERIOD = 14;
const ADX_TREND = 20; // below this the tape is ranging — no trade
const TREND_EMA = 50;
const VOL_MA = 20;
const MIN_SCORE = 65;
const SL_ATR = 2.5;
const TP_RR = 2.5;
const TP2_RR = 4;

const DC_LEN = 20; // Donchian lookback
const DC_TREND_EMA = 200;

/** Simple moving average over the last `period` values. */
function sma(values: number[], period: number): number {
  if (values.length < period) return NaN;
  let s = 0;
  for (let i = values.length - period; i < values.length; i += 1) s += values[i];
  return s / period;
}

/** Wilder's ADX — average directional index, 0–100. */
function adx(cs: Candle[], period: number): number {
  if (cs.length < period * 2 + 1) return 0;
  const trs: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < cs.length; i += 1) {
    const up = cs[i].high - cs[i - 1].high;
    const dn = cs[i - 1].low - cs[i].low;
    trs.push(
      Math.max(
        cs[i].high - cs[i].low,
        Math.abs(cs[i].high - cs[i - 1].close),
        Math.abs(cs[i].low - cs[i - 1].close),
      ),
    );
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
  }
  // Wilder smoothing (running sum, not average).
  const wilder = (v: number[]): number => {
    let a = v.slice(0, period).reduce((x, y) => x + y, 0);
    for (let i = period; i < v.length; i += 1) a = a - a / period + v[i];
    return a;
  };
  const atrW = wilder(trs);
  if (atrW === 0) return 0;
  const pDI = (wilder(plusDM) / atrW) * 100;
  const mDI = (wilder(minusDM) / atrW) * 100;
  const denom = pDI + mDI;
  return denom === 0 ? 0 : (Math.abs(pDI - mDI) / denom) * 100;
}

/**
 * SuperTrend state at each bar: direction (+1 bull / −1 bear) plus the
 * active band. Ported from the standard definition — bands ratchet and
 * only reset when crossed.
 */
function supertrend(
  cs: Candle[],
  period: number,
  mult: number,
): { dir: number[]; band: number[] } {
  const n = cs.length;
  const dir = new Array<number>(n).fill(0);
  const band = new Array<number>(n).fill(NaN);
  if (n < period + 1) return { dir, band };
  let upper = NaN;
  let lower = NaN;
  let trend = 1;
  for (let i = period; i < n; i += 1) {
    const width = atr(cs.slice(0, i + 1), period);
    const mid = (cs[i].high + cs[i].low) / 2;
    const rawU = mid + mult * width;
    const rawL = mid - mult * width;
    const prevC = cs[i - 1].close;
    upper = Number.isNaN(upper) || rawU < upper || prevC > upper ? rawU : upper;
    lower = Number.isNaN(lower) || rawL > lower || prevC < lower ? rawL : lower;
    if (trend === 1 && cs[i].close < lower) trend = -1;
    else if (trend === -1 && cs[i].close > upper) trend = 1;
    dir[i] = trend;
    band[i] = trend === 1 ? lower : upper;
  }
  return { dir, band };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Zarattini / Barbon / Aziz — "A Profitable Day Trading Strategy for the U.S.
// Equity Market" (SSRN, 7,000+ stocks, 2016–2023): the plain 5-minute ORB is
// weak (Sharpe 0.48), but the SAME breakout restricted to "Stocks in Play" —
// abnormally high volume in the opening minutes — produced 1,600%+ net,
// Sharpe 2.81, 36% annualized alpha. Independently replicated (giovannibrusco/
// zarattini-2023-orb-qqq: Sharpe 1.06 vs the paper's 1.12 on QQQ).
//
// The relative-volume gate IS the edge — without it the breakout is noise.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const ZORB_WINDOW_MS = 4 * 3_600_000; // breaks after 4h of the session are stale
const ZORB_RVOL = 1.75; // "in play": opening volume ≥1.75× the recent baseline
const ZORB_MAX_WIDTH_ATR = 1.5; // opening range wider than this → move done
const ZORB_MIN_WIDTH_PCT = 0.0005; // degenerate hairline range → noise

/** First index of the last session: a new UTC day (crypto) or a >4h gap (NSE). */
function sessionStartIdx(hist: Candle[]): number {
  let start = 0;
  for (let i = 1; i < hist.length; i += 1) {
    const gap = hist[i].time - hist[i - 1].time;
    const newDay =
      Math.floor(hist[i].time / DAY_MS) !== Math.floor(hist[i - 1].time / DAY_MS);
    if (gap > 4 * 3_600_000 || newDay) start = i;
  }
  return start;
}

/**
 * Stocks-in-Play 5-min ORB — factory form so "one trade per session" state
 * survives between ticks, same contract as the other StrategyDef creators.
 */
export function zarattiniOrbFactory(): (hist: Candle[]) => TradeSignal | undefined {
  let tradedSession = -1;
  return (hist) => {
    if (hist.length < 70) return undefined;
    const last = hist[hist.length - 1];
    const i0 = sessionStartIdx(hist);
    const today = hist.slice(i0);
    if (today.length < 2) return undefined; // opening bar still forming the range
    if (tradedSession === today[0].time) return undefined; // one bullet per session
    if (last.time > today[0].time + ZORB_WINDOW_MS) return undefined; // stale

    // The opening range on a 5m tape IS the first bar of the session.
    const orb = today[0];
    const hi = orb.high;
    const lo = orb.low;
    const width = hi - lo;
    const width14 = atr(hist, 14);
    if (
      width14 === 0 ||
      width > ZORB_MAX_WIDTH_ATR * width14 ||
      width / last.close < ZORB_MIN_WIDTH_PCT
    ) {
      return undefined;
    }

    // Stocks-in-Play gate: opening-bar volume vs the recent baseline. No
    // volume data → the gate can't verify "in play", so the trade is
    // allowed but scores lower — the filter is the edge, after all.
    const baseline = hist.slice(Math.max(0, i0 - 60), i0);
    const avgV =
      baseline.length > 0
        ? baseline.reduce((s, c) => s + (c.volume ?? 0), 0) / baseline.length
        : NaN;
    const rvolOk =
      !Number.isNaN(avgV) && avgV > 0 ? (orb.volume ?? 0) >= ZORB_RVOL * avgV : true;
    const rvolVerified = !Number.isNaN(avgV) && avgV > 0;
    if (rvolVerified && !rvolOk) return undefined; // not in play → no edge

    const dir =
      last.close > hi ? ("bullish" as const) : last.close < lo ? ("bearish" as const) : undefined;
    if (dir === undefined) return undefined;

    const entry = last.close;
    const stop = dir === "bullish" ? lo : hi; // opposite edge — thesis dead back inside
    const risk = Math.abs(entry - stop);
    if (risk <= 0) return undefined;
    const tp1 = dir === "bullish" ? entry + 2 * risk : entry - 2 * risk;
    const tp2 = dir === "bullish" ? entry + 4 * risk : entry - 4 * risk;

    tradedSession = today[0].time;
    return {
      direction: dir,
      confidence: rvolVerified ? 72 : 55,
      factors: [],
      reasons: [
        `Stocks-in-Play 5-min ORB: opening range ${round2(lo)}–${round2(hi)}${rvolVerified ? ` on ${round2((orb.volume ?? 0) / avgV)}× volume` : " (no volume feed)"}`,
        `Close ${dir === "bullish" ? "above" : "below"} the range — the high-RVOL breakout the paper's 2.81-Sharpe variant trades`,
        `Plan: stop ${round2(stop)} (far side of the range), TP1 ${round2(tp1)} (2R), TP2 ${round2(tp2)} (4R)`,
      ],
      entry,
      stopLoss: stop,
      riskReward: 2,
      targets: [
        { label: "TP1", price: tp1, rr: 2 },
        { label: "TP2", price: tp2, rr: 4 },
      ],
    };
  };
}

/**
 * SuperTrend AI Adaptive — a flip is only worth taking when the tape
 * confirms it: trending regime (ADX ≥ 20), EMA50 on-side, volume above
 * its 20-bar average, and a decisive break through the band.
 */
export function superTrendSignal(hist: Candle[]): TradeSignal | undefined {
  if (hist.length < Math.max(TREND_EMA, ST_PERIOD, ADX_PERIOD * 2) + 5) return undefined;
  const last = hist[hist.length - 1];
  const width = atr(hist, ST_PERIOD);
  if (width === 0) return undefined;

  const { dir, band } = supertrend(hist, ST_PERIOD, ST_MULT);
  const i = hist.length - 1;
  const flipUp = dir[i] === 1 && dir[i - 1] === -1;
  const flipDn = dir[i] === -1 && dir[i - 1] === 1;
  if (!flipUp && !flipDn) return undefined;

  const adxNow = adx(hist, ADX_PERIOD);
  if (adxNow < ADX_TREND) return undefined; // ranging — flips chop you to death

  const closes = hist.map((c) => c.close);
  const e50 = ema(closes, TREND_EMA);
  const emaV = e50[e50.length - 1];
  const bull = flipUp;
  if (bull ? last.close <= emaV : last.close >= emaV) return undefined; // against trend

  const vma = sma(
    hist.map((c) => c.volume ?? 0),
    VOL_MA,
  );
  const volOk = Number.isNaN(vma) || (last.volume ?? 0) > vma;

  // AI-style score, 0–100 — five weighted factors like the published version.
  let score = 30; // a confirmed flip is worth something on its own
  score += volOk ? 15 : 0; // volume surge behind the flip
  score += adxNow >= 30 ? 20 : adxNow >= 25 ? 12 : 8; // regime quality
  score += 20; // EMA50 alignment (already gated above)
  const displacement = Math.abs(last.close - band[i - 1]) / width;
  score += displacement >= 1 ? 15 : displacement >= 0.5 ? 8 : 0; // decisive break
  if (score < MIN_SCORE || !volOk) return undefined;

  const entry = last.close;
  const stop = bull ? entry - SL_ATR * width : entry + SL_ATR * width;
  const risk = SL_ATR * width;
  const tp1 = bull ? entry + TP_RR * risk : entry - TP_RR * risk;
  const tp2 = bull ? entry + TP2_RR * risk : entry - TP2_RR * risk;

  return {
    direction: bull ? "bullish" : "bearish",
    confidence: Math.min(95, score),
    factors: [],
    reasons: [
      `SuperTrend(10,3) flipped ${bull ? "bullish" : "bearish"} — close broke the band`,
      `AI score ${score}/100: ADX ${round2(adxNow)} regime, EMA50 ${bull ? "below" : "above"} price, volume ${volOk ? "surged" : "flat"}`,
      `Plan: ${round2(SL_ATR)}×ATR stop at ${round2(stop)}, ${TP_RR}R target ${round2(tp1)}`,
    ],
    entry,
    stopLoss: stop,
    riskReward: TP_RR,
    targets: [
      { label: "TP1", price: tp1, rr: TP_RR },
      { label: "TP2", price: tp2, rr: TP2_RR },
    ],
  };
}

/**
 * Donchian breakout — Turtle-style: trade WITH the 200-EMA trend on a
 * close through the prior 20-bar extreme. The only viral rule-set that
 * finished above break-even in StratCoreAlpha's independent test.
 */
export function donchianSignal(hist: Candle[]): TradeSignal | undefined {
  if (hist.length < DC_TREND_EMA + DC_LEN + 5) return undefined;
  const last = hist[hist.length - 1];
  const width = atr(hist, 14);
  if (width === 0) return undefined;

  const closes = hist.map((c) => c.close);
  const e200 = ema(closes, DC_TREND_EMA);
  const emaV = e200[e200.length - 1];

  const lookback = hist.slice(-(DC_LEN + 1), -1); // prior 20 bars, exclude signal bar
  const hi = Math.max(...lookback.map((c) => c.high));
  const lo = Math.min(...lookback.map((c) => c.low));

  const bull = last.close > hi && last.close > emaV;
  const bear = last.close < lo && last.close < emaV;
  if (!bull && !bear) return undefined;

  const entry = last.close;
  const stop = bull ? entry - 2 * width : entry + 2 * width;
  const risk = 2 * width;
  const tp1 = bull ? entry + TP_RR * risk : entry - TP_RR * risk;
  const tp2 = bull ? entry + TP2_RR * risk : entry - TP2_RR * risk;

  return {
    direction: bull ? "bullish" : "bearish",
    confidence: 60,
    factors: [],
    reasons: [
      `Donchian breakout — close ${bull ? "above" : "below"} the prior ${DC_LEN}-bar ${bull ? "high" : "low"} ${round2(bull ? hi : lo)}`,
      `EMA200 filter passed — price ${bull ? "above" : "below"} the long-term trend line`,
      `Plan: 2×ATR stop ${round2(stop)}, ${TP_RR}R target ${round2(tp1)} — trend-following, expect to be wrong often`,
    ],
    entry,
    stopLoss: stop,
    riskReward: TP_RR,
    targets: [
      { label: "TP1", price: tp1, rr: TP_RR },
      { label: "TP2", price: tp2, rr: TP2_RR },
    ],
  };
}
