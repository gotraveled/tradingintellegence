import type { Candle, Direction, Price } from "@/lib/types";

/**
 * Deterministic signal engine over real OHLCV candles — the same data the
 * chart draws, so every level it emits is traceable to a bar on screen.
 *
 * Method (auditable, no model, no fabrication):
 *  1. Trend: EMA20/EMA50 separation on closes — bullish when price and the
 *     fast EMA sit above the slow EMA (and mirrored for bearish).
 *  2. Structure: pivot highs/lows (k=3 fractal) → most recent swings; the
 *     last two higher/lower swing pairs describe HH/HL vs LH/LL.
 *  3. Zones: recent untested pivot clusters become supply (resistance) /
 *     demand (support) bands; an already-violated zone is not a zone.
 *  4. Signal: a direction is only proposed when trend and structure agree
 *     AND price is near a fresh opposing zone (entry location matters).
 *     Entry = last close; SL = zone edge ± 0.5×ATR buffer; TP1 = 1.5R
 *     capped by the next opposing zone, TP2 = 2.5R.
 *  5. Confidence: a 0–100 confluence score over five named, measurable
 *     factors (trend agreement, structure, momentum via RSI, entry at a
 *     zone, and reward:risk ≥ 1R). It is a count of agreeing factors —
 *     NOT a win-rate prediction and is labelled as such in the UI.
 *     Every condition that can veto a trade is itself a scored factor, so
 *     a "wait" verdict can never display a full 100.
 *
 * What this does NOT do: predict, optimize per-symbol, read higher
 * timeframes, or produce a trade command. "wait" is a valid answer.
 */

export interface SignalZone {
  kind: "demand" | "supply";
  lower: Price;
  upper: Price;
  /** Bars since the zone's pivot formed — smaller = fresher. */
  ageBars: number;
}

/** One scored confluence factor — the unit of the signal's points breakdown. */
export interface SignalFactor {
  /** Short factor name, e.g. "EMA trend". */
  label: string;
  /** True when the measured factor agrees with the proposed direction. */
  agrees: boolean;
  /** Points contributed — `weight` when agreeing, 0 otherwise. */
  points: number;
  /** Maximum points this factor can contribute. */
  weight: number;
  /** One-line measured evidence, e.g. "EMA20 above EMA50 (+2.1 ATR)". */
  note: string;
}

export interface TradeSignal {
  /** "wait" = no directional edge met the minimum bar; levels are undefined. */
  direction: Direction | "wait";
  /** Confluence score 0–100 — sum of agreeing factor points. */
  confidence: number;
  /** Per-factor breakdown behind `confidence` — auditable, not a win rate. */
  factors: SignalFactor[];
  reasons: string[];
  entry?: Price;
  stopLoss?: Price;
  targets: { label: string; price: Price; rr: number }[];
  /** Net risk:reward to TP1 when a signal exists. */
  riskReward?: number;
}

export interface SignalAnalysis {
  candlesRead: number;
  trend: { fastEma: number; slowEma: number; direction: Direction | "ranging" };
  momentum: { rsi14: number };
  volatility: {
    atr14: number;
    /**
     * Kaufman efficiency ratio over ER_PERIOD closes — net move / total
     * path, 0..1. Low = sideways chop, high = directional. The sideways
     * veto lives here.
     */
    er20: number;
  };
  structure: { note: string; bullish: number; bearish: number };
  zones: SignalZone[];
  signal: TradeSignal;
  caveats: string[];
}

const MIN_BARS = 60;
const PIVOT_BARS = 3;
const ATR_PERIOD = 14;
const EMA_FAST = 20;
const EMA_SLOW = 50;
const SL_ATR_BUFFER = 0.5;
const ZONE_MAX_AGE = 80; // bars
const ZONE_PROXIMITY_ATR = 1.5; // entry must sit within this ATR distance of the zone
const ER_PERIOD = 20;
/**
 * Below this efficiency ratio the tape is dead — price covers under a
 * quarter of its own path. Deliberately strict: trend pullbacks can
 * legitimately score ~0.3 and are judged by structure instead.
 */
const MIN_ER = 0.25;

function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function atr(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  }
  return sum / period;
}

