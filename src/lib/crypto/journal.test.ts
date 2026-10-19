import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import type { TradeSignal } from "./analysis";
import {
  dailyStats,
  evaluateTrade,
  journalKey,
  registerSignal,
  tradeKey,
  tradeOutcome,
  unrealizedR,
  type TradeRecord,
} from "./journal";

/**
 * Deterministic journal tests — synthetic bars only. The trade under test
 * is always a long: entry 100, initial stop 95 (risk 5), TP1 107.5, TP2 112.5.
 */
function candle(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

const BAR = 60_000;
/** 5m bar spacing — matches the timeframe used by reg(). */
const TF_BAR = 300_000;
const T0 = 1_000_000;

function signal(direction: "bullish" | "bearish" = "bullish"): TradeSignal {
  return direction === "bullish"
    ? {
        direction,
        confidence: 100,
        factors: [],
        reasons: [],
        entry: 100,
        stopLoss: 95,
        targets: [
          { label: "TP1", price: 107.5, rr: 1.5 },
          { label: "TP2", price: 112.5, rr: 2.5 },
        ],
        riskReward: 1.5,
      }
    : {
        direction,
        confidence: 100,
        factors: [],
        reasons: [],
        entry: 100,
        stopLoss: 105,
        targets: [
          { label: "TP1", price: 92.5, rr: 1.5 },
          { label: "TP2", price: 87.5, rr: 2.5 },
        ],
        riskReward: 1.5,
      };
}

function reg(
  trades: TradeRecord[],
  overrides: Partial<Parameters<typeof registerSignal>[1]> = {},
) {
  return registerSignal(trades, {
    venue: "binance",
    symbol: "BTCUSDT",
    timeframe: "5m",
    signal: signal(),
    barTime: T0,
    now: T0,
    ...overrides,
  });
}

describe("registerSignal — booking and dedup", () => {
  it("books a tradeable signal", () => {
    const { trades, added } = reg([]);
    expect(added).toBeDefined();
    expect(trades.length).toBe(1);
    expect(added!.status).toBe("open");
    expect(tradeKey(added!)).toBe(journalKey("binance", "BTCUSDT", "5m"));
  });

  it("ignores wait signals", () => {
    const { trades } = reg([], { signal: { ...signal(), direction: "wait", entry: undefined } });
    expect(trades.length).toBe(0);
  });

  it("refuses a second position while one is open on the same market", () => {
    const { trades: t1 } = reg([]);
    const { trades: t2, added } = reg(t1, { barTime: T0 + 50 * BAR });
    expect(added).toBeUndefined();
    expect(t2.length).toBe(1);
  });

  it("suppresses re-booking the same direction within the dedup window", () => {
    const { trades: t1 } = reg([]);
    const closed = t1.map((t) => ({ ...t, status: "closed" as const }));
    const { added } = reg(closed, { barTime: T0 + 10 * TF_BAR }); // 10 bars < 24
    expect(added).toBeUndefined();
  });

  it("re-books after the dedup window has passed", () => {
    const { trades: t1 } = reg([]);
    const closed = t1.map((t) => ({ ...t, status: "closed" as const }));
    const { added } = reg(closed, { barTime: T0 + 30 * TF_BAR }); // 30 bars > 24
    expect(added).toBeDefined();
  });

  it("allows the opposite direction immediately", () => {
    const { trades: t1 } = reg([]);
    const closed = t1.map((t) => ({ ...t, status: "closed" as const }));
    const { added } = reg(closed, { signal: signal("bearish"), barTime: T0 + TF_BAR });
    expect(added).toBeDefined();
    expect(added!.direction).toBe("bearish");
  });
});

describe("evaluateTrade — trade management on closed bars", () => {
  function open(): TradeRecord {
    return reg([]).added!;
  }

  it("exits at the stop when it trades — stop wins ties against a target", () => {
    // Bar touches SL (95) and TP1 (107.5) in the same bar — conservative: stopped.
    const t = evaluateTrade(open(), [candle(T0 + BAR, 100, 108, 94, 100)]);
    expect(t.status).toBe("closed");
    expect(t.exitReason).toBe("stop");
    expect(t.exitPrice).toBe(95);
    expect(t.realizedR).toBe(-1);
    expect(tradeOutcome(t)).toBe("loss");
  });

  it("banks TP1 and tightens the stop past breakeven", () => {
    const t = evaluateTrade(open(), [candle(T0 + BAR, 100, 108, 99, 107)]);
    expect(t.status).toBe("open");
    expect(t.tp1Hit).toBe(true);
    // Breakeven (100) then trail to close−1R: 107−5 = 102 — tighter wins.
    expect(t.stopLoss).toBe(102);
  });

  it("trails the stop 1R behind the close after TP1", () => {
    let t = evaluateTrade(open(), [candle(T0 + BAR, 100, 108, 99, 107)]); // TP1 → BE
    t = evaluateTrade(t, [candle(T0 + 2 * BAR, 107, 110, 106, 109)]); // trail: 109-5=104
    expect(t.stopLoss).toBe(104);
    expect(t.status).toBe("open");
  });

  it("a trailed stop after TP1 still books a win", () => {
    let t = evaluateTrade(open(), [candle(T0 + BAR, 100, 108, 99, 107)]); // SL 102
    t = evaluateTrade(t, [candle(T0 + 2 * BAR, 107, 107, 99.5, 100.5)]); // dips through it
    expect(t.status).toBe("closed");
    expect(t.exitReason).toBe("stop");
    expect(t.exitPrice).toBe(102);
    // Half banked at 1.5R + half at +0.4R = 0.75 + 0.2 = 0.95R → win.
    expect(t.realizedR).toBe(0.95);
    expect(tradeOutcome(t)).toBe("win");
  });

  it("closes at TP2 and counts the full runner", () => {
    const t = evaluateTrade(open(), [candle(T0 + BAR, 100, 113, 99, 112)]);
    expect(t.status).toBe("closed");
    expect(t.exitReason).toBe("target");
    expect(t.exitPrice).toBe(112.5);
    // 0.5×1.5R + 0.5×2.5R = 2R
    expect(t.realizedR).toBe(2);
    expect(tradeOutcome(t)).toBe("win");
  });

  it("mirrors management for shorts", () => {
    const { added } = reg([], { signal: signal("bearish") });
    // High stays below the 105 stop; low tags the 92.5 TP1.
    const t = evaluateTrade(added!, [candle(T0 + BAR, 100, 103, 92, 93)]);
    expect(t.tp1Hit).toBe(true);
    // Breakeven (100) then trail to close+1R: 93+5 = 98 — tighter wins.
    expect(t.stopLoss).toBe(98);
  });

  it("ignores the entry bar and bars already processed", () => {
    const t = evaluateTrade(open(), [
      candle(T0, 98, 99, 94, 98.5), // entry bar — would stop, must be skipped
      candle(T0 - BAR, 96, 97, 94, 95), // before entry — skipped
    ]);
    expect(t.status).toBe("open");
    expect(t.barsHeld).toBe(0);
  });

  it("expires a flat trade at market after the bar cap", () => {
    const bars: Candle[] = [];
    for (let i = 1; i <= 201; i += 1) {
      bars.push(candle(T0 + i * BAR, 100, 101, 99, 100));
    }
    const t = evaluateTrade(open(), bars);
    expect(t.status).toBe("closed");
    expect(t.exitReason).toBe("expired");
    expect(tradeOutcome(t)).toBe("flat");
  });

  it("reports unrealized R at a mark — blended after TP1", () => {
    const t0 = open();
    expect(unrealizedR(t0, 105)).toBe(1); // 105 = +1R
    const t1 = evaluateTrade(t0, [candle(T0 + BAR, 100, 108, 99, 107)]);
    // TP1 banked: 0.5×1.5 + 0.5×(110-100)/5 = 0.75 + 1 = 1.75
    expect(unrealizedR(t1, 110)).toBe(1.75);
  });
});

describe("dailyStats — the win/loss record", () => {
  const DAY = 86_400_000;

  function closed(realizedR: number, exitTime: number): TradeRecord {
    return {
      ...reg([]).added!,
      status: "closed",
      exitReason: realizedR > 0 ? "target" : "stop",
      exitPrice: 100,
      exitTime,
      realizedR,
    };
  }

  it("groups by local day with win percentage", () => {
    const day1 = new Date(2026, 9, 19, 10).getTime();
    const day2 = day1 + DAY;
    const stats = dailyStats([
      closed(1.5, day1),
      closed(-1, day1),
      closed(2, day2),
    ]);
    expect(stats.length).toBe(2);
    const [d2, d1] = stats; // newest first
    expect(d1.trades).toBe(2);
    expect(d1.wins).toBe(1);
    expect(d1.losses).toBe(1);
    expect(d1.winPct).toBe(50);
    expect(d1.netR).toBe(0.5);
    expect(d2.trades).toBe(1);
    expect(d2.winPct).toBe(100);
    expect(d2.netR).toBe(2);
  });

  it("ignores open trades", () => {
    expect(dailyStats([reg([]).added!]).length).toBe(0);
  });
});
