/**
 * Spec 32 — MTF Confirmation Gate (docs/engine/32-mtf-confirmation-gate.md).
 *
 * Enforces spec-10's canonical rule: a developing→confirmed transition requires
 * direction-signed `alignmentScore >= 0.8`, evaluated per bar, only when
 * `snap.alignment` is composed. Detector-level fixtures inject score-controlled
 * alignment (the only way to hit exact-boundary values); an integration test runs
 * the full backtest pipeline to prove non-latching + spec-31 causality.
 *
 * Reason ids: C9 (reversal) is the activation trigger and B8 (breakout) the
 * opposing-CHOCH guard — both taken — so the gate reasons are C10 / B9 / N8.
 */
import { describe, expect, it, vi } from "vitest";

// Each test runs full spec-26 engine pipelines — several seconds per case is normal.
// Scoped file-level timeout; the 5s default flakes under parallel worker contention.
vi.setConfig({ testTimeout: 30_000 });
import type {
  Bias,
  Candle,
  CandleSeries,
  Direction,
  EngineConfig,
  Imbalance,
  LiquidityPool,
  MarketStructure,
  Momentum,
  MtfVote,
  MultiTimeframeAlignment,
  StructureBreak,
  Zone,
  BacktestCell,
} from "@/lib/types";
import { detectReversals, type ReversalInput } from "../reversal";
import { detectBreakouts, type BreakoutInput } from "../breakout";
import { detectContinuations, type ContinuationInput } from "../continuation";
import { runBacktest } from "../backtest";
import { FIXTURE_EPOCH as E } from "@/lib/market-data";
import type { SwingPoint, SwingType } from "@/lib/types";

const H1 = 3_600_000;
const M15 = 900_000;
const ISO = (i: number) => new Date(E + i * H1).toISOString();

/** Score-controlled alignment — `votes`/`state` describe the frame snapshot; the
 *  gate reads only `alignmentScore` (direction-signed). */
const align = (
  state: MultiTimeframeAlignment["state"],
  score: number,
  votes: { htf: MtfVote; itf: MtfVote; etf: MtfVote } = { htf: 1, itf: 1, etf: 1 },
): MultiTimeframeAlignment => ({
  symbol: "T",
  timeframes: { htf: "4h", itf: "1h", etf: "15m" },
  votes, alignmentScore: score, state, computedAt: ISO(0),
});

const seq = (evts: { refId: string; atBar: number; metadata?: Record<string, unknown> }[], id: string) =>
  evts.filter((e) => e.refId === id).map((e) => `${e.atBar}:${String((e.metadata as { to?: string })?.to)}`);

