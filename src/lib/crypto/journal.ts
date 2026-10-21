import type { Candle, Direction, Price, Timeframe } from "@/lib/types";
import type { TradeSignal } from "./analysis";

/**
 * Paper-trade journal — the engine's live signals, booked and carried
 * forward against real bars so the dashboard can answer "how did the
 * signals actually do?" with measured outcomes instead of claims.
 *
 * Model (documented, deterministic, conservative):
 *  - Entry: the signal's entry price (last close at signal time). The bar
 *    the signal was emitted on is never used for exits — evaluation starts
 *    on the next bar.
 *  - Exit order within a bar is CONSERVATIVE: if a bar touches both the
 *    stop and a target, the stop is assumed hit first. TP2 is checked
 *    after TP1, so a single bar can bank TP1 and close at TP2.
 *  - TP1 management: when TP1 trades, half the position is treated as
 *    banked (recorded as a blended realizedR) and the stop moves to
 *    breakeven, then trails at 1R behind the close.
 *  - Expiry: a trade that resolves nothing within EXPIRY_BARS closed bars
 *    exits at market — flat tapes don't inflate the record.
 *  - Everything lives in localStorage: this is a local journal, not a
 *    broker account. Wins/losses describe the signal engine on these bars,
 *    not a promise of future results.
 */

export interface TradeTarget {
  label: string;
  price: Price;
  rr: number;
}

export type TradeExitReason = "stop" | "target" | "expired" | "manual";
export type TradeOutcome = "win" | "loss" | "flat";

export interface TradeRecord {
  id: string;
  venue: string;
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
  entry: Price;
  /** Stop as it stands now — breakeven/trailing moves mutate this. */
  stopLoss: Price;
  /** Original stop — the "risk" unit R is measured against it. */
  initialStopLoss: Price;
  targets: TradeTarget[];
  /** Confluence points at signal time (0–100). */
  confidence: number;
  /** Which strategy booked this trade — "confluence" (default) or "victor". */
  strategy?: string;
  /** US dollars risked (≈1% of equity at booking — 1R in money terms). */
  riskUsd?: number;
  /** Wall-clock ms when the signal was booked. */
  openedAt: number;
  /** Open-time (ms) of the bar the signal was emitted on. */
  entryBarTime: number;
  /** Open-time of the newest bar already evaluated. */
  lastProcessedBarTime: number;
  barsHeld: number;
  tp1Hit: boolean;
  status: "open" | "closed";
  exitPrice?: Price;
  /** Wall-clock ms when the trade closed. */
  exitTime?: number;
  exitReason?: TradeExitReason;
  /** Blended R result: full exit R, or 0.5×TP1 + 0.5×exit when TP1 banked. */
  realizedR?: number;
}

export interface DailyStats {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  trades: number;
  wins: number;
  losses: number;
  flats: number;
  netR: number;
  /** Net closed profit/loss in USD for the day. */
  netUsd: number;
  winPct: number;
}

export const JOURNAL_STORAGE_KEY = "crypto-journal-v1";
const MAX_TRADES = 400;
/** Re-booking an identical direction on the same market is suppressed for this many bars. */
const DEDUP_BARS = 24;
/** Bars a trade may run before it is closed at market. */
const EXPIRY_BARS = 200;

/** Virtual account — $10k paper capital. */
export const ACCOUNT_CAPITAL_USD = 10_000;
/** Risked per trade as a fraction of current equity (compounding, capped). */
export const RISK_PCT = 0.01;
const MAX_RISK_USD = 1_000;
const DEFAULT_RISK_USD = Math.round(ACCOUNT_CAPITAL_USD * RISK_PCT);

/**
 * Timeframes the journal trades: 5m or 15m, whichever carries the best
 * setup. 1m scalping is a separate mode the user enables later.
 */
export const TRADE_TIMEFRAMES: readonly Timeframe[] = ["5m", "15m"];

/**
 * Higher timeframe consulted for directional bias — never fight it.
 */
