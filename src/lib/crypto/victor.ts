import type { Candle, Direction, Price } from "@/lib/types";
import type { TradeSignal } from "./analysis";
import { patternConfirmations } from "./patterns";

/**
 * "Victor" — pure price-action entries, no indicators.
 *
 * Victor scalp — the pin/follow-up fire on the ENTRY timeframe (1m), but
 * the zones they react to are measured on the CONTEXT timeframes
 * (5m + 15m). A level only counts as STRONG when zones from two different
 * context timeframes overlap — multi-TF agreement is what makes it tradeable.
 *
 * Setup — THREE core confirmations, evaluated on closed bars only:
 *  1. Pin bar on the entry TF — rejection wick ≥ 2× the body AND ≥ 2× the
 *     opposing wick — whose tail poked into a context zone and whose
 *     close pulled back out of it (the zone rejection IS confirmation 1).
 *  2. Follow-up: the NEXT closed entry candle confirms — same direction
 *     colour and a close beyond the pin bar's close.
 *  3. Risk:reward ≥ 1R to the target.
 *  Bonuses (confidence, not gates): a STRONG zone — same-kind zones on
 *  separate context TFs overlapping — and independent candlestick/chart
 *  patterns agreeing (star, engulfing, hammer, three-soldiers on the
 *  entry tape, or a W bottom / M top on the 5m context).
 *
 * Entry  = follow-up candle's close (the signal bar).
 * Stop   = pin bar's extreme (low for longs, high for shorts) — the wick
 *          that defined the rejection; while in profit it trails under
 *          the extreme of the candle before the latest closed bar.
 * Target = next opposing context zone edge, else the nearest opposing
 *          entry-TF swing; TP2 = 2.5R runner.
 *
 * Zones are leg–base–leg imbalances: a strong leg-in candle, a 1–4-bar
 * consolidation base, then a strong leg-out in the opposite direction.
 * Drop-base-rally leaves demand, rally-base-drop leaves supply — zones
 * born from energetic departure, never lone wicks, never smoothed.
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

// ---- Leg–base–leg zone detection ----------------------------------------
// A tradeable zone is an imbalance pocket, not a lone wick: a STRONG leg-in
// candle, 1–BASE_MAX small consolidation bars, then a STRONG leg-out candle
// in the OPPOSITE direction. Drop-base-rally → demand, rally-base-drop →
// supply. Zone bounds are the base's full range; a close through the far
// edge kills it.
const BASE_MAX = 4;
/** A leg bar's range must beat this multiple of the tape's average. */
const LEG_RANGE_MULT = 1.5;
/** And close decisively — body ≥ this share of range, near the extreme. */
const LEG_BODY_SHARE = 0.55;
const LEG_CLOSE_OFFSET = 0.3;

function barRange(c: Candle): number {
  return c.high - c.low;
}

/** Direction of an energetic leg candle; undefined for ordinary bars. */
function legDir(c: Candle, avgRange: number): Direction | undefined {
  const r = barRange(c);
  const body = Math.abs(c.close - c.open);
  if (r < LEG_RANGE_MULT * avgRange || body < LEG_BODY_SHARE * r) return undefined;
  if (c.close >= c.high - LEG_CLOSE_OFFSET * r) return "bullish";
  if (c.close <= c.low + LEG_CLOSE_OFFSET * r) return "bearish";
  return undefined;
}

/**
 * Leg–base–leg supply/demand zones. A bearish leg + base + bullish leg
 * leaves demand; bullish leg + base + bearish leg leaves supply. A zone
 * dies once price closes through its far edge. `strong` is filled by
 * `markStrongAcross` later — zones from one timeframe alone are never
 * assumed MTF-confirmed.
 */
export function swingZones(candles: Candle[]): VictorZone[] {
  const last = candles.length - 1;
  const zones: VictorZone[] = [];
  const ranges = candles.map(barRange);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / Math.max(ranges.length, 1);
  if (avgRange === 0) return zones;

  for (let i = 1; i < candles.length - 1; i += 1) {
    const inDir = legDir(candles[i], avgRange);
    if (inDir === undefined) continue;
    // Collect up to BASE_MAX small base bars, then require the opposite leg.
    let baseEnd = i + 1;
    while (
      baseEnd < candles.length &&
      baseEnd - (i + 1) < BASE_MAX &&
      legDir(candles[baseEnd], avgRange) === undefined
    ) {
      baseEnd += 1;
    }
    if (baseEnd === i + 1 || baseEnd >= candles.length) continue; // no base, or ran off the tape
    const outDir = legDir(candles[baseEnd], avgRange);
    if (outDir === undefined || outDir === inDir) continue;
    const base = candles.slice(i + 1, baseEnd);
    const lower = Math.min(...base.map((c) => c.low));
    const upper = Math.max(...base.map((c) => c.high));
    const kind = inDir === "bearish" ? "demand" : "supply"; // fell in/rallied out → demand
    if (last - (baseEnd - 1) > ZONE_MAX_AGE) continue;
    const after = candles.slice(baseEnd + 1);
    const broken = after.some((c) => (kind === "demand" ? c.close < lower : c.close > upper));
    if (broken) continue;
    zones.push({
      kind,
      lower,
      upper,
      pivotIndex: baseEnd - 1,
      strong: false,
      touches: after.filter((c) => c.low <= upper && c.high >= lower).length,
    });
    i = baseEnd; // consumed the pattern — resume after the leg-out
  }
  return zones;
}

/** Zones overlap when their bands share any price — not identical, aligned. */
function overlap(a: { lower: Price; upper: Price }, b: { lower: Price; upper: Price }): boolean {
  return a.lower <= b.upper && b.lower <= a.upper;
}

