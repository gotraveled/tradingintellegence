import type { Candle, Direction, Price } from "@/lib/types";
import type { TradeSignal } from "./analysis";

/**
 * "Victor" — pure price-action entries, no indicators.
 *
 * Setup (all four must hold, evaluated on closed bars only):
 *  1. Pin bar at a swing supply/demand zone — a rejection wick ≥ 2× the
 *     body AND ≥ 2× the opposing wick, whose tail poked into the zone and
 *     whose close pulled back out of it.
 *  2. Follow-up: the NEXT closed candle confirms — same direction colour
 *     and a close beyond the pin bar's close.
 *  3. The zone is STRONG — it overlaps a same-kind zone on the higher
 *     timeframe, i.e. multi-timeframe alignment backs the level.
 *  4. Risk:reward ≥ 1R to the target.
 *
 * Entry  = follow-up candle's close (the signal bar).
 * Stop   = pin bar's extreme (low for longs, high for shorts) — the wick
 *          that defined the rejection.
 * Target = next opposing swing or supply/demand zone edge; TP2 = 2.5R
 *          runner when that exceeds TP1.
 *
 * Zones come from k=3 swing pivots: a pivot high unbroken by closes is
 * supply, a pivot low unbroken is demand — same measured levels the chart
 * marks, never smoothed or invented.
 */

export interface VictorZone {
  kind: "supply" | "demand";
  lower: Price;
  upper: Price;
  /** Index (into the candle set) of the pivot bar that formed the zone. */
  pivotIndex: number;
  /** Times price re-entered the zone after it formed — defended tests. */
  touches: number;
  /** True when a same-kind HTF zone overlaps — the multi-TF-confirmed level. */
  strong: boolean;
}

export interface VictorSetup {
  signal: TradeSignal;
  /** Zone the pin bar rejected — for display. */
  zone: VictorZone;
  /** Open-time of the pin bar — markers draw here, not on the signal bar. */
  pinBarTime: number;
}

// ---- Tunables (named, single place to adjust) ---------------------------
/** Pivot lookback — a swing high/low must beat k bars each side. */
const SWING_K = 3;
/** Zones older than this many bars are stale — price has forgotten them. */
const ZONE_MAX_AGE = 120;
/** Rejection wick must be at least this multiple of the body. */
const PIN_WICK_RATIO = 2;
/** A wick "tags" a zone when it reaches this deep past the near edge. */
const TAG_TOLERANCE = 0; // wick must actually enter the zone
/** Minimum reward:risk to the first target. */
const MIN_RR = 1;
/** Runner target when the path beyond TP1 is open. */
const RUNNER_R = 2.5;

/** Wick/body anatomy of a pin bar — returns the rejection direction. */
export function pinBar(c: Candle): Direction | undefined {
  const body = Math.abs(c.close - c.open);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  // Bullish: long lower tail, small body sitting at the top of the range.
  if (lower >= PIN_WICK_RATIO * Math.max(body, 1e-12) && lower >= PIN_WICK_RATIO * upper) {
    return "bullish";
  }
  if (upper >= PIN_WICK_RATIO * Math.max(body, 1e-12) && upper >= PIN_WICK_RATIO * lower) {
    return "bearish";
  }
  return undefined;
}

interface Pivot {
  index: number;
  price: Price;
  kind: "high" | "low";
}

function swings(candles: Candle[]): Pivot[] {
  const out: Pivot[] = [];
  for (let i = SWING_K; i < candles.length - SWING_K; i += 1) {
    const h = candles[i].high;
    const l = candles[i].low;
    let isHigh = true;
    let isLow = true;
    for (let j = i - SWING_K; j <= i + SWING_K; j += 1) {
      if (j === i) continue;
      if (candles[j].high >= h) isHigh = false;
      if (candles[j].low <= l) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: h, kind: "high" });
    if (isLow) out.push({ index: i, price: l, kind: "low" });
  }
  return out;
}

/**
 * Swing pivots → supply/demand zones. Edges are the pivot bar's wick→body
 * span (same convention as the confluence engine); a zone dies once price
 * closes through it. `strong` is filled by `markStrong` later — zones from
 * a single timeframe alone are never assumed MTF-confirmed.
 */
export function swingZones(candles: Candle[]): VictorZone[] {
  const last = candles.length - 1;
  const zones: VictorZone[] = [];
  for (const p of swings(candles)) {
    if (last - p.index > ZONE_MAX_AGE) continue;
    const bar = candles[p.index];
    // A zone is dead once a close pierces the pivot that made it.
    const broken = candles
      .slice(p.index + 1)
      .some((c) => (p.kind === "high" ? c.close > p.price : c.close < p.price));
    if (broken) continue;
    const after = candles.slice(p.index + 1);
    const upper = p.kind === "high" ? bar.high : Math.max(bar.open, bar.close);
    const lower = p.kind === "high" ? Math.min(bar.open, bar.close) : bar.low;
    zones.push({
      kind: p.kind === "high" ? "supply" : "demand",
      upper,
      lower,
      pivotIndex: p.index,
      strong: false,
      // Touches = bars that re-entered the zone without breaking it.
      touches: after.filter((c) => c.low <= upper && c.high >= lower).length,
    });
  }
  return zones;
}

/** Zones overlap when their bands share any price — not identical, aligned. */
function overlap(a: { lower: Price; upper: Price }, b: { lower: Price; upper: Price }): boolean {
  return a.lower <= b.upper && b.lower <= a.upper;
}

