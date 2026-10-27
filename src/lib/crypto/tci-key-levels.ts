import type { Candle } from "@/lib/types";
import { atr, type TradeSignal } from "./analysis";

/**
 * TCI Key Institutional Levels — based on the TradingView indicator by
 * The_Stock_Yogi / Trading Cafe India. A Smart Money Concepts (SMC) engine
 * that identifies institutional footprints:
 *
 *  1. MARKET STRUCTURE — swing highs/lows tracked as "Internal" (short-term)
 *     and "Swing" (long-term). A Break of Structure (BOS) confirms trend
 *     continuation; a Change of Character (CHoCH) flags a reversal.
 *  2. ORDER BLOCKS — the last opposing candle before a strong directional
 *     move. Bullish OB = last down-candle before an up-break; bearish OB =
 *     last up-candle before a down-break. These are the institutional entry
 *     zones. An OB is "mitigated" (consumed) once price revisits it.
 *  3. FAIR VALUE GAPS (FVG) — 3-candle price imbalances that signal
 *     institutional displacement. Auto-thresholded by ATR to filter noise.
 *  4. PREMIUM / DISCOUNT — the equilibrium (50%) of the current swing range.
 *     Buy in discount (below 50%), sell in premium (above 50%).
 *  5. INSTITUTIONAL HIGHS/LOWS — "Strong" levels that led to a BOS are
 *     respected; "Weak" levels are targets for future liquidity runs.
 *
 * Entry logic:
 *   BULLISH: price taps an unmitigated bullish OB in the discount zone,
 *     with a prior BOS up → BUY. Stop below the OB, target the swing high.
 *   BEARISH: price taps an unmitigated bearish OB in the premium zone,
 *     with a prior BOS down → SELL. Stop above the OB, target the swing low.
 *   CHoCH + OB + FVG confluence raises confidence.
 *
 * One signal per tape, evaluated on CLOSED bars only by the caller.
 */

export const TCI_STRATEGY_ID = "tci";

// ---------- structure ----------

interface SwingPoint {
  price: number;
  idx: number;
  kind: "high" | "low";
}

interface Structure {
  /** Recent swing highs and lows in chronological order. */
  swings: SwingPoint[];
  /** "bullish" when recent swings make HH+HL; "bearish" when LH+LL. */
  bias: "bullish" | "bearish" | "undefined";
  /** Last BOS direction — confirms trend continuation. */
  bos?: "bullish" | "bearish";
  /** Last CHoCH direction — flags a potential reversal. */
  choch?: "bullish" | "bearish";
}

const SWING_W = 3; // fractal half-window for structure pivots
const MIN_BARS = 40;

function findSwings(hist: Candle[]): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = SWING_W; i < hist.length - SWING_W; i += 1) {
    const c = hist[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - SWING_W; j <= i + SWING_W; j += 1) {
      if (j === i) continue;
      if (hist[j].high >= c.high) isHigh = false;
      if (hist[j].low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ price: c.high, idx: i, kind: "high" });
    if (isLow) out.push({ price: c.low, idx: i, kind: "low" });
  }
  return out;
}