/**
 * Mark zones confirmed across context timeframes: a zone is "strong"
 * when a same-kind zone from a DIFFERENT context set overlaps it. Zones
 * within one timeframe can never confirm themselves.
 */
export function markStrongAcross(contextZones: VictorZone[][]): VictorZone[] {
  const out: VictorZone[] = [];
  contextZones.forEach((zones, i) => {
    for (const z of zones) {
      z.strong = contextZones.some(
        (other, j) => j !== i && other.some((h) => h.kind === z.kind && overlap(z, h)),
      );
      out.push(z);
    }
  });
  return out;
}

/** Flag LTF zones confirmed by a same-kind HTF zone — kept for the chart. */
export function markStrong(ltf: VictorZone[], htf: VictorZone[]): void {
  for (const z of ltf) {
    z.strong = htf.some((h) => h.kind === z.kind && overlap(z, h));
  }
}

/**
 * Evaluate the last two closed ENTRY-timeframe bars for a Victor setup.
 * `contexts` are the higher-timeframe candle sets (5m, 15m) that supply
 * and demand zones are measured on — with fewer than two usable context
 * sets no zone can be proven strong, so no signal.
 */
export function victorSignal(
  entryCandles: Candle[],
  contexts: readonly Candle[][],
): VictorSetup | undefined {
  if (entryCandles.length < 30) return undefined;
  const usable = contexts.filter((c) => c !== undefined && c.length >= 30);
  if (usable.length < 2) return undefined; // needs ≥2 TFs to confirm a level
  const pin = entryCandles[entryCandles.length - 2];
  const follow = entryCandles[entryCandles.length - 1];
  const dir = pinBar(pin);
  if (dir === undefined) return undefined;

  // Follow-up confirmation: same colour AND closes beyond the pin's close.
  const confirms =
    dir === "bullish"
      ? follow.close > follow.open && follow.close > pin.close
      : follow.close < follow.open && follow.close < pin.close;
  if (!confirms) return undefined;

  // The pin's tail must have rejected a context zone: bullish tail tags
  // demand, bearish tail tags supply — wick entered, close pulled back out.
  const zones = markStrongAcross(usable.map((c) => swingZones(c)));
  const zone = zones.find((z) => {
    if (z.kind !== (dir === "bullish" ? "demand" : "supply")) return false;
    const tail = dir === "bullish" ? pin.low : pin.high;
    const entered = tail <= z.upper + TAG_TOLERANCE && tail >= z.lower - TAG_TOLERANCE;
    const closedOut =
      dir === "bullish" ? pin.close >= z.lower : pin.close <= z.upper;
    return entered && closedOut;
  });
  if (zone === undefined) return undefined;

  // Bonus confirmations — a zone confirmed on BOTH context TFs and any
  // agreeing pattern (pre-pin stars/engulfing/W on the entry tape, or a
  // pattern printed on the first context TF) raise confidence; they are
  // not required now that pin+follow+zone+RR form the three-confirmation
  // core.
  const prior = patternConfirmations(entryCandles.slice(0, -2), dir);
  const ctxPat = patternConfirmations(usable[0], dir);
  const patScore = prior.score + ctxPat.score;
  const patNames = [...prior.names, ...ctxPat.names];

  const entry = follow.close;
  const stopLoss = dir === "bullish" ? pin.low : pin.high;
  const risk = Math.abs(entry - stopLoss);
  if (risk === 0) return undefined;

  // Target = next opposing level: nearest opposite-kind context-zone edge
  // past entry, falling back to the nearest opposing entry-TF swing pivot.
  const opposing = zones
    .filter((z) => z.kind !== zone.kind)
    .map((z) => (dir === "bullish" ? z.lower : z.upper))
    .filter((p) => (dir === "bullish" ? p > entry : p < entry))
    .sort((a, b) => (dir === "bullish" ? a - b : b - a));
  let tp1 = opposing[0];
  if (tp1 === undefined) {
    // No zone ahead — aim at the nearest unbroken opposing swing pivot.
    const piv = swings(entryCandles)
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
    60 + (zone.strong ? 15 : 0) +
      (tail >= 3 * Math.max(body, 1e-12) ? 5 : 0) + (zone.touches >= 1 ? 5 : 0) +
      (entryCandles.length - 1 - zone.pivotIndex <= 80 ? 5 : 0) +
      (rr1 >= 1.5 ? 5 : 0) + (patScore >= 2 ? 10 : patScore >= 1 ? 5 : 0),
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
        label: "MTF zone",
        agrees: zone.strong,
        points: zone.strong ? 20 : 0,
        weight: 20,
        note: zone.strong
          ? "Zone overlaps a higher-timeframe zone — strong level"
          : "Zone on one context TF only — weak level",
      },
      {
        label: "Follow-up",
        agrees: true,
        points: 20,
        weight: 20,
        note: "Confirmation candle closed beyond the pin",
      },
      {
        label: "Pattern",
        agrees: patScore > 0,
        points: patScore > 0 ? 20 : 0,
        weight: 20,
        note:
          patScore > 0
            ? `Confirmed by ${patNames.join(", ")}`
            : "No extra pattern printed",
      },
    ],
    reasons: [
      `Victor pin bar — ${dir === "bullish" ? "bullish rejection at demand" : "bearish rejection at supply"}`,
      `Stop at pin ${dir === "bullish" ? "low" : "high"} ${stopLoss}, target next opposing zone`,
      zone.strong
        ? "Multi-timeframe aligned zone — level confirmed on 5m+15m"
        : "Single-timeframe zone — level confirmed on one context TF",
      ...(patNames.length > 0 ? [`Pattern confirmation: ${patNames.join(", ")}`] : []),
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