// ===========================================================================
// Reversal fixtures (mirrors reversal.test.ts BULL textbook lifecycle)
// ===========================================================================
const RC = (o: number, h: number, l: number, cl: number, i: number): Candle => ({
  time: E + i * H1, open: o, high: h, low: l, close: cl,
});
const R_FLAT = [0, 1, 2, 3, 4].map((i) => RC(105, 105.5, 104.5, 105, i));
const R_BULL: Candle[] = [
  ...R_FLAT,
  RC(105, 105.4, 100.8, 101.5, 5),
  RC(101.5, 101.6, 98.5, 100.2, 6),
  RC(100.2, 101.8, 99.9, 101.6, 7),
  RC(101.6, 103.4, 101.4, 103.2, 8),
  RC(103.2, 103.5, 102.4, 103.0, 9),
  RC(103.0, 103.2, 99.5, 100.3, 10),
  RC(100.3, 102.4, 100.1, 102.2, 11),
  RC(102.2, 104.8, 102.0, 104.4, 12),
  RC(104.4, 104.6, 103.0, 103.6, 13),
  RC(103.6, 106.5, 103.4, 106.2, 14),
  RC(106.2, 106.4, 105.0, 105.6, 15),
  RC(105.6, 110.5, 105.4, 110.1, 16),
  RC(110.1, 110.6, 109.6, 110.2, 17),
  RC(110.2, 110.4, 109.8, 110.0, 18),
];
const rDemand = (): Zone => ({
  id: "z:dem:0", symbol: "T", timeframe: "1h", type: "demand",
  upperPrice: 101, lowerPrice: 99, strength: 70, freshness: "fresh", retestCount: 0,
  status: "active", originAt: ISO(0), createdAt: ISO(0),
});
const rSupply = (): Zone => ({
  id: "z:sup:0", symbol: "T", timeframe: "1h", type: "supply",
  upperPrice: 108, lowerPrice: 106, strength: 70, freshness: "fresh", retestCount: 0,
  status: "active", originAt: ISO(0), createdAt: ISO(0),
});
const rSellPool = (): LiquidityPool => ({
  id: "p:sell:1", symbol: "T", timeframe: "1h", side: "sell_side", sources: ["swing_low"],
  price: 99.5, touches: 2, strength: 60, status: "swept",
  formedAt: ISO(2), lastTouchedAt: ISO(2), sweptAt: ISO(6),
  metadata: { sweepConfirmedBar: 6, sweepConfirmedAt: ISO(6) },
});
const rBuyPool = (): LiquidityPool => ({
  id: "p:buy:1", symbol: "T", timeframe: "1h", side: "buy_side", sources: ["swing_high"],
  price: 104.5, touches: 2, strength: 60, status: "resting", formedAt: ISO(2), lastTouchedAt: ISO(2),
});
const rChoch = (dir: Direction, atBar: number): StructureBreak => ({
  id: `brk:${dir}:${atBar}`, type: "CHOCH", direction: dir, price: 103, time: ISO(atBar),
  confirmed: true, refPrice: 103, breakIndex: atBar,
});
const rStruct = (breaks: StructureBreak[]): MarketStructure => ({
  symbol: "T", timeframe: "1h", trend: "range", bias: "neutral", swings: [], breaks,
  keyLevels: [{ label: "HH", price: 110 }], updatedAt: ISO(18),
});
const rMom = (bias: Bias, disp?: number): Momentum => ({ state: "neutral", bias, displacementScore: disp });
const rFvg = (): Imbalance => ({
  id: "fvg:T:1h:bull:7", symbol: "T", timeframe: "1h", direction: "bullish",
  upperPrice: 101.8, lowerPrice: 101.6, status: "open", createdAt: ISO(7),
});
const R_CFG = {
  lifecycle: { expiryBars: 30, invalidateAtr: 0.1 },
  reversal: { zoneMaxAgeBars: 500, zoneMinStrength: 50, sweepMaxAgeBars: 10, dispMinScore: 60, entryZoneDepth: 0.5, invalidateAtr: 0.1 },
} as unknown as Parameters<typeof detectReversals>[0]["config"];
/** `mtfAt` receives the bar index → alignment for that bar (or undefined). */
const rAt = (mtfAt: (i: number) => MultiTimeframeAlignment | undefined) =>
  (idx: number): ReversalInput => ({
    zones: [rDemand(), rSupply()],
    pools: [rSellPool(), rBuyPool()],
    structure: rStruct(idx >= 8 ? [rChoch("bullish", 8)] : []),
    momentum: idx >= 7 ? rMom("bullish", 75) : rMom("neutral"),
    imbalances: idx >= 7 ? [rFvg()] : [],
    alignment: mtfAt(idx),
  });
const rRun = (candles: Candle[], at: (i: number) => ReversalInput | null) =>
  detectReversals({ candles, symbol: "T", timeframe: "1h", at, config: R_CFG });