export const BIAS_TIMEFRAME: Timeframe = "1h";

/** Bar durations — used for sweep recency and session math. */
export function timeframeMs(tf: Timeframe): number {
  return TF_MS[tf];
}

/**
 * Session filter (UTC hours). Crypto flow concentrates in the EU/US overlap;
 * overnight chop is where 5m/15m scalps bleed. Entries allowed 06:00–21:59 UTC.
 */
export const ENTRY_SESSION_UTC: readonly [number, number] = [6, 22];

/**
 * Entry gate — session hours only. This is a paper-trading journal, so
 * there is deliberately NO daily-loss stop, loss-streak cooldown, or
 * correlated-direction cap: the journal keeps booking whatever the
 * engines qualify, and the per-(pair, strategy) slot in `registerSignal`
 * is the only concurrency limit. Returns WHY entries are blocked, or
 * undefined when the account may trade.
 */
export function entryBlockReason(
  trades: readonly TradeRecord[],
  now: number,
  direction?: Direction,
  sessionUtc: readonly [number, number] = ENTRY_SESSION_UTC,
): string | undefined {
  const hour = new Date(now).getUTCHours();
  if (hour < sessionUtc[0] || hour >= sessionUtc[1]) {
    return `outside ${sessionUtc[0]}:00–${sessionUtc[1]}:00 UTC session`;
  }
  return undefined;
}

/**
 * Minimum confluence score to book a trade — the pooled-confirmation
 * floor (≥3 confirmations) can produce a score as low as ~40, so the
 * journal's gate matches that floor rather than demanding an 80.
 */
export const MIN_ENTRY_SCORE = 40;

/**
 * Cost model — Binance spot taker fee (~0.1%) plus slippage buffer, charged
 * per side on each fill as a fraction of the fill price. Applied inside
 * `finish` so every exit path books net R, not the flattering gross number.
 */
export const COST_PER_SIDE = 0.0015;

/** SMA of true range over the last `period` closed bars — trailing math only. */
function atrOf(bars: readonly Candle[], period = 14): number | undefined {
  if (bars.length < period + 1) return undefined;
  const slice = bars.slice(-period - 1);
  let sum = 0;
  for (let i = 1; i < slice.length; i += 1) {
    sum += Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i - 1].close),
      Math.abs(slice[i].low - slice[i - 1].close),
    );
  }
  return sum / period;
}

/** USD the trade risked at booking (legacy rows predate stamping → default). */
function usdOf(t: TradeRecord): number {
  return t.riskUsd ?? DEFAULT_RISK_USD;
}

/** Realized equity = starting capital + every closed trade's realized R × its risked $. */
export function equityOf(trades: TradeRecord[]): number {
  let eq = ACCOUNT_CAPITAL_USD;
  for (const t of trades) {
    if (t.status === "closed" && t.realizedR !== undefined) {
      eq += t.realizedR * usdOf(t);
    }
  }
  return Math.round(eq * 100) / 100;
}

/** Risk for a new trade: 1% of current equity, min $1, capped. */
export function nextRiskUsd(trades: TradeRecord[]): number {
  return Math.min(MAX_RISK_USD, Math.max(1, Math.round(equityOf(trades) * RISK_PCT)));
}

export const TF_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "12h": 43_200_000,
  "1D": 86_400_000,
  "1W": 604_800_000,
  "1M": 2_592_000_000, // 30d approximation — dedup window only, not a clock
};

export function journalKey(venue: string, symbol: string, timeframe: Timeframe): string {
  return `${venue}|${symbol}|${timeframe}`;
}

export function tradeKey(t: Pick<TradeRecord, "venue" | "symbol" | "timeframe">): string {
  return journalKey(t.venue, t.symbol, t.timeframe);
}

export function tradeOutcome(t: TradeRecord): TradeOutcome | "open" {
  if (t.status !== "closed" || t.realizedR === undefined) return "open";
  if (t.realizedR > 0.01) return "win";
  if (t.realizedR < -0.01) return "loss";
  return "flat";
}