function analyzeStructure(swings: SwingPoint[]): Structure {
  if (swings.length < 4) return { swings, bias: "undefined" };
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  if (highs.length < 2 || lows.length < 2) return { swings, bias: "undefined" };

  let bos: Structure["bos"];
  let choch: Structure["choch"];

  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1];
  const prevLow = lows[lows.length - 2];

  // BOS: the last swing high broke above the previous swing high (bullish),
  // or the last swing low broke below the previous swing low (bearish).
  // If both broke, the more recent swing determines direction.
  if (lastHigh && prevHigh && lastLow && prevLow) {
    const brokeHigh = lastHigh.price > prevHigh.price;
    const brokeLow = lastLow.price < prevLow.price;
    if (brokeHigh && !brokeLow) {
      bos = "bullish";
    } else if (brokeLow && !brokeHigh) {
      bos = "bearish";
    } else if (brokeHigh && brokeLow) {
      bos = lastHigh.idx > lastLow.idx ? "bullish" : "bearish";
    }
  }

  // If no BOS from the last pair, scan backward for any swing break.
  // Accept HH alone (without requiring HL) as bullish, LL alone as bearish.
  if (bos === undefined) {
    for (let i = 2; i < Math.min(highs.length, lows.length); i += 1) {
      const h = highs[highs.length - i];
      const ph = highs[highs.length - i - 1];
      const l = lows[lows.length - i];
      const pl = lows[lows.length - i - 1];
      if (!h || !ph || !l || !pl) continue;
      if (h.price > ph.price) {
        bos = "bullish";
        break;
      }
      if (l.price < pl.price) {
        bos = "bearish";
        break;
      }
    }
  }

  // CHoCH: if we have a BOS, check if the most recent swing broke the opposite
  // direction first — that's the CHoCH that preceded the BOS.
  if (bos === "bullish" && lastLow.price < prevLow.price) {
    choch = "bullish";
  } else if (bos === "bearish" && lastHigh.price > prevHigh.price) {
    choch = "bearish";
  }

  const bias: Structure["bias"] = bos ?? "undefined";
  return { swings, bias, bos, choch };
}

// ---------- order blocks ----------

export interface OrderBlock {
  kind: "bullish" | "bearish";
  upper: number;
  lower: number;
  idx: number;
  /** True until price revisits the zone (mitigation). */
  mitigated: boolean;
}

const OB_DISPLACEMENT_ATR = 0.5; // the move after the OB must be ≥0.5×ATR

export function findOrderBlocks(hist: Candle[], width: number): OrderBlock[] {
  const out: OrderBlock[] = [];
  const displacement = width * OB_DISPLACEMENT_ATR;
  for (let i = SWING_W; i < hist.length - SWING_W - 1; i += 1) {
    const c = hist[i];
    const next = hist[i + 1];
    // Bullish OB: last DOWN (or flat) candle before a strong up-move
    if (c.close <= c.open && next.close > c.open + displacement) {
      out.push({
        kind: "bullish",
        upper: c.high,
        lower: c.low,
        idx: i,
        mitigated: false,
      });
    }
    // Bearish OB: last UP (or flat) candle before a strong down-move
    if (c.close >= c.open && next.close < c.open - displacement) {
      out.push({
        kind: "bearish",
        upper: c.high,
        lower: c.low,
        idx: i,
        mitigated: false,
      });
    }
  }
  // Mark mitigation: price returned to the zone AFTER the displacement move.
  // Skip the bars immediately after the OB (the displacement itself) and start
  // checking once price has left the zone — a return LATER is the mitigation.
  // Don't count the last few bars (the current tag) as mitigation — that's
  // the entry, not a prior consumption.
  const TAG_WINDOW = 12;
  for (const ob of out) {
    let left = false;
    const until = hist.length - TAG_WINDOW;
    for (let i = ob.idx + 2; i < until; i += 1) {
      const c = hist[i];
      if (!left) {
        if (c.low > ob.upper && c.high > ob.upper) {
          left = true;
        } else if (c.high < ob.lower && c.low < ob.lower) {
          left = true;
        }
        continue;
      }
      if (c.low <= ob.upper && c.high >= ob.lower) {
        ob.mitigated = true;
        break;
      }
    }
  }
  return out;
}

// ---------- FVG ----------

interface Fvg {
  kind: "bullish" | "bearish";
  upper: number;
  lower: number;
  idx: number;
}

const FVG_MIN_ATR = 0.3; // gap must be ≥0.3×ATR to count (auto-threshold)