// ===========================================================================
// Breakout fixtures (mirrors breakout.test.ts)
// ===========================================================================
const BC = (o: number, h: number, l: number, cl: number, i: number): Candle => ({
  time: E + i * H1, open: o, high: h, low: l, close: cl, volume: 100,
});
const B_BULL: Candle[] = [
  ...[0, 1, 2, 3, 4].map((i) => BC(101, 102.1, 99.9, 101.5, i)),
  ...[5, 6, 7, 8, 9].map((i) => BC(101, 101.5, 100.5, 101, i)),
  BC(101, 103.2, 100.9, 102.8, 10),  // attempt
  BC(102.8, 103.6, 102.6, 103.4, 11),
  BC(103.4, 103.9, 103.0, 103.7, 12),
  BC(103.7, 104.1, 103.3, 103.9, 13), // acceptance
  BC(103.9, 104.8, 103.6, 104.5, 14),
  BC(104.5, 104.9, 104.0, 104.4, 15),
  BC(104.4, 106.6, 104.2, 106.3, 16),
];
const bHiPool = (): LiquidityPool => ({
  id: "p:rh:0", symbol: "T", timeframe: "1h", side: "buy_side", sources: ["range_high"],
  price: 102.1, touches: 2, strength: 60, status: "resting", formedAt: ISO(0), lastTouchedAt: ISO(0),
});
const bLoPool = (): LiquidityPool => ({
  id: "p:rl:0", symbol: "T", timeframe: "1h", side: "sell_side", sources: ["range_low"],
  price: 99.9, touches: 2, strength: 60, status: "resting", formedAt: ISO(0), lastTouchedAt: ISO(0),
});
const bT2Pool = (): LiquidityPool => ({
  id: "p:buy:2", symbol: "T", timeframe: "1h", side: "buy_side", sources: ["swing_high"],
  price: 106, touches: 2, strength: 60, status: "resting", formedAt: ISO(0), lastTouchedAt: ISO(0),
});
const bT2Zone = (): Zone => ({
  id: "z:sup:9", symbol: "T", timeframe: "1h", type: "supply",
  upperPrice: 109, lowerPrice: 108, strength: 70, freshness: "fresh", retestCount: 0,
  status: "active", originAt: ISO(0), createdAt: ISO(0),
});
const bStruct = (): MarketStructure => ({
  symbol: "T", timeframe: "1h", trend: "range", bias: "neutral", swings: [], breaks: [], keyLevels: [], updatedAt: ISO(16),
});
const bMom = (bias: Bias, disp?: number): Momentum => ({ state: "neutral", bias, displacementScore: disp });
const B_CFG = {
  lifecycle: { expiryBars: 30, invalidateAtr: 0.1 },
  breakout: {
    rangeMinBars: 10, rangeMaxWidthAtr: 3, compressionRatio: 0.7, compressionBars: 5,
    breakAtr: 0.15, dispMinScore: 60, dispBars: 3, holdBars: 3, retestWindow: 8,
    volumeMinRatio: 1.3, anchorNearAtr: 1,
  },
} as unknown as Parameters<typeof detectBreakouts>[0]["config"];
const bAt = (mtfAt: (i: number) => MultiTimeframeAlignment | undefined) =>
  (idx: number): BreakoutInput => ({
    structure: bStruct(),
    momentum: idx >= 10 ? bMom("bullish", 75) : bMom("neutral"),
    pools: [bHiPool(), bLoPool(), bT2Pool()],
    zones: [bT2Zone()],
    alignment: mtfAt(idx),
    events: [],
  });
const bRun = (candles: Candle[], at: (i: number) => BreakoutInput | null) =>
  detectBreakouts({ candles, symbol: "T", timeframe: "1h", at, config: B_CFG });
const bBull = (o: ReturnType<typeof bRun>) => o.setups.find((s) => s.direction === "bullish");

// ===========================================================================
// Continuation fixtures (mirrors continuation.test.ts BULL textbook lifecycle)
// ===========================================================================
const CC = (o: number, h: number, l: number, cl: number, i: number): Candle => ({
  time: E + i * H1, open: o, high: h, low: l, close: cl, volume: 1000,
});
const N_BULL: Candle[] = [
  CC(99, 100.5, 98.5, 100, 0), CC(100, 102.5, 99.5, 102, 1), CC(102, 103.5, 101.5, 103, 2),
  CC(103, 105, 102.5, 104.5, 3), CC(104.5, 106, 104, 105.5, 4), CC(105.5, 108, 105, 107.5, 5),
  CC(107.5, 110.3, 107, 110, 6), CC(110, 110.2, 108.2, 109, 7), CC(109, 109.2, 106.8, 107.5, 8),
  CC(107.5, 107.8, 106.0, 106.4, 9), CC(106.4, 107.8, 106.2, 107.7, 10),
  CC(107.7, 108.0, 107.4, 107.8, 11), CC(107.8, 108.0, 106.5, 106.8, 12),
  CC(106.8, 110.5, 106.6, 110.2, 13), CC(110.2, 111, 110, 110.5, 14),
  CC(110.5, 116.5, 110.3, 116.2, 15),
];
const cSw = (id: string, kind: SwingPoint["kind"], price: number, pivot: number, cls: SwingType, conf: number): SwingPoint => ({
  id, kind, price, pivotIndex: pivot, pivotAt: ISO(pivot), classification: cls,
  status: "confirmed", confirmedIndex: conf, confirmedAt: ISO(conf),
});
const cBullSwings = (): SwingPoint[] => [
  cSw("sw:hh:0", "high", 98, 0, "HH", 1),
  cSw("sw:hl:2", "low", 100, 2, "HL", 4),
  cSw("sw:hh:6", "high", 110, 6, "HH", 8),
  cSw("sw:ph:9", "high", 107, 9, "LH", 11),
];
const cDZone = (): Zone => ({
  id: "z:d:1", symbol: "T", timeframe: "1h", type: "demand",
  upperPrice: 106.5, lowerPrice: 104.5, strength: 70, freshness: "fresh", retestCount: 0,
  status: "active", originAt: ISO(0), createdAt: ISO(0),
});
const cT3Pool = (): LiquidityPool => ({
  id: "p:t3:115", symbol: "T", timeframe: "1h", side: "buy_side", sources: ["swing_high"],
  price: 115, touches: 2, strength: 60, status: "resting", formedAt: ISO(0), lastTouchedAt: ISO(0),
});
const cStruct = (): MarketStructure => ({
  symbol: "T", timeframe: "1h", trend: "uptrend", bias: "neutral", swings: cBullSwings(), breaks: [], keyLevels: [], updatedAt: ISO(15),
});
const cMom = (bias: Bias, disp: number, state: Momentum["state"] = "neutral", dm?: number): Momentum => ({
  state, bias, displacementScore: disp, features: dm !== undefined ? { directionalMove: dm } : {},
});
const cBullMom = (i: number): Momentum =>
  i <= 6 ? cMom("bullish", 80, "neutral", 1)
    : i <= 9 ? cMom("bearish", 40, "neutral", -1)
    : cMom("bullish", 70, "strengthening", 1);