/**
 * Book a signal if it deserves a journal row. Returns the (possibly
 * unchanged) list — deduplicated so one persistent setup doesn't log a
 * fresh trade on every refresh.
 */
export function registerSignal(
  trades: TradeRecord[],
  params: {
    venue: string;
    symbol: string;
    timeframe: Timeframe;
    signal: TradeSignal;
    /** Open-time of the bar the signal was emitted on. */
    barTime: number;
    now: number;
    strategy?: string;
    /** Venue entry session in UTC hours — defaults to the crypto window. */
    sessionUtc?: readonly [number, number];
  },
): { trades: TradeRecord[]; added?: TradeRecord } {
  const { venue, symbol, timeframe, signal, barTime, now, strategy, sessionUtc } = params;
  if (
    signal.direction === "wait" ||
    signal.entry === undefined ||
    signal.stopLoss === undefined ||
    signal.targets.length === 0 ||
    signal.confidence < MIN_ENTRY_SCORE ||
    entryBlockReason(trades, now, signal.direction, sessionUtc) !== undefined
  ) {
    return { trades };
  }
  // One open trade per (PAIR, STRATEGY) — Victor's 1m scalp and the
  // Confluence 5m swing may each hold one position on the same pair at
  // once; pairs themselves are unlimited.
  const strat = strategy ?? "confluence";
  if (
    trades.some(
      (t) =>
        t.status === "open" &&
        t.venue === venue &&
        t.symbol === symbol &&
        (t.strategy ?? "confluence") === strat,
    )
  ) {
    return { trades };
  }
  const key = journalKey(venue, symbol, timeframe);
  const tfMs = TF_MS[timeframe];
  const lastSame = [...trades]
    .reverse()
    .find((t) => tradeKey(t) === key && t.direction === signal.direction);
  if (lastSame !== undefined && Math.abs(barTime - lastSame.entryBarTime) < DEDUP_BARS * tfMs) {
    return { trades }; // same setup still fresh — don't double-book it
  }
  const rec: TradeRecord = {
    id: `${key}|${barTime}|${Math.round(now)}`,
    venue,
    symbol,
    timeframe,
    direction: signal.direction,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    initialStopLoss: signal.stopLoss,
    targets: signal.targets.map((t) => ({ ...t })),
    confidence: signal.confidence,
    strategy,
    riskUsd: nextRiskUsd(trades),
    openedAt: now,
    entryBarTime: barTime,
    lastProcessedBarTime: barTime,
    barsHeld: 0,
    tp1Hit: false,
    status: "open",
  };
  return { trades: [...trades, rec].slice(-MAX_TRADES), added: rec };
}

/**
 * Multi-timeframe entry selection. Candidates are the same pair's signals
 * across timeframes; the journal books at most ONE — the best risk:reward,
 * confidence breaking ties — so a pair never carries stacked positions.
 */
export function registerBestSignal(
  trades: TradeRecord[],
  candidates: readonly {
    venue: string;
    symbol: string;
    timeframe: Timeframe;
    signal: TradeSignal;
    barTime: number;
    /** Situational bonus added to RR when ranking (e.g. fresh liquidity sweep). */
    edge?: number;
    strategy?: string;
    /** Venue entry session in UTC hours — defaults to the crypto window. */
    sessionUtc?: readonly [number, number];
  }[],
  now: number,
): { trades: TradeRecord[]; added?: TradeRecord } {
  if (candidates.length === 0) return { trades };
  const { venue, symbol } = candidates[0];
  // Same-pair only — callers group candidates per pair, but never rank a
  // foreign symbol into this pair's decision.
  const own = candidates.filter((c) => c.venue === venue && c.symbol === symbol);
  const best = [...own].sort(
    (a, b) =>
      (b.signal.riskReward ?? 0) + (b.edge ?? 0) -
        ((a.signal.riskReward ?? 0) + (a.edge ?? 0)) ||
      b.signal.confidence - a.signal.confidence,
  )[0];
  return registerSignal(trades, { ...best, now });
}