function rsi(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss += -d;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

/**
 * Kaufman efficiency ratio: |net change| / sum(|bar changes|) over `period`
 * closes. ~1 = clean directional travel; ~0 = back-and-forth chop where
 * every gain is handed back — the classic sideways signature EMA spacing
 * alone can't catch.
 */
function efficiencyRatio(closes: number[], period: number): number {
  const n = closes.length;
  if (n < period + 1) return 1; // insufficient history → don't veto
  const net = Math.abs(closes[n - 1] - closes[n - 1 - period]);
  let path = 0;
  for (let i = n - period; i < n; i += 1) {
    path += Math.abs(closes[i] - closes[i - 1]);
  }
  return path === 0 ? 0 : net / path;
}

interface Pivot {
  index: number;
  price: number;
  kind: "high" | "low";
}

function pivots(candles: Candle[], k: number): Pivot[] {
  const out: Pivot[] = [];
  for (let i = k; i < candles.length - k; i += 1) {
    const high = candles[i].high;
    const low = candles[i].low;
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j += 1) {
      if (j === i) continue;
      if (candles[j].high >= high) isHigh = false;
      if (candles[j].low <= low) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: high, kind: "high" });
    if (isLow) out.push({ index: i, price: low, kind: "low" });
  }
  return out;
}

/**
 * Pivot → zone: a recent swing high that price has not since closed above is
 * supply; a swing low not yet closed below is demand. Zone edges are the
 * pivot bar's wick extremes — measured, not smoothed.
 */
function zonesFromPivots(candles: Candle[], piv: Pivot[]): SignalZone[] {
  const lastIndex = candles.length - 1;
  const lastClose = candles[lastIndex].close;
  const zones: SignalZone[] = [];
  const recent = piv.filter((p) => lastIndex - p.index <= ZONE_MAX_AGE);
  for (const p of recent) {
    const bar = candles[p.index];
    // Broken once price CLOSED through the pivot level after it formed.
    const broken =
      p.kind === "high"
        ? candles.slice(p.index + 1).some((c) => c.close > p.price)
        : candles.slice(p.index + 1).some((c) => c.close < p.price);
    if (broken) continue;
    zones.push({
      kind: p.kind === "high" ? "supply" : "demand",
      upper: p.kind === "high" ? bar.high : Math.max(bar.open, bar.close),
      lower: p.kind === "high" ? Math.min(bar.open, bar.close) : bar.low,
      ageBars: lastIndex - p.index,
    });
  }
  // Nearest opposing zones first — supply above price, demand below.
  return zones
    .filter((z) => (z.kind === "supply" ? z.lower > lastClose * 0.995 : z.upper < lastClose * 1.005))
    .sort((a, b) => a.ageBars - b.ageBars)
    .slice(0, 4);
}

/** Nearest zone of a kind by distance of its nearest edge to price. */
function nearestZone(zones: SignalZone[], kind: "demand" | "supply", price: number) {
  const list = zones.filter((z) => z.kind === kind);
  if (list.length === 0) return undefined;
  return list.reduce((best, z) => {
    const d = Math.min(Math.abs(z.upper - price), Math.abs(z.lower - price));
    const bd = Math.min(Math.abs(best.upper - price), Math.abs(best.lower - price));
    return d < bd ? z : best;
  });
}

/** Test-only access to swing detection. */
export function __debugPivots(candles: Candle[]): Pivot[] {
  return pivots(candles, PIVOT_BARS);
}