const N_CFG = {
  lifecycle: { expiryBars: 20, invalidateAtr: 0.1 },
  continuation: {
    minTrendSwings: 3,
    impulseMinAtr: 3,
    impulseMaxBars: 15,
    pullbackMinPct: 23.6,
    pullbackMaxPct: 78.6,
    pullbackMinBars: 3,
    recoveryBodyAtr: 0.5,
    confirmCloseAtr: 0.05,
  },
} as unknown as Parameters<typeof detectContinuations>[0]["config"];
const cAt = (mtfAt: (i: number) => MultiTimeframeAlignment | undefined) =>
  (idx: number): ContinuationInput => ({
    structure: cStruct(),
    momentum: cBullMom(idx),
    pools: [cT3Pool()],
    zones: [cDZone()],
    imbalances: [],
    alignment: mtfAt(idx),
  });
const cRun = (candles: Candle[], at: (i: number) => ContinuationInput | null) =>
  detectContinuations({ candles, symbol: "T", timeframe: "1h", at, config: N_CFG });
const cBull = (o: ReturnType<typeof cRun>) => o.setups.find((s) => s.direction === "bullish");

// ===========================================================================
describe("spec32 — reversal confirmation gate", () => {
  it("A: absent alignment preserves the exact spec-31 lifecycle (parity)", () => {
    const out = rRun(R_BULL, rAt(() => undefined));
    const s = out.setups[0];
    expect(seq(out.events, s.id)).toEqual([
      "5:developing", "8:confirmed", "10:active", "12:partial_target", "14:partial_target", "16:target_reached",
    ]);
    expect(s.reasons.some((r) => r.id === "C10")).toBe(false); // no gate reason unframed
  });

  it("score 0.4 / 0.6 → confirmation blocked, developing held, unmet C10 emitted", () => {
    // candles truncated at bar 11 — inside the sweep-fresh window so a blocked
    // setup remains developing rather than expiring on sweep_stale.
    for (const score of [0.4, 0.6]) {
      const out = rRun(R_BULL.slice(0, 12), rAt(() => align("aligned_bull", score)));
      const s = out.setups[0];
      expect(s.status).toBe("developing"); // never confirmed despite C1–C6 met
      expect(s.reasons.slice(0, 6).every((r) => r.met)).toBe(true); // required conditions DID pass
      const c10 = s.reasons.find((r) => r.id === "C10");
      expect(c10?.category).toBe("multi_timeframe");
      expect(c10?.met).toBe(false);
      expect(seq(out.events, s.id)).not.toContain("8:confirmed");
    }
  });

  it("exact boundary: 0.8 confirms; 0.799999 stays developing", () => {
    const at = rRun(R_BULL, rAt(() => align("aligned_bull", 0.8)));
    expect(seq(at.events, at.setups[0].id)).toContain("8:confirmed");
    const under = rRun(R_BULL.slice(0, 12), rAt(() => align("aligned_bull", 0.799999)));
    const s = under.setups[0];
    expect(s.status).toBe("developing");
    expect(s.reasons.find((r) => r.id === "C10")?.met).toBe(false);
    const over = rRun(R_BULL, rAt(() => align("aligned_bull", 0.800001)));
    expect(seq(over.events, over.setups[0].id)).toContain("8:confirmed");
  });

  it("D: gate is not latched — score rising past 0.8 releases the SAME setup", () => {
    // 0.6 until bar 11 → blocked at 8..10; 0.9 from bar 11 → confirms late.
    const out = rRun(R_BULL, rAt((i) => align("aligned_bull", i >= 11 ? 0.9 : 0.6)));
    const s = out.setups[0];
    const events = seq(out.events, s.id);
    expect(events).not.toContain("8:confirmed");
    expect(s.reasons.find((r) => r.id === "C10")?.met).toBe(true); // released
    expect(events).toContain("11:confirmed");
    expect(Number(s.metadata?.confirmBar)).toBe(11); // honest late anchor
  });

  it("E: existing veto semantics preserved — countertrend still cancels before confirm", () => {
    const out = rRun(R_BULL, rAt((i) => i >= 6 ? align("countertrend_bull", -0.4, { htf: -1, itf: -1, etf: -1 }) : align("aligned_bull", 1)));
    const s = out.setups[0];
    expect(s.status).toBe("cancelled");
    const evts = seq(out.events, s.id);
    expect(evts.some((e) => e.includes("cancelled"))).toBe(true);
    expect(evts).not.toContain("8:confirmed");
  });

  it("direction-signed: bearish score never confirms a bullish setup", () => {
    // aligned_bear signed for a bullish setup = -1.0 → gate blocks (veto handles cancel only on countertrend states)
    const out = rRun(R_BULL.slice(0, 12), rAt(() => align("aligned_bear", -1, { htf: -1, itf: -1, etf: -1 })));
    expect(out.setups[0].status).toBe("developing");
  });
});