/**
 * Close one open position at a supplied mark — the trading-desk "flatten"
 * button. `mark` should be the latest price for the trade's timeframe; the
 * caller falls back to entry when no mark exists (scratch exit, R = 0).
 * TP1 banking still applies — a post-TP1 manual close blends like any exit.
 */
export function closePosition(
  t: TradeRecord,
  mark: Price | undefined,
  now: number,
): TradeRecord {
  if (t.status !== "open") return t;
  const risk = Math.abs(t.entry - t.initialStopLoss);
  const price = mark ?? t.entry;
  return finish(t, price, now, "manual", risk);
}

/** Flatten every open position — one mark lookup per trade. */
export function closeAllPositions(
  trades: TradeRecord[],
  markOf: (t: TradeRecord) => Price | undefined,
  now: number,
): TradeRecord[] {
  return trades.map((t) => (t.status === "open" ? closePosition(t, markOf(t), now) : t));
}

function finish(
  t: TradeRecord,
  exitPrice: Price,
  exitBarTime: number,
  reason: TradeExitReason,
  risk: number,
): TradeRecord {
  const sign = t.direction === "bullish" ? 1 : -1;
  const exitR = risk === 0 ? 0 : ((exitPrice - t.entry) * sign) / risk;
  const rr1 = t.targets[0] ? Math.abs(t.targets[0].price - t.entry) / risk : 0;
  // TP1 banked half the position: blend the booked half with the runner's exit.
  const grossR = t.tp1Hit ? 0.5 * rr1 + 0.5 * exitR : exitR;
  // Costs: the entry fill is always full size; exits pay per size closed
  // (half at TP1 + half at the final exit, or the whole position at once).
  const costPx =
    t.entry +
    (t.tp1Hit && t.targets[0] ? 0.5 * t.targets[0].price : 0) +
    (t.tp1Hit ? 0.5 : 1) * exitPrice;
  const costR = risk === 0 ? 0 : (costPx * COST_PER_SIDE) / risk;
  const realizedR = grossR - costR;
  return {
    ...t,
    status: "closed",
    exitPrice,
    exitTime: exitBarTime,
    exitReason: reason,
    realizedR: Math.round(realizedR * 100) / 100,
  };
}

/**
 * Advance one trade over newly closed bars. Only bars with
 * `time > entryBarTime` count — the signal bar itself is never an exit.
 * The caller must pass CLOSED bars only (slice the forming bar off first).
 * Idempotent: already-processed bars are skipped via lastProcessedBarTime.
 */