function findFvgs(hist: Candle[], width: number): Fvg[] {
  const out: Fvg[] = [];
  const minGap = width * FVG_MIN_ATR;
  for (let i = 2; i < hist.length; i += 1) {
    // Bullish FVG: bar i's low > bar i-2's high
    const up = hist[i].low - hist[i - 2].high;
    if (up > minGap) {
      out.push({ kind: "bullish", upper: hist[i].low, lower: hist[i - 2].high, idx: i });
    }
    // Bearish FVG: bar i's high < bar i-2's low
    const dn = hist[i - 2].low - hist[i].high;
    if (dn > minGap) {
      out.push({ kind: "bearish", upper: hist[i - 2].low, lower: hist[i].high, idx: i });
    }
  }
  return out;
}

// ---------- premium / discount ----------

function premiumDiscount(hist: Candle[], swings: SwingPoint[]): {
  equilibrium: number;
  premium: boolean;
  discount: boolean;
} {
  if (swings.length < 2) return { equilibrium: 0, premium: false, discount: false };
  const recent = swings.slice(-4);
  const hi = Math.max(...recent.map((s) => (s.kind === "high" ? s.price : 0)));
  const lo = Math.min(...recent.map((s) => (s.kind === "low" ? s.price : Infinity)));
  if (!isFinite(hi) || !isFinite(lo) || hi === lo) {
    return { equilibrium: 0, premium: false, discount: false };
  }
  const equilibrium = (hi + lo) / 2;
  const price = hist[hist.length - 1].close;
  return {
    equilibrium,
    premium: price > equilibrium,
    discount: price < equilibrium,
  };
}

