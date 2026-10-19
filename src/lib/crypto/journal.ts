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

export type TradeExitReason = "stop" | "target" | "expired";
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
  winPct: number;
}

export const JOURNAL_STORAGE_KEY = "crypto-journal-v1";
const MAX_TRADES = 400;
/** Re-booking an identical direction on the same market is suppressed for this many bars. */
const DEDUP_BARS = 24;
/** Bars a trade may run before it is closed at market. */
const EXPIRY_BARS = 200;

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
  },
): { trades: TradeRecord[]; added?: TradeRecord } {
  const { venue, symbol, timeframe, signal, barTime, now } = params;
  if (
    signal.direction === "wait" ||
    signal.entry === undefined ||
    signal.stopLoss === undefined ||
    signal.targets.length === 0
  ) {
    return { trades };
  }
  const key = journalKey(venue, symbol, timeframe);
  if (trades.some((t) => t.status === "open" && tradeKey(t) === key)) {
    return { trades }; // one position per market at a time
  }
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
    openedAt: now,
    entryBarTime: barTime,
    lastProcessedBarTime: barTime,
    barsHeld: 0,
    tp1Hit: false,
    status: "open",
  };
  return { trades: [...trades, rec].slice(-MAX_TRADES), added: rec };
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
  const realizedR = t.tp1Hit ? 0.5 * rr1 + 0.5 * exitR : exitR;
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
    // After TP1 the stop trails 1R behind the close — the "runner" legs.
    if (t.tp1Hit) {
      t.stopLoss = bull
        ? Math.max(t.stopLoss, bar.close - risk)
        : Math.min(t.stopLoss, bar.close + risk);
    }
    if (t.barsHeld >= EXPIRY_BARS) {
      return finish(t, bar.close, bar.time, "expired", risk);
    }
  }
  return t;
}

/** Unrealized R of an open trade at a mark price (live P&L readout). */
export function unrealizedR(t: TradeRecord, mark: Price): number {
  const risk = Math.abs(t.entry - t.initialStopLoss);
  if (risk === 0) return 0;
  const sign = t.direction === "bullish" ? 1 : -1;
  const r = ((mark - t.entry) * sign) / risk;
  const rr1 = t.targets[0] ? Math.abs(t.targets[0].price - t.entry) / risk : 0;
  return Math.round((t.tp1Hit ? 0.5 * rr1 + 0.5 * r : r) * 100) / 100;
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
      row = { day, trades: 0, wins: 0, losses: 0, flats: 0, netR: 0, winPct: 0 };
      byDay.set(day, row);
    }
    row.trades += 1;
    const outcome = tradeOutcome(t);
    if (outcome === "win") row.wins += 1;
    else if (outcome === "loss") row.losses += 1;
    else row.flats += 1;
    row.netR = Math.round((row.netR + (t.realizedR ?? 0)) * 100) / 100;
    const decided = row.wins + row.losses;
    row.winPct = decided === 0 ? 0 : Math.round((row.wins / decided) * 1000) / 10;
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, days);
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