export function evaluateTrade(rec: TradeRecord, closedBars: Candle[]): TradeRecord {
  if (rec.status !== "open") return rec;
  const risk = Math.abs(rec.entry - rec.initialStopLoss);
  if (risk === 0) {
    return finish(rec, rec.entry, rec.entryBarTime, "expired", risk);
  }
  const t: TradeRecord = { ...rec };
  const tp1 = t.targets[0]?.price;
  const tp2 = t.targets[1]?.price;
  const bull = t.direction === "bullish";

  for (const bar of closedBars) {
    if (bar.time <= t.lastProcessedBarTime || bar.time <= t.entryBarTime) continue;
    t.lastProcessedBarTime = bar.time;
    t.barsHeld += 1;

    // Conservative ordering: the stop always loses ties against a target.
    const stopped = bull ? bar.low <= t.stopLoss : bar.high >= t.stopLoss;
    if (stopped) return finish(t, t.stopLoss, bar.time, "stop", risk);

    const hitTp2 = tp2 !== undefined && (bull ? bar.high >= tp2 : bar.low <= tp2);
    if (hitTp2) {
      t.tp1Hit = true; // price necessarily passed TP1
      return finish(t, tp2, bar.time, "target", risk);
    }
    const hitTp1 = tp1 !== undefined && (bull ? bar.high >= tp1 : bar.low <= tp1);
    if (hitTp1 && !t.tp1Hit) {
      t.tp1Hit = true;
      t.stopLoss = bull ? Math.max(t.stopLoss, t.entry) : Math.min(t.stopLoss, t.entry);
    }
    if (t.strategy === "victor") {
      // Scalp trail: ratchet the stop under the extreme of the candle
      // before the newest closed bar (the "2nd candle" counting the
      // newest) — tightens while price runs, never loosens.
      const post = closedBars.filter((b) => b.time > t.entryBarTime && b.time <= bar.time);
      const back = post[post.length - 2];
      if (back !== undefined) {
        t.stopLoss = bull ? Math.max(t.stopLoss, back.low) : Math.min(t.stopLoss, back.high);
      }
    // After TP1 the runner trails a chandelier stop — 3×ATR behind the
    // extreme close since entry. ATR adapts the width to each pair's
    // volatility (BTC vs a low-priced alt) where a fixed 1R could not;
    // when ATR isn't computable yet it falls back to 1R.
    } else if (t.tp1Hit) {
      const post = closedBars.filter((b) => b.time > t.entryBarTime && b.time <= bar.time);
      const atr = atrOf(post);
      const extreme = bull
        ? Math.max(...post.map((b) => b.close))
        : Math.min(...post.map((b) => b.close));
      const width = atr !== undefined ? 3 * atr : risk;
      const trail = bull ? extreme - width : extreme + width;
      t.stopLoss = bull ? Math.max(t.stopLoss, trail) : Math.min(t.stopLoss, trail);
    }
    if (t.barsHeld >= EXPIRY_BARS) {
      return finish(t, bar.close, bar.time, "expired", risk);
    }
  }
  return t;
}

/**
 * Signed price distance covered by a trade — "points captured" for a
 * closed trade, live points for an open one at `mark`. Positive in the
 * trade's favour regardless of side.
 */
export function pointsCaptured(t: TradeRecord, mark?: Price): number {
  const end = t.status === "closed" ? t.exitPrice : mark;
  if (end === undefined) return 0;
  return t.direction === "bullish" ? end - t.entry : t.entry - end;
}

/** Floating $ P&L of an open trade at a mark = unrealized R × $ risked. */
export function unrealizedUsd(t: TradeRecord, mark: Price): number {
  return Math.round(unrealizedR(t, mark) * usdOf(t) * 100) / 100;
}

/** Total floating $ P&L across open trades, keyed marks (tradeKey → price). */
export function floatingPnlUsd(
  trades: TradeRecord[],
  markOf: (t: TradeRecord) => Price | undefined,
): number {
  let sum = 0;
  for (const t of trades) {
    if (t.status !== "open") continue;
    const mark = markOf(t);
    if (mark !== undefined) sum += unrealizedUsd(t, mark);
  }
  return Math.round(sum * 100) / 100;
}

/** Unrealized R of an open trade at a mark price — net of the same costs
 * `finish` books, so the live readout shows what flattening now pays. */
export function unrealizedR(t: TradeRecord, mark: Price): number {
  const risk = Math.abs(t.entry - t.initialStopLoss);
  if (risk === 0) return 0;
  const sign = t.direction === "bullish" ? 1 : -1;
  const r = ((mark - t.entry) * sign) / risk;
  const rr1 = t.targets[0] ? Math.abs(t.targets[0].price - t.entry) / risk : 0;
  const gross = t.tp1Hit ? 0.5 * rr1 + 0.5 * r : r;
  const costPx =
    t.entry +
    (t.tp1Hit && t.targets[0] ? 0.5 * t.targets[0].price : 0) +
    (t.tp1Hit ? 0.5 : 1) * mark;
  return Math.round((gross - (costPx * COST_PER_SIDE) / risk) * 100) / 100;
}