// ===========================================================================
describe("spec32 — breakout confirmation gate", () => {
  it("B: absent alignment → parity (attempt+disp confirms)", () => {
    const out = bRun(B_BULL, bAt(() => undefined));
    const s = bBull(out)!;
    expect(seq(out.events, s.id)).toContain("10:confirmed");
    expect(s.reasons.some((r) => r.id === "B9")).toBe(false);
  });

  it("score <0.8 blocks; B9 unmet; same setup releases when score crosses 0.8", () => {
    const blocked = bRun(B_BULL, bAt(() => align("aligned_bull", 0.6)));
    const s = bBull(blocked)!;
    expect(seq(blocked.events, s.id)).not.toContain("10:confirmed");
    const b9 = s.reasons.find((r) => r.id === "B9");
    expect(b9?.category).toBe("multi_timeframe");

    // release within the disp window: 0.6 at attempt+1, 0.9 at attempt+2
    const rel = bRun(B_BULL, bAt((i) => align("aligned_bull", i >= 12 ? 0.9 : 0.6)));
    const rs = bBull(rel)!;
    const evts = seq(rel.events, rs.id);
    expect(evts).not.toContain("10:confirmed");
    expect(evts).toContain("12:confirmed");
    expect(rs.reasons.find((r) => r.id === "B9")?.met).toBe(true);
  });

  it("exact 0.8 confirms; fighting-HTF behavior unchanged (B7 owns it)", () => {
    const ok = bRun(B_BULL, bAt(() => align("aligned_bull", 0.8)));
    expect(seq(ok.events, bBull(ok)!.id)).toContain("10:confirmed");
    // htf fights (B7/fighting path) — gate-independent, must still block identically
    const fight = bRun(B_BULL, bAt(() => align("countertrend_bull", 0.5, { htf: -1, itf: 1, etf: 0 })));
    expect(seq(fight.events, bBull(fight)!.id)).not.toContain("10:confirmed");
  });
});

// ===========================================================================
describe("spec32 — continuation confirmation gate", () => {
  it("C: absent alignment → parity (quality_recovery_confirm at 11)", () => {
    const out = cRun(N_BULL, cAt(() => undefined));
    const s = cBull(out)!;
    expect(seq(out.events, s.id)).toContain("11:confirmed");
    expect(s.reasons.some((r) => r.id === "N8")).toBe(false);
  });

  it("score <0.8 blocks; N8 unmet; crossing 0.8 releases the same setup", () => {
    const blocked = cRun(N_BULL, cAt(() => align("aligned_bull", 0.6)));
    const s = cBull(blocked)!;
    expect(seq(blocked.events, s.id)).not.toContain("11:confirmed");
    const n8 = s.reasons.find((r) => r.id === "N8");
    expect(n8?.category).toBe("multi_timeframe");
    expect(n8?.met).toBe(false);

    // score rises at 12 but bar12's close is still below the confirm level (107) —
    // the gate releases the SAME setup which then confirms at the first valid bar.
    const rel = cRun(N_BULL, cAt((i) => align("aligned_bull", i >= 12 ? 0.85 : 0.6)));
    const rs = cBull(rel)!;
    const evts = seq(rel.events, rs.id);
    expect(evts).not.toContain("11:confirmed");
    expect(evts).toContain("13:confirmed");
  });

  it("exact 0.8 confirms", () => {
    const out = cRun(N_BULL, cAt(() => align("aligned_bull", 0.8)));
    expect(seq(out.events, cBull(out)!.id)).toContain("11:confirmed");
  });
});