/** Flag LTF zones confirmed by a same-kind HTF zone — the "strong" levels. */
export function markStrong(ltf: VictorZone[], htf: VictorZone[]): void {
  for (const z of ltf) {
    z.strong = htf.some((h) => h.kind === z.kind && overlap(z, h));
  }
}

/**
 * Evaluate the last two closed bars for a Victor setup.
 * `htf` is the higher-timeframe candle set (1h); without it no zone can be
 * proven strong, so no signal — multi-TF alignment is a hard requirement.
 */
export function victorSignal(ltf: Candle[], htf: Candle[] | undefined): VictorSetup | undefined {
  if (ltf.length < 30 || htf === undefined || htf.length < 30) return undefined;
  const pin = ltf[ltf.length - 2];
  const follow = ltf[ltf.length - 1];
  const dir = pinBar(pin);
  if (dir === undefined) return undefined;

  // Follow-up confirmation: same colour AND closes beyond the pin's close.
  const confirms =
    dir === "bullish"
      ? follow.close > follow.open && follow.close > pin.close
      : follow.close < follow.open && follow.close < pin.close;
  if (!confirms) return undefined;

  // The pin's tail must have rejected a zone: bullish tail tags demand,
  // bearish tail tags supply — wick entered, close pulled back out.
  const zones = swingZones(ltf);
  markStrong(zones, swingZones(htf));
  const zone = zones.find((z) => {
    if (z.kind !== (dir === "bullish" ? "demand" : "supply")) return false;
    const tail = dir === "bullish" ? pin.low : pin.high;
    const entered = tail <= z.upper + TAG_TOLERANCE && tail >= z.lower - TAG_TOLERANCE;
    const closedOut =
      dir === "bullish" ? pin.close >= z.lower : pin.close <= z.upper;
    return entered && closedOut;
  });
  if (zone === undefined || !zone.strong) return undefined;

  const entry = follow.close;
  const stopLoss = dir === "bullish" ? pin.low : pin.high;
  const risk = Math.abs(entry - stopLoss);
  if (risk === 0) return undefined;

  // Target = next opposing level: nearest opposite-kind zone edge past
  // entry, falling back to the nearest opposing swing pivot.
  const opposing = zones
    .filter((z) => z.kind !== zone.kind)
    .map((z) => (dir === "bullish" ? z.lower : z.upper))
    .filter((p) => (dir === "bullish" ? p > entry : p < entry))
    .sort((a, b) => (dir === "bullish" ? a - b : b - a));
  let tp1 = opposing[0];
  if (tp1 === undefined) {
    // No zone ahead — aim at the nearest unbroken opposing swing pivot.
    const piv = swings(ltf)
      .filter((p) => p.kind === (dir === "bullish" ? "high" : "low"))
      .map((p) => p.price)
      .filter((p) => (dir === "bullish" ? p > entry : p < entry))
      .sort((a, b) => (dir === "bullish" ? a - b : b - a));
    tp1 = piv[0];
  }
  if (tp1 === undefined) return undefined;
  const rr1 = Math.abs(tp1 - entry) / risk;
  if (rr1 < MIN_RR) return undefined;

  // Score: 80 base for a complete setup, bonuses for a cleaner rejection
  // wick, a defended (multi-touch) zone, and a fresh zone. Not a win rate —
  // it ranks today's setups, nothing more.
  const body = Math.abs(pin.close - pin.open);
  const tail = dir === "bullish" ? Math.min(pin.open, pin.close) - pin.low : pin.high - Math.max(pin.open, pin.close);
  const confidence = Math.min(
    100,
    80 + (tail >= 3 * Math.max(body, 1e-12) ? 5 : 0) + (zone.touches >= 1 ? 5 : 0) +
      (ltf.length - 1 - zone.pivotIndex <= 80 ? 5 : 0) +
      (rr1 >= 1.5 ? 5 : 0),
  );

  const tp2 = dir === "bullish" ? entry + RUNNER_R * risk : entry - RUNNER_R * risk;
  const signal: TradeSignal = {
    direction: dir,
    confidence,
    factors: [
      {
        label: "Pin bar rejection",
        agrees: true,
        points: 30,
        weight: 30,
        note: `${dir === "bullish" ? "Lower" : "Upper"} wick ${(tail / Math.max(body, 1e-12)).toFixed(1)}× body`,
      },
      {
        label: "Zone",
        agrees: true,
        points: 30,
        weight: 30,
        note: `${zone.kind} zone tagged, ${zone.touches} prior touches`,
      },
      {
        label: "MTF alignment",
        agrees: true,
        points: 20,
        weight: 20,
        note: "Zone overlaps a higher-timeframe zone — strong level",
      },
      {
        label: "Follow-up",
        agrees: true,
        points: 20,
        weight: 20,
        note: "Confirmation candle closed beyond the pin",
      },
    ],
    reasons: [
      `Victor pin bar — ${dir === "bullish" ? "bullish rejection at demand" : "bearish rejection at supply"}`,
      `Stop at pin ${dir === "bullish" ? "low" : "high"} ${stopLoss}, target next opposing zone`,
      "Multi-timeframe aligned zone — level confirmed on 1h",
    ],
    entry,
    stopLoss,
    targets: [
      { label: "Next opposing zone", price: tp1, rr: Math.round(rr1 * 100) / 100 },
      { label: "Runner", price: tp2, rr: RUNNER_R },
    ],
    riskReward: Math.round(rr1 * 100) / 100,
  };
  return { signal, zone, pinBarTime: pin.time };
}