export function analyzeCandles(candles: Candle[]): SignalAnalysis | undefined {
  if (candles.length < MIN_BARS) return undefined;

  const closes = candles.map((c) => c.close);
  const last = candles[candles.length - 1];
  const price = last.close;
  const atr14 = atr(candles, ATR_PERIOD);
  const rsi14 = rsi(closes, 14);
  const fast = ema(closes, EMA_FAST);
  const slow = ema(closes, EMA_SLOW);
  const emaF = fast[fast.length - 1];
  const emaS = slow[slow.length - 1];
  const piv = pivots(candles, PIVOT_BARS);
  const zones = zonesFromPivots(candles, piv);

  // Scale-free trend test: EMA separation relative to ATR — a fixed percent
  // threshold misreads flat tape on high-priced symbols as a trend.
  const emaSpreadAtr = atr14 > 0 ? Math.abs(emaF - emaS) / atr14 : 0;
  // Sideways veto #2: efficiency ratio catches rotating tape the EMAs
  // can't — a slow drift with EMAs apart but every leg retraced still
  // reads "ranging" here.
  const er20 = efficiencyRatio(closes, ER_PERIOD);
  const trendDir: Direction | "ranging" =
    atr14 === 0 || emaSpreadAtr < 0.5 || er20 < MIN_ER
      ? "ranging"
      : emaF >= emaS
        ? "bullish"
        : "bearish";

  // Structure from the two most recent swing highs and lows.
  const swingHighs = piv.filter((p) => p.kind === "high").slice(-2);
  const swingLows = piv.filter((p) => p.kind === "low").slice(-2);
  const higherHigh = swingHighs.length === 2 && swingHighs[1].price > swingHighs[0].price;
  const higherLow = swingLows.length === 2 && swingLows[1].price > swingLows[0].price;
  const structBull = (higherHigh ? 1 : 0) + (higherLow ? 1 : 0);
  const structBear = (swingHighs.length === 2 && swingHighs[1].price < swingHighs[0].price ? 1 : 0) +
    (swingLows.length === 2 && swingLows[1].price < swingLows[0].price ? 1 : 0);
  const structureNote =
    structBull === 2 ? "higher highs and higher lows"
    : structBear === 2 ? "lower highs and lower lows"
    : structBull > structBear ? "improving — latest swing high is higher"
    : structBear > structBull ? "weakening — latest swing low is lower"
    : "mixed / rotating swings";

  const signal: TradeSignal = {
    direction: "wait",
    confidence: 0,
    factors: [],
    reasons: [],
    targets: [],
  };
  const caveats: string[] = [
    "Confluence score counts agreeing measured factors — it is not a win-rate prediction.",
    "Levels derive from the visible window only; higher-timeframe context is not consulted.",
    "Not financial advice — verify levels on your own chart before acting.",
  ];

  if (atr14 === 0 || trendDir === "ranging") {
    signal.reasons.push(
      atr14 === 0
        ? "Volatility could not be measured — no signal proposed."
        : er20 < MIN_ER
          ? `Sideways market — price travelled only ${(er20 * 100).toFixed(0)}% of its path over ${ER_PERIOD} bars; rotating structure, no trade.`
          : "EMA20/50 are intertwined — ranging tape, no directional edge proposed.",
    );
  } else {
    const side: Direction = trendDir;
    const entryZone = nearestZone(zones, side === "bullish" ? "demand" : "supply", price);
    const exitZone = nearestZone(zones, side === "bullish" ? "supply" : "demand", price);
    const nearEntry =
      entryZone !== undefined &&
      Math.min(Math.abs(entryZone.upper - price), Math.abs(entryZone.lower - price)) <=
        ZONE_PROXIMITY_ATR * atr14;

    const reasons: string[] = [];
    if (trendDir === side) reasons.push(`EMA20 ${side === "bullish" ? "above" : "below"} EMA50`);
    if (side === "bullish" ? structBull >= 1 : structBear >= 1) {
      reasons.push(`Structure supports ${side}: ${structureNote}`);
    }
    const mom = rsi14 > 50 ? "bullish" : rsi14 < 50 ? "bearish" : "neutral";
    if (mom === side) reasons.push(`Momentum agrees (RSI14 ${rsi14.toFixed(0)})`);
    if (nearEntry && entryZone) {
      reasons.push(`Price is inside/near a ${entryZone.kind} zone (${entryZone.ageBars} bars old)`);
    }

    // Compute the trade plan up front so reward:risk can be scored as a
    // factor — every veto a trade can hit must be visible in the points.
    const buffer = SL_ATR_BUFFER * atr14;
    const entry = price;
    const stopLoss =
      entryZone === undefined
        ? undefined
        : side === "bullish" ? entryZone.lower - buffer : entryZone.upper + buffer;
    const risk = entryZone === undefined || stopLoss === undefined ? 0 : Math.abs(entry - stopLoss);
    let tp1 = side === "bullish" ? entry + 1.5 * risk : entry - 1.5 * risk;
    const tp2 = side === "bullish" ? entry + 2.5 * risk : entry - 2.5 * risk;
    // Cap TP1 at the nearest opposing zone if it's closer — don't aim through supply.
    if (exitZone) {
      const zEdge = side === "bullish" ? exitZone.lower : exitZone.upper;
      const realistic = side === "bullish" ? Math.min(tp1, zEdge) : Math.max(tp1, zEdge);
      if (side === "bullish" ? realistic > entry : realistic < entry) tp1 = realistic;
    }
    const rr1 = risk === 0 ? 0 : Math.abs(tp1 - entry) / risk;
    const rrOk = risk > 0 && rr1 >= 1;

    // Confidence = share of agreeing measured factors (0–100 over five
    // 20-point factors), exposed as a named points breakdown so the UI can
    // show exactly what agreed — and exactly what vetoed the trade.
    const structAgrees =
      side === "bullish" ? structBull > structBear : structBear > structBull;
    const factorWeights: Omit<SignalFactor, "points">[] = [
      {
        label: "EMA trend",
        agrees: true, // trendDir === side by construction inside this branch
        weight: 20,
        note: `EMA20 ${side === "bullish" ? "above" : "below"} EMA50 (${emaSpreadAtr.toFixed(1)} ATR apart)`,
      },
      {
        label: "Swing structure",
        agrees: structAgrees,
        weight: 20,
        note: structureNote,
      },
      {
        label: "Momentum",
        agrees: mom === side,
        weight: 20,
        note: `RSI14 ${rsi14.toFixed(0)} — ${mom}`,
      },
      {
        label: "Entry at zone",
        agrees: nearEntry,
        weight: 20,
        note:
          nearEntry && entryZone
            ? `Inside/near ${entryZone.kind} zone (${entryZone.ageBars} bars old)`
            : `Not near a ${side === "bullish" ? "demand" : "supply"} zone`,
      },
      {
        label: "Reward ≥ 1R",
        agrees: rrOk,
        weight: 20,
        note:
          entryZone === undefined
            ? `No ${side === "bullish" ? "demand" : "supply"} zone to anchor a stop`
            : rrOk
              ? `TP1 pays ${rr1.toFixed(1)}R against the ${entryZone.kind}-zone stop`
              : `Opposing zone caps the trade at ${rr1.toFixed(1)}R`,
      },
    ];
    signal.factors = factorWeights.map((f) => ({
      ...f,
      points: f.agrees ? f.weight : 0,
    }));
    const agreed = signal.factors.filter((f) => f.agrees).length;
    signal.confidence = signal.factors.reduce((sum, f) => sum + f.points, 0);
    signal.reasons = reasons;

    // Only propose when location, reward, structure and ≥4/5 factors
    // agree. Structure is MANDATORY — trading against rotating or opposing
    // swings is exactly the sideways/no-edge behaviour this engine avoids.
    if (
      nearEntry &&
      entryZone &&
      rrOk &&
      agreed >= 4 &&
      structAgrees &&
      stopLoss !== undefined
    ) {
      signal.direction = side;
      signal.entry = entry;
      signal.stopLoss = stopLoss;
      signal.riskReward = Math.round(rr1 * 10) / 10;
      signal.targets = [
        { label: "TP1", price: tp1, rr: Math.round(rr1 * 10) / 10 },
        { label: "TP2", price: tp2, rr: 2.5 },
      ];
    } else if (agreed >= 4 && !structAgrees) {
      signal.reasons.push(
        `Setup scores ${agreed}/5 but swing structure is ${structureNote} — no trade against rotating structure.`,
      );
    } else if (agreed >= 4 && !nearEntry) {
      signal.reasons.push(
        `Direction agrees (${agreed}/5 factors) but price is not at a ${side === "bullish" ? "demand" : "supply"} zone — entry location missing, so no signal.`,
      );
    } else if (agreed >= 4 && !rrOk) {
      signal.reasons.push(
        `Setup agrees (${agreed}/5 factors) but the nearest opposing zone caps the trade at ${rr1.toFixed(1)}R — below the 1R minimum, so no signal.`,
      );
    } else {
      signal.reasons.push(`Only ${agreed}/5 confluence factors agree — waiting.`);
    }
  }

  return {
    candlesRead: candles.length,
    trend: { fastEma: emaF, slowEma: emaS, direction: trendDir },
    momentum: { rsi14 },
    volatility: { atr14, er20 },
    structure: { note: structureNote, bullish: structBull, bearish: structBear },
    zones,
    signal,
    caveats,
  };
}