// ===========================================================================
// Integration — full runBacktest pipeline (spec-31 frames → spec-32 gate)
// ===========================================================================
const IE = Date.UTC(2024, 0, 1);
const ibar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  time: IE + i * H1, open: o, high: h, low: l, close: c, volume: 1000,
});
const mk = (): Candle[] => {
  const cs: Candle[] = [];
  const a: [number, number][] = [
    [100, 101], [101, 102], [102, 103], [103, 104], [104, 102.6],
    [102.7, 103.5], [103.5, 104.5], [104.5, 105.5], [105.5, 107], [107, 105.6],
    [105.7, 106.5], [106.5, 107.5], [107.5, 108.5], [108.5, 110], [110, 108.6],
    [108.7, 109.5], [109.5, 110.5], [110.5, 111.5], [111.5, 112.5], [112.5, 113],
    [113, 111.8], [111.9, 112.4], [112.4, 113], [113, 113.5], [113.5, 112.6],
    [112.7, 113], [113, 113.8], [113.8, 114.3], [114.3, 113.9], [113.9, 114.2],
  ];
  a.forEach(([o, cl], i) => cs.push(ibar(i, o, Math.max(o, cl) + 0.4, Math.min(o, cl) - 0.3, cl)));
  const b: [number, number][] = [
    [111.9, 110.2], [110.2, 108.5], [108.5, 107], [107, 106], [106, 105.9], [105.9, 107.5],
    [106.2, 105.5], [105.5, 104.3], [104.3, 102.8], [102.8, 101.3],
    [101.3, 95.8], [95.9, 96.3], [96.3, 96.0], [97.4, 95.6], [95.8, 96.4], [96.4, 95.9],
  ];
  b.forEach(([o, cl], i) => {
    if (30 + i === 43) cs.push(ibar(43, o, Math.max(o, cl) + 0.3, 94.8, cl));
    else cs.push(ibar(30 + i, o, Math.max(o, cl) + 0.3, Math.min(o, cl) - 0.5, cl));
  });
  const d: [number, number][] = [
    [95.9, 96.8], [96.8, 99], [99, 101.5], [101.5, 104], [104, 106.5], [106.5, 109],
    [109, 111], [111, 112.8], [112.8, 113], [113, 112.7],
  ];
  d.forEach(([o, cl], i) => cs.push(ibar(46 + i, o, Math.max(o, cl) + 0.2, Math.min(o, cl) - 0.2, cl)));
  const e: [number, number][] = [
    [112.7, 113.4], [113.4, 114.2], [114.2, 115], [115, 115.8], [115.8, 116.5],
    [116.5, 117.2], [117.2, 118], [118, 118.6], [118.6, 119], [119, 119.3],
  ];
  e.forEach(([o, cl], i) => {
    if (56 + i === 56) cs.push(ibar(56, o, Math.max(o, cl) + 0.2, 96.0, cl));
    else cs.push(ibar(56 + i, o, Math.max(o, cl) + 0.2, Math.min(o, cl) - 0.2, cl));
  });
  return cs;
};

