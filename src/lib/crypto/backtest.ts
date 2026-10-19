import type { Candle, Timeframe } from "@/lib/types";
import { analyzeCandles } from "./analysis";
import { analyzeTechnicals } from "./technicals";
import {
  entryBlockReason,
  evaluateTrade,
  registerSignal,
  type TradeRecord,
} from "./journal";

/**
 * Backtest harness — replays real candles bar-by-bar through the SAME
 * pipeline live trading uses: analyzeCandles → (optional) SMC gate →
 * registerSignal → evaluateTrade. No look-ahead: the bar a signal fires on
 * is never its own exit bar, entries sit at the signal bar's close, and
 * every journal gate (score, session, circuit breakers, one-position)
 * applies exactly as it does live.
 *
 * The report measures expectancy — the only honest answer to "does it
 * work?" Win rate alone means nothing without the payoff behind it.
 */

export interface BacktestOptions {
  venue?: string;
  symbol?: string;
  timeframe?: Timeframe;
  /** Analysis window in bars; must be ≥ analyzeCandles' minimum (60). */
  window?: number;
  /** Apply the ICT/SMC structure gate used by the live scan. */
  smc?: boolean;
}

export interface BacktestStats {
  /** Bars fed through the replay (after the warm-up window). */
  evaluatedBars: number;
  /** Closed trades in the sample. */
  trades: number;
  /** Trade still open when the data ran out. */
  openAtEnd: number;
  /** Setups the session/circuit-breaker gate refused. */
  blockedEntries: number;
  wins: number;
  losses: number;
  /** Trades closed ~breakeven (|R| ≤ 0.01) — counted separately from wins. */
  scratches: number;
  /** wins / trades, 0–100. */
  winPct: number;
  /** Sum of realizedR across closed trades. */
  netR: number;
  /** netR / trades — expected R per trade. */
  expectancyR: number;
  avgWinR: number;
  avgLossR: number;
  /** Gross wins ÷ gross losses; Infinity when there are no losses, 0 when no wins. */
  profitFactor: number;
  /** Deepest peak-to-trough dip of the running R equity curve. */
  maxDrawdownR: number;
  /** Tally of exit reasons — stop / target / expired. */
  exits: Record<string, number>;
}

export function backtestCandles(
  candles: Candle[],
  opts: BacktestOptions = {},
): BacktestStats {
  const window = Math.max(60, opts.window ?? 120);
  const venue = opts.venue ?? "backtest";
  const symbol = opts.symbol ?? "BTTEST";
  const timeframe = opts.timeframe ?? "15m";
  const smc = opts.smc === true;

  let trades: TradeRecord[] = [];
  let blockedEntries = 0;
  let evaluatedBars = 0;

  for (let i = window; i < candles.length; i += 1) {
    const bar = candles[i];
    const hist = candles.slice(Math.max(0, i + 1 - window), i + 1);
    evaluatedBars += 1;

    // 1. Manage open positions on this closed bar first — exits never
    //    compete with an entry on the same bar.
    trades = trades.map((t) => evaluateTrade(t, [bar]));
    if (trades.some((t) => t.status === "open")) continue;

    // 2. Ask the engine.
    const a = analyzeCandles(hist);
    if (a === undefined || a.signal.direction === "wait") continue;

    // 3. Same SMC veto the live scan applies.
    if (smc) {
      const tech = analyzeTechnicals(hist, symbol, timeframe);
      const dir = a.signal.direction;
      if (
        tech !== undefined &&
        (tech.trend === "range" ||
          (dir === "bullish" && tech.trend === "downtrend") ||
          (dir === "bearish" && tech.trend === "uptrend"))
      ) {
        blockedEntries += 1;
        continue;
      }
    }

    // 4. Session + circuit breakers — same gate live uses.
    if (entryBlockReason(trades, bar.time) !== undefined) {
      blockedEntries += 1;
      continue;
    }

    // 5. Book it — entry = the signal bar's close, management starts next bar.
    trades = registerSignal(trades, {
      venue,
      symbol,
      timeframe,
      signal: a.signal,
      barTime: bar.time,
      now: bar.time,
    }).trades;
  }

  const closed = trades.filter((t) => t.status === "closed" && t.realizedR !== undefined);
  const wins = closed.filter((t) => t.realizedR! > 0.01);
  const losses = closed.filter((t) => t.realizedR! < -0.01);
  const scratches = closed.length - wins.length - losses.length;

  const grossWin = wins.reduce((s, t) => s + t.realizedR!, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.realizedR!, 0));
  const netR = Math.round(closed.reduce((s, t) => s + t.realizedR!, 0) * 100) / 100;

  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of [...closed].sort((a, b) => a.exitTime! - b.exitTime!)) {
    equity += t.realizedR!;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }

  const exits: Record<string, number> = {};
  for (const t of closed) {
    const k = t.exitReason ?? "unknown";
    exits[k] = (exits[k] ?? 0) + 1;
  }

  return {
    evaluatedBars,
    trades: closed.length,
    openAtEnd: trades.filter((t) => t.status === "open").length,
    blockedEntries,
    wins: wins.length,
    losses: losses.length,
    scratches,
    winPct: closed.length === 0 ? 0 : Math.round((wins.length / closed.length) * 1000) / 10,
    netR,
    expectancyR: closed.length === 0 ? 0 : Math.round((netR / closed.length) * 100) / 100,
    avgWinR: wins.length === 0 ? 0 : Math.round((grossWin / wins.length) * 100) / 100,
    avgLossR: losses.length === 0 ? 0 : Math.round((grossLoss / losses.length) * 100) / 100,
    profitFactor:
      grossLoss === 0
        ? grossWin > 0
          ? Infinity
          : 0
        : Math.round((grossWin / grossLoss) * 100) / 100,
    maxDrawdownR: Math.round(maxDD * 100) / 100,
    exits,
  };
}