// ---------- the signal ----------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function tciKeySignal(hist: Candle[]): TradeSignal | undefined {
  if (hist.length < MIN_BARS) return undefined;
  const last = hist[hist.length - 1];
  const entry = last.close;
  const width = atr(hist, 14);
  if (width === 0) return undefined;

  const swings = findSwings(hist);
  const structure = analyzeStructure(swings);
  const obs = findOrderBlocks(hist, width);
  const fvgs = findFvgs(hist, width);
  const pd = premiumDiscount(hist, swings);

  // Find the nearest unmitigated OB that price is tapping
  const tagBand = width * 1.0;
  const recent = hist.slice(-12);

  // Bullish setup: unmitigated bullish OB in discount zone + BOS up
  const bullObs = obs
    .filter((ob) => ob.kind === "bullish" && !ob.mitigated)
    .filter((ob) => recent.some((c) => c.low <= ob.upper + tagBand && c.high >= ob.lower - tagBand))
    .sort((a, b) => Math.abs(((a.upper + a.lower) / 2) - entry) - Math.abs(((b.upper + b.lower) / 2) - entry));

  // Bearish setup: unmitigated bearish OB in premium zone + BOS down
  const bearObs = obs
    .filter((ob) => ob.kind === "bearish" && !ob.mitigated)
    .filter((ob) => recent.some((c) => c.high >= ob.lower - tagBand && c.low <= ob.upper + tagBand))
    .sort((a, b) => Math.abs(((a.upper + a.lower) / 2) - entry) - Math.abs(((b.upper + b.lower) / 2) - entry));

  // Also check for CHoCH-based reversal entries
  const bullChoch = structure.choch === "bullish";
  const bearChoch = structure.choch === "bearish";
  const bullBos = structure.bos === "bullish";
  const bearBos = structure.bos === "bearish";

  // Try bullish entry
  if (bullObs.length > 0 && (bullBos || bullChoch)) {
    const ob = bullObs[0];
    const stop = ob.lower - width * 0.25;
    const risk = Math.abs(entry - stop);
    if (risk <= 0) return undefined;

    // Target: nearest swing high above
    const targetSwing = swings
      .filter((s) => s.kind === "high" && s.price > entry)
      .sort((a, b) => a.price - b.price)[0];
    const tp1 = targetSwing !== undefined && targetSwing.price > entry + risk
      ? targetSwing.price
      : entry + 2 * risk;
    const rr1 = Math.abs(tp1 - entry) / risk;

    // Confluence scoring
    const fvgHit = fvgs.some(
      (f) => f.kind === "bullish" && entry >= f.lower && entry <= f.upper,
    );
    const inDiscount = pd.discount;
    const freshOb = hist.length - ob.idx > 20; // OB formed >20 bars ago = fresh return

    const confidence = Math.min(
      92,
      50 + (bullBos ? 10 : 0) + (bullChoch ? 8 : 0) +
        (inDiscount ? 8 : 0) + (fvgHit ? 7 : 0) + (freshOb ? 5 : 0) +
        (rr1 >= 2 ? 5 : 0),
    );

    const reasons = [
      `Bullish Order Block ${round2(ob.lower)}–${round2(ob.upper)} tapped (${bullBos ? "BOS up" : "CHoCH up"})`,
      `Premium/Discount: ${inDiscount ? "discount zone" : "near equilibrium"} (eq ${round2(pd.equilibrium)})`,
      ...(fvgHit ? ["Confluence: inside a bullish FVG"] : []),
      ...(freshOb ? ["Fresh OB — first return since formation"] : []),
      `Plan: risk ${round2(risk)} → target ${round2(tp1)} (${round2(rr1)}R); stop ${round2(stop)} below the OB`,
    ];

    return {
      direction: "bullish",
      confidence,
      factors: [],
      reasons,
      entry,
      stopLoss: stop,
      riskReward: round2(rr1),
      targets: [
        { label: "TP1", price: tp1, rr: round2(rr1) },
        { label: "TP2", price: entry + 3 * risk, rr: 3 },
      ],
    };
  }

  // Try bearish entry
  if (bearObs.length > 0 && (bearBos || bearChoch)) {
    const ob = bearObs[0];
    const stop = ob.upper + width * 0.25;
    const risk = Math.abs(stop - entry);
    if (risk <= 0) return undefined;

    // Target: nearest swing low below
    const targetSwing = swings
      .filter((s) => s.kind === "low" && s.price < entry)
      .sort((a, b) => b.price - a.price)[0];
    const tp1 = targetSwing !== undefined && targetSwing.price < entry - risk
      ? targetSwing.price
      : entry - 2 * risk;
    const rr1 = Math.abs(entry - tp1) / risk;

    const fvgHit = fvgs.some(
      (f) => f.kind === "bearish" && entry >= f.lower && entry <= f.upper,
    );
    const inPremium = pd.premium;
    const freshOb = hist.length - ob.idx > 20;

    const confidence = Math.min(
      92,
      50 + (bearBos ? 10 : 0) + (bearChoch ? 8 : 0) +
        (inPremium ? 8 : 0) + (fvgHit ? 7 : 0) + (freshOb ? 5 : 0) +
        (rr1 >= 2 ? 5 : 0),
    );

    const reasons = [
      `Bearish Order Block ${round2(ob.lower)}–${round2(ob.upper)} tapped (${bearBos ? "BOS down" : "CHoCH down"})`,
      `Premium/Discount: ${inPremium ? "premium zone" : "near equilibrium"} (eq ${round2(pd.equilibrium)})`,
      ...(fvgHit ? ["Confluence: inside a bearish FVG"] : []),
      ...(freshOb ? ["Fresh OB — first return since formation"] : []),
      `Plan: risk ${round2(risk)} → target ${round2(tp1)} (${round2(rr1)}R); stop ${round2(stop)} above the OB`,
    ];

    return {
      direction: "bearish",
      confidence,
      factors: [],
      reasons,
      entry,
      stopLoss: stop,
      riskReward: round2(rr1),
      targets: [
        { label: "TP1", price: tp1, rr: round2(rr1) },
        { label: "TP2", price: entry - 3 * risk, rr: 3 },
      ],
    };
  }

  return undefined;
}