const ICFG: EngineConfig = {
  version: "v1",
  marketData: { maxMissingBarPct: 0 },
  swing: { leftBars: 1, rightBars: 1, atrLength: 5, minSignificanceAtr: 0.1, equalToleranceAtr: 0.15, mergeEqual: true },
  structure: { classifyToleranceAtr: 0.15, minBreakAtr: 0.05, failedBreakBars: 3, minSwingsForTrend: 2 },
  liquidity: {
    equalToleranceAtr: 0.2, clusterMinCount: 2, clusterWidthAtr: 0.3, poolExpiryBars: 500,
    sweep: { minPenetrationAtr: 0.05, maxReclaimBars: 4, displacementBars: 4, displacementBodyAtr: 0.4, displacementRangeAtr: 0.7 },
    break: { minCloseAtr: 0.2, holdBars: 2, retestWindow: 10 },
    range: { lookbackBars: 20 },
  },
  zone: {
    leg: { lookbackBars: 6, minMoveAtr: 0.5 },
    base: { minBars: 1, maxBars: 6, maxRangeAtr: 1.2, maxBodyAtr: 0.9 },
    departure: { minMoveAtr: 0.7, maxBars: 6, displacementBodyAtr: 0.4, displacementRangeAtr: 1.0 },
    retest: { depthMitigatedPct: 50, invalidateCloseAtr: 0.6, maxRetests: 4, retestDecay: 0.5, depthDecay: 0.3 },
    freshnessMaxBars: 400, boundaryMode: "extremes", gapInvalidates: false,
    weights: { departureStrength: 0.2, structureBreak: 0.15, liquidityInteraction: 0.15, freshness: 0.15, fvgAssociation: 0.1, htfConfluence: 0.1, volumeExpansion: 0.1, zoneWidth: 0.05 },
  },
  fvg: { minGapAtr: 0.05, minMidBodyAtr: 0.2, partialFillPct: 50, invalidateAtr: 0.5, expiryBars: 500, atrLength: 5 },
  momentum: {
    lookback: 10, atrLength: 5, trendShift: 5, vol: { fast: 3, slow: 8 },
    state: { strengthMoveAtr: 0.5, strengthBodyAtr: 0.5, weakenFactor: 0.6, biasMoveAtr: 0.3 },
    disp: { bars: 3, threshold: 50, weights: { body: 0.25, range: 0.2, close: 0.15, dir: 0.15, move: 0.15, vol: 0.05, struct: 0.05 } },
  },
  mtf: { set: { htf: "4h", itf: "1h", etf: "15m" }, weights: { htf: 0.5, itf: 0.3, etf: 0.2 } },
  lifecycle: { expiryBars: 200, invalidateAtr: 0.5 },
  reversal: { zoneMaxAgeBars: 300, zoneMinStrength: 0, sweepMaxAgeBars: 80, dispMinScore: 0, entryZoneDepth: 0.5, invalidateAtr: 0.5 },
  breakout: { rangeMinBars: 4, rangeMaxWidthAtr: 3, compressionRatio: 0.75, compressionBars: 4, breakAtr: 0.3, dispMinScore: 0, dispBars: 4, holdBars: 2, retestWindow: 10, volumeMinRatio: 0, anchorNearAtr: 0.8 },
  continuation: { minTrendSwings: 2, impulseMinAtr: 0.8, impulseMaxBars: 20, pullbackMinPct: 0.15, pullbackMaxPct: 0.95, pullbackMinBars: 2, recoveryBodyAtr: 0.3, confirmCloseAtr: 0.15 },
  scoring: { minRR: 0, weights: { structure: 20, liquidity: 15, zoneQuality: 15, displacement: 15, momentum: 15, htfAlignment: 10, freshness: 5, fvg: 5 }, regimeMatrix: {} },
  regime: { expandAtrTrend: 1.2, compressAtrTrend: 0.8, atrLength: 5, atrLookback: 10, minBars: 10 },
  scanner: { topK: 0, includeDeveloping: true, methodVersion: "v1-scan" },
  backtest: { methodVersion: "v1-bt" },
};

const iser = (tf: "4h" | "15m", candles: Candle[]): CandleSeries =>
  ({ symbol: "AA", timeframe: tf, candles }) as CandleSeries;
const icell = (frames?: BacktestCell["frames"]): BacktestCell => ({
  symbol: "AA", timeframe: "1h",
  series: { symbol: "AA", timeframe: "1h", candles: mk() } as CandleSeries,
  frames,
});

/** ETF: bullish drift, a bearish window covering cell bars 49–53 (20 15m bars
 *  closing E+49h45m..E+54h), then bullish drift resumes → vote recovers +1. */
const etfBlockedThenReleased = (): Candle[] => {
  const arr: Candle[] = [];
  const start = IE + 40 * H1;
  let i = 0;
  let px = 90;
  const push = (dir: 1 | -1, step = 0.55) => {
    const o = px; px += dir * step;
    arr.push({ time: start + i * M15, open: o, high: Math.max(o, px) + 0.05, low: Math.min(o, px) - 0.05, close: px, volume: 1000 });
    i += 1;
  };
  // Bullish drift through E+48h. The bear leg must NOT be visible at t≤48:
  // the real itf vote is still −1 there, and (h=+1, i=−1, e=−1) is countertrend_bear
  // — the existing veto would cancel the setup instead of letting the gate hold it.
  // Bear bars open E+48h30m..E+53h15m → the last closed bar ≤ E+50h is deep enough
  // in the leg for dm<0 at t=49 (i=+1 by then → pullback_in_trend_bull 0.6 → held).
  while (start + i * M15 < IE + 48 * H1 + 30 * 60000) push(1);
  for (let k = 0; k < 20; k++) push(-1, 0.8); // closes E+48h45m .. E+53h30m
  // bullish resumption — dm flips back after ~5-7 bars evict the bear leg
  for (let k = 0; k < 60; k++) push(1, 0.8);
  return arr;
};