/** Per-day win/loss rollup over closed trades, newest day first. */
export function dailyStats(trades: TradeRecord[], days = 14): DailyStats[] {
  const byDay = new Map<string, DailyStats>();
  for (const t of trades) {
    if (t.status !== "closed" || t.exitTime === undefined) continue;
    const d = new Date(t.exitTime);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
    let row = byDay.get(day);
    if (row === undefined) {
      row = { day, trades: 0, wins: 0, losses: 0, flats: 0, netR: 0, netUsd: 0, winPct: 0 };
      byDay.set(day, row);
    }
    row.trades += 1;
    const outcome = tradeOutcome(t);
    if (outcome === "win") row.wins += 1;
    else if (outcome === "loss") row.losses += 1;
    else row.flats += 1;
    row.netR = Math.round((row.netR + (t.realizedR ?? 0)) * 100) / 100;
    row.netUsd = Math.round((row.netUsd + (t.realizedR ?? 0) * usdOf(t)) * 100) / 100;
    const decided = row.wins + row.losses;
    row.winPct = decided === 0 ? 0 : Math.round((row.wins / decided) * 1000) / 10;
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, days);
}

export interface SymbolStats {
  venue: string;
  symbol: string;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  flats: number;
  netR: number;
  /** Net closed profit/loss in USD for this pair. */
  netUsd: number;
  winPct: number;
}

/**
 * Per-market rollup across all timeframes — answers "which pair is the
 * engine most consistent on?". Sorted: markets with resolved trades first
 * (by win%, netR tiebreak), then markets with only running trades.
 */
export function symbolStats(trades: TradeRecord[]): SymbolStats[] {
  const map = new Map<string, SymbolStats>();
  for (const t of trades) {
    const key = `${t.venue}|${t.symbol}`;
    let row = map.get(key);
    if (row === undefined) {
      row = {
        venue: t.venue,
        symbol: t.symbol,
        open: 0,
        closed: 0,
        wins: 0,
        losses: 0,
        flats: 0,
        netR: 0,
        netUsd: 0,
        winPct: 0,
      };
      map.set(key, row);
    }
    if (t.status === "open") {
      row.open += 1;
      continue;
    }
    row.closed += 1;
    const outcome = tradeOutcome(t);
    if (outcome === "win") row.wins += 1;
    else if (outcome === "loss") row.losses += 1;
    else row.flats += 1;
    row.netR = Math.round((row.netR + (t.realizedR ?? 0)) * 100) / 100;
    row.netUsd = Math.round((row.netUsd + (t.realizedR ?? 0) * usdOf(t)) * 100) / 100;
    const decided = row.wins + row.losses;
    row.winPct = decided === 0 ? 0 : Math.round((row.wins / decided) * 1000) / 10;
  }
  return [...map.values()].sort((a, b) => {
    const aRanked = a.closed > 0 ? 1 : 0;
    const bRanked = b.closed > 0 ? 1 : 0;
    if (aRanked !== bRanked) return bRanked - aRanked;
    if (a.winPct !== b.winPct) return b.winPct - a.winPct;
    return b.netR - a.netR;
  });
}

// ---------- persistence (localStorage — a local journal, not an account) ----------

function store(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is TradeRecord {
  if (typeof v !== "object" || v === null) return false;
  const t = v as TradeRecord;
  return (
    typeof t.id === "string" &&
    typeof t.entry === "number" &&
    typeof t.stopLoss === "number" &&
    typeof t.entryBarTime === "number" &&
    (t.status === "open" || t.status === "closed")
  );
}

export function loadTrades(): TradeRecord[] {
  const s = store();
  if (s === undefined) return [];
  try {
    const raw = s.getItem(JOURNAL_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord);
  } catch {
    return [];
  }
}

export function saveTrades(trades: TradeRecord[]): void {
  const s = store();
  if (s === undefined) return;
  try {
    s.setItem(JOURNAL_STORAGE_KEY, JSON.stringify(trades.slice(-MAX_TRADES)));
  } catch {
    // Quota errors are non-fatal — the journal degrades to in-memory only.
  }
}

export function clearTrades(): void {
  store()?.removeItem(JOURNAL_STORAGE_KEY);
}