const confirmBar = (d: { opportunities: { setupId: string; evaluatedIndex: number; status: string }[] }) =>
  Math.min(...d.opportunities.filter((o) => o.setupId.includes("bullish")).map((o) => o.evaluatedIndex));

describe("spec32 — integration through runBacktest", () => {
  const htfBull = (): CandleSeries =>
    iser("4h", Array.from({ length: 25 }, (_, i) => {
      const o = 90 + i * 0.5;
      return { time: IE + i * 4 * H1, open: o, high: o + 0.55, low: o - 0.05, close: o + 0.45, volume: 1000 };
    }));

  it("gate blocks developing→confirmed while signed score <0.8, then releases — unframed twin confirms earlier", () => {
    const un = runBacktest({ cells: [icell()], config: ICFG });
    const fr = runBacktest({ cells: [icell({ htf: htfBull(), etf: iser("15m", etfBlockedThenReleased()) })], config: ICFG });
    expect(un.ok && fr.ok).toBe(true);
    const unBar = confirmBar(un.data!);
    expect(unBar).toBe(49); // baseline: confirms at 49
    const frBar = confirmBar(fr.data!);
    // etf dips to −1 across t=49–53 → pullback_in_trend_bull (signed 0.6 <0.8) holds
    // the SAME setup developing; the bullish resumption lifts etf to +1 → releases at 54.
    expect(frBar).toBe(54);
    expect(frBar).toBeGreaterThan(unBar); // delayed by the gate — not cancelled
    // the setup was recorded developing on every blocked bar — never vanished
    const dev = fr.data!.developing.filter(
      (x) => x.setupId.includes("bullish") && x.evaluatedIndex >= unBar && x.evaluatedIndex < frBar);
    expect(dev.length).toBeGreaterThan(0);
    // and no bullish record confirms inside the blocked window
    expect(fr.data!.opportunities.every(
      (o) => !o.setupId.includes("bullish") || o.evaluatedIndex >= frBar)).toBe(true);
  });

  it("causality: a truncated horizon never sees the post-horizon release — blocked records carry unmet C10", () => {
    // Prefix run ending at t=53: the etf resumption (t≥54) is beyond the horizon.
    // The setup's FINAL state is still developing → per-bar unmet C10 is observable
    // (records snapshot the setup's reasons; on released setups they end all-met).
    const frames = () => ({ htf: htfBull(), etf: iser("15m", etfBlockedThenReleased()) });
    const pre = runBacktest({
      cells: [{ ...icell(frames()), series: { symbol: "AA", timeframe: "1h", candles: mk().slice(0, 54) } as CandleSeries }],
      config: ICFG,
    });
    expect(pre.ok).toBe(true);
    // no bullish confirmation within the horizon — the gate held on every bar
    expect(pre.data!.opportunities.filter((o) => o.setupId.includes("bullish"))).toHaveLength(0);
    const devB = pre.data!.developing.filter(
      (x) => x.setupId.includes("bullish") && x.evaluatedIndex >= 49);
    expect(devB.length).toBeGreaterThan(0);
    for (const b of devB) {
      const c10 = (b.reasons ?? []).find((r) => r.id === "C10");
      expect(c10?.met).toBe(false); // "what's missing" names the MTF gate honestly
      expect(c10?.category).toBe("multi_timeframe");
    }
    // and the full run confirms only after the horizon — nothing reaches backwards
    const full = runBacktest({ cells: [icell(frames())], config: ICFG });
    expect(confirmBar(full.data!)).toBe(54);
    expect(full.data!.opportunities.every(
      (o) => !o.setupId.includes("bullish") || o.evaluatedIndex >= 54)).toBe(true);
  });

  it("G: determinism — identical framed reruns", () => {
    const a = runBacktest({ cells: [icell({ htf: htfBull(), etf: iser("15m", etfBlockedThenReleased()) })], config: ICFG });
    const b = runBacktest({ cells: [icell({ htf: htfBull(), etf: iser("15m", etfBlockedThenReleased()) })], config: ICFG });
    expect(a.data).toEqual(b.data);
  });
});
