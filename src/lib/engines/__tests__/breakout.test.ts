import { describe, expect, it } from "vitest";
import type {
  Bias,
  Candle,
  DetectionEvent,
  LiquidityPool,
  MarketStructure,
  Metadata,
  Momentum,
  MtfVote,
  MultiTimeframeAlignment,
  Zone,
} from "@/lib/types";
import { createBreakoutSetupEngine, detectBreakouts, type BreakoutInput } from "../breakout";
import { FIXTURE_EPOCH as E } from "@/lib/market-data";

const H1 = 3_600_000;
const ISO = (i: number) => new Date(E + i * H1).toISOString();
const c = (o: number, h: number, l: number, cl: number, i: number, v?: number): Candle => ({
  time: E + i * H1, open: o, high: h, low: l, close: cl, volume: v,
});

const CFG = {
  lifecycle: { expiryBars: 30, invalidateAtr: 0.1 },
  breakout: {
    rangeMinBars: 10,
    rangeMaxWidthAtr: 3,
    compressionRatio: 0.7,
    compressionBars: 5,
    breakAtr: 0.15,
    dispMinScore: 60,
    holdBars: 3,
    retestWindow: 8,
    volumeMinRatio: 1.3,
  },
};

// ---- Bullish textbook fixture --------------------------------------------------
// bars 0-4 wide-ish (range 2.2), bars 5-9 tight (range 1.0) → compression ≈ 0.625.
// Resistance = 102.1, support = 99.9, height 2.2. bar10 closes beyond + displacement;
// bars 11-13 clean → acceptance; bar14 T1 (104.3); bar16 T2 (106 pool).
const RANGE_BARS: Candle[] = [
  ...[0, 1, 2, 3, 4].map((i) => c(101, 102.1, 99.9, 101.5, i)),
  ...[5, 6, 7, 8, 9].map((i) => c(101, 101.5, 100.5, 101, i)),
];
const BULL: Candle[] = [
  ...RANGE_BARS,
  c(101, 103.2, 100.9, 102.8, 10), // close 102.8 > 102.1 + 0.15×ATR — attempt; disp known → confirmed
  c(102.8, 103.6, 102.6, 103.4, 11),
  c(103.4, 103.9, 103.0, 103.7, 12),
  c(103.7, 104.1, 103.3, 103.9, 13), // 3 clean bars → acceptance → active
  c(103.9, 104.8, 103.6, 104.5, 14), // high ≥ 104.3 → T1 → partial_target
  c(104.5, 104.9, 104.0, 104.4, 15),
  c(104.4, 106.6, 104.2, 106.3, 16), // high ≥ 106 → T2 → target_reached
];

const hiPool = (meta?: Metadata): LiquidityPool => ({
  id: "p:rh:0", symbol: "T", timeframe: "1h", side: "buy_side", sources: ["range_high"],
  price: 102.1, touches: 2, strength: 60, status: "resting", formedAt: ISO(0), lastTouchedAt: ISO(0),
  metadata: meta,
});
const loPool = (meta?: Metadata): LiquidityPool => ({
  id: "p:rl:0", symbol: "T", timeframe: "1h", side: "sell_side", sources: ["range_low"],
  price: 99.9, touches: 2, strength: 60, status: "resting", formedAt: ISO(0), lastTouchedAt: ISO(0),
  metadata: meta,
});
const t2Pool = (): LiquidityPool => ({
  id: "p:buy:2", symbol: "T", timeframe: "1h", side: "buy_side", sources: ["swing_high"],
  price: 106, touches: 2, strength: 60, status: "resting", formedAt: ISO(0), lastTouchedAt: ISO(0),
});
const t2Zone = (): Zone => ({
  id: "z:sup:9", symbol: "T", timeframe: "1h", type: "supply",
  upperPrice: 109, lowerPrice: 108, strength: 70, freshness: "fresh", retestCount: 0,
  status: "active", originAt: ISO(0), createdAt: ISO(0),
});
const struct = (trend: MarketStructure["trend"] = "range", breaks: MarketStructure["breaks"] = []): MarketStructure => ({
  symbol: "T", timeframe: "1h", trend, bias: "neutral", swings: [], breaks, keyLevels: [], updatedAt: ISO(16),
});
const choch = (dir: "bullish" | "bearish", atBar: number) => ({
  id: `brk:${dir}:${atBar}`, type: "CHOCH" as const, direction: dir, price: 101, time: ISO(atBar),
  confirmed: true, refPrice: 101, breakIndex: atBar,
});
const mom = (bias: Bias, disp?: number): Momentum => ({ state: "neutral", bias, displacementScore: disp });
const align = (state: MultiTimeframeAlignment["state"], htfVote: MtfVote = 1): MultiTimeframeAlignment => ({
  symbol: "T",
  timeframes: { htf: "4h", itf: "1h", etf: "15m" },
  votes: { htf: htfVote, itf: 1, etf: 1 }, alignmentScore: 1, state, computedAt: ISO(16),
});

type Gate = Partial<{
  dispBar: number | false; // first bar with bullish displacement ≥ threshold (false = never)
  dir: "bullish" | "bearish";
  trend: MarketStructure["trend"];
  pools: LiquidityPool[];
  zones: Zone[];
  events: (i: number) => DetectionEvent[];
  mtf: MultiTimeframeAlignment | undefined;
  breaks: (i: number) => MarketStructure["breaks"];
}>;

function mkAt(g: Gate = {}) {
  return (idx: number): BreakoutInput => ({
    structure: struct(g.trend ?? "range", g.breaks ? g.breaks(idx) : []),
    momentum:
      g.dispBar !== false && idx >= (g.dispBar ?? 10) ? mom(g.dir ?? "bullish", 75) : mom("neutral"),
    pools: g.pools ?? [hiPool(), loPool(), t2Pool()],
    zones: g.zones ?? [t2Zone()],
    alignment: g.mtf,
    events: g.events ? g.events(idx) : [],
  });
}
const run = (candles: Candle[], at: (i: number) => BreakoutInput | null) =>
  detectBreakouts({ candles, symbol: "T", timeframe: "1h", at, config: CFG });
const bull = (out: ReturnType<typeof run>) => out.setups.find((s) => s.direction === "bullish");
const bear = (out: ReturnType<typeof run>) => out.setups.find((s) => s.direction === "bearish");

describe("breakout — bullish textbook lifecycle", () => {
  const out = run(BULL, mkAt());
  const s = bull(out)!;

  it("emits a developing pair once the range qualifies — never before", () => {
    const created = out.setups.map((x) => ({ dir: x.direction, at: x.createdAt }));
    expect(created).toEqual([ // sorted by id → bearish, then bullish
      { dir: "bearish", at: ISO(9) },
      { dir: "bullish", at: ISO(9) },
    ]);
    // no setup exists before bar 9 (first bar where len ≥ rangeMinBars + compression)
    expect(out.events.filter((e) => e.atBar < 9)).toHaveLength(0);
  });

  it("boundary pools anchor the setup; evidence chain is explainable", () => {
    expect(s.id).toBe("bo:T:1h:bullish:p:rh:0");
    expect(s.type).toBe("breakout");
    expect(s.liquidityEventIds).toEqual(["p:rh:0"]);
    expect(s.metadata?.anchorPoolId).toBe("p:rh:0");
    expect(s.metadata?.boundary).toBe(102.1);
    expect(s.metadata?.rangeHeight).toBeCloseTo(2.2, 10);
    expect(s.reasons.find((r) => r.id === "B4")?.met).toBe(true);
    expect(s.reasons.find((r) => r.id === "B5")?.met).toBe(true);
  });

  it("developing → confirmed(attempt+disp) → active(acceptance) → targets", () => {
    expect(s.status).toBe("target_reached");
    const seq = out.events.filter((e) => e.refId === s.id).map((e) => `${e.atBar}:${e.metadata?.to}`);
    expect(seq).toEqual(["9:developing", "10:confirmed", "13:active", "14:partial_target", "16:target_reached"]);
  });

  it("records entry band, invalidation and measured-move targets as evidence", () => {
    expect(Number(s.metadata?.entryBandHigh)).toBeCloseTo(102.1 + 0.25 * 1.0, 0);
    const tgts = (s.metadata?.targets as string).split(",").map(Number);
    expect(tgts[0]).toBeCloseTo(104.3, 6); // T1 measured move
    expect(tgts[1]).toBeCloseTo(106, 6); // T2 nearest opposing pool
  });

  it("the untaken side never confirms (bearish twin stays developing / expires)", () => {
    const b = bear(out)!;
    expect(["developing", "expired", "cancelled"]).toContain(b.status);
    expect(b.reasons.find((r) => r.id === "B4")?.met).toBe(false);
  });
});

describe("breakout — attempt vs confirmation", () => {
  it("wick-only penetration is nothing — no attempt, no confirmation", () => {
    const wick: Candle[] = [...RANGE_BARS, c(101, 104.5, 100.9, 101.8, 10)];
    const out = run(wick, mkAt());
    expect(bull(out)!.reasons.find((r) => r.id === "B4")?.met).toBe(false);
    // never confirmed — the wick also killed the compression → expired is the causal outcome
    expect(["developing", "expired"]).toContain(bull(out)!.status);
  });

  it("attempt without displacement expires unconfirmed", () => {
    const out = run(BULL.slice(0, 15), mkAt({ dispBar: false }));
    const s = bull(out)!;
    expect(s.status).toBe("expired");
    expect(out.events.filter((e) => e.refId === s.id).map((e) => e.metadata?.to))
      .toEqual(["developing", "expired"]);
    expect(s.reasons.find((r) => r.id === "B5")?.met).toBe(false);
  });

  it("wrong-direction displacement cannot confirm", () => {
    const out = run(BULL.slice(0, 15), mkAt({ dir: "bearish" }));
    expect(bull(out)!.status).toBe("expired");
  });

  it("retest-hold activates before holdBars elapse", () => {
    const retest: Candle[] = [
      ...RANGE_BARS,
      c(101, 103.2, 100.9, 102.8, 10),
      c(102.8, 102.9, 102.15, 102.6, 11), // dips into the band, closes out → retest_hold
      c(102.6, 103.5, 102.4, 103.3, 12),
    ];
    const out = run(retest, mkAt());
    const s = bull(out)!;
    expect(s.status).toBe("active");
    const ev = out.events.find((e) => e.refId === s.id && e.metadata?.to === "active");
    expect(ev?.metadata?.transitionReason).toBe("retest_hold");
    expect(ev?.atBar).toBe(11);
  });
});

describe("breakout — false breakout, sweep classification, invalidation", () => {
  it("close back inside before acceptance → invalidated(false_breakout)", () => {
    const fail: Candle[] = [
      ...RANGE_BARS,
      c(101, 103.4, 100.9, 102.9, 10), // attempt
      c(102.9, 103.0, 101.2, 101.5, 11), // reclaim inside → false breakout
    ];
    const out = run(fail, mkAt());
    const s = bull(out)!;
    expect(s.status).toBe("invalidated");
    const ev = out.events.at(-1)!;
    expect(ev.metadata?.to).toBe("invalidated");
    expect(ev.metadata?.transitionReason).toBe("false_breakout");
  });

  it("sweep classification on the boundary pool disqualifies the attempt (sweep wins)", () => {
    const events = (i: number): DetectionEvent[] =>
      i >= 10
        ? [{ kind: "sweep_confirmed", refId: "p:rh:0", symbol: "T", atBar: 10, at: ISO(10), metadata: { penetrationBar: 10 } }]
        : [];
    const pools = [hiPool({ sweepConfirmedBar: 10, sweepConfirmedAt: ISO(10) }), loPool(), t2Pool()];
    const out = run(BULL.slice(0, 12), mkAt({ pools, events }));
    const s = bull(out)!;
    expect(s.reasons.find((r) => r.id === "B4")?.met).toBe(false);
    expect(["developing", "expired"]).toContain(s.status);
  });

  it("post-acceptance close through invalidation level → invalidated", () => {
    const deep: Candle[] = [
      ...BULL.slice(0, 14),
      c(103.9, 104.0, 100.0, 100.5, 14), // close 100.5 < 102.1 − 0.1×ATR → invalidated
    ];
    const out = run(deep, mkAt());
    const s = bull(out)!;
    expect(s.status).toBe("invalidated");
    expect(out.events.at(-1)?.metadata?.transitionReason).toBe("close_through_invalidation");
  });

  it("opposing confirmed CHOCH before confirmation → cancelled", () => {
    const flat: Candle[] = [...RANGE_BARS, c(101, 101.6, 100.6, 101.2, 10)]; // inside bar — no attempt
    const out = run(flat, mkAt({ breaks: (i) => (i >= 9 ? [choch("bearish", 9)] : []) }));
    expect(bull(out)!.status).toBe("cancelled");
    expect(bull(out)!.reasons.find((r) => r.id === "B8")?.met).toBe(false);
  });
});

describe("breakout — bearish mirror", () => {
  const BEAR: Candle[] = [
    ...RANGE_BARS,
    c(101, 101.3, 98.8, 99.0, 10), // close 99.0 < 99.9 − 0.15×ATR — bearish attempt
    c(99.0, 99.4, 98.5, 98.7, 11),
    c(98.7, 99.0, 98.2, 98.4, 12),
    c(98.4, 98.6, 98.0, 98.2, 13), // acceptance
    c(98.2, 98.4, 97.5, 97.8, 14), // low ≤ T1 97.7 → partial
    c(97.8, 98.0, 96.9, 97.1, 15),
    c(97.1, 97.3, 95.4, 95.7, 16), // low ≤ T2 (96 pool) → target_reached
  ];
  const bearT2 = (): LiquidityPool => ({
    id: "p:sell:2", symbol: "T", timeframe: "1h", side: "sell_side", sources: ["swing_low"],
    price: 96, touches: 2, strength: 60, status: "resting", formedAt: ISO(0), lastTouchedAt: ISO(0),
  });
  const at = (idx: number): BreakoutInput => ({
    structure: struct("range"),
    momentum: idx >= 10 ? mom("bearish", 75) : mom("neutral"),
    pools: [hiPool(), loPool(), bearT2()],
    zones: [],
  });

  it("bearish break of support confirms, accepts and reaches targets", () => {
    const out = run(BEAR, at);
    const s = bear(out)!;
    expect(s?.status).toBe("target_reached");
    const tgts = (s.metadata?.targets as string).split(",").map(Number);
    expect(tgts[0]).toBeCloseTo(97.7, 6);
    expect(tgts[1]).toBeCloseTo(96, 6);
    const seq = out.events.filter((e) => e.refId === s.id).map((e) => e.metadata?.to);
    expect(seq).toEqual(["developing", "confirmed", "active", "partial_target", "target_reached"]);
    expect(bull(out)!.reasons.find((r) => r.id === "B4")?.met).toBe(false);
  });
});

describe("breakout — MTF rule", () => {
  it("countertrend HTF veto — attempt can never auto-confirm → expires", () => {
    const out = run(BULL.slice(0, 15), mkAt({ mtf: align("countertrend_bull", -1) }));
    const s = bull(out)!;
    expect(s.status).toBe("expired");
    expect(s.reasons.find((r) => r.id === "B7")?.met).toBe(false);
  });

  it("aligned HTF does not block (context recorded)", () => {
    const out = run(BULL, mkAt({ mtf: align("aligned_bull", 1) }));
    const s = bull(out)!;
    expect(s.reasons.find((r) => r.id === "B7")?.met).toBe(true);
    expect(s.contextTimeframe).toBe("4h");
    expect(s.status).toBe("target_reached");
  });
});

describe("breakout — volume rule", () => {
  // 20-bar compressing range with volume on every bar (median20 = 1000).
  const VOL_RANGE: Candle[] = [
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => c(101, 102.1, 99.9, 101.5, i, 1000)),
    ...[10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map((i) => c(101, 101.5, 100.5, 101, i, 1000)),
  ];

  it("breakout-bar volume below ratio → never confirms", () => {
    const candles = [
      ...VOL_RANGE,
      c(101, 103.2, 100.9, 102.8, 20, 1100), // 1100 < 1.3×1000
      c(102.8, 103.5, 102.6, 103.3, 21, 1000),
      c(103.3, 103.8, 103.0, 103.6, 22, 1000),
      c(103.6, 104.0, 103.2, 103.8, 23, 1000),
      c(103.8, 104.2, 103.6, 104.0, 24, 1000),
    ];
    const out = run(candles, mkAt({ dispBar: 20 }));
    const s = bull(out)!;
    expect(s.status).toBe("expired");
    expect(s.reasons.find((r) => r.id === "B6")?.met).toBe(false);
  });

  it("sufficient volume confirms; absent volume data skips the check", () => {
    const candles = [
      ...VOL_RANGE,
      c(101, 103.2, 100.9, 102.8, 20, 2000), // 2000 ≥ 1.3×1000
      c(102.8, 103.5, 102.6, 103.3, 21, 1000),
      c(103.3, 103.8, 103.0, 103.6, 22, 1000),
      c(103.6, 104.0, 103.2, 103.8, 23, 1000),
    ];
    const s = bull(run(candles, mkAt({ dispBar: 20 })))!;
    expect(s.reasons.find((r) => r.id === "B6")?.met).toBe(true);
    expect(s.status).toBe("active");
    // textbook has no volume on most bars → check skipped → confirmed anyway
    expect(bull(run(BULL.slice(0, 12), mkAt()))!.status).toBe("confirmed");
  });
});

describe("breakout — missing data stays explicit", () => {
  it("no structure / non-range trend / null snapshot → no candidates", () => {
    const at = (idx: number): BreakoutInput => ({ ...mkAt()(idx), structure: struct("uptrend") });
    expect(run(BULL, at).setups).toHaveLength(0);
    expect(run(BULL, () => null).setups).toHaveLength(0);
  });

  it("missing boundary pool is explicit — setup still develops with B3 unmet", () => {
    const out = run(BULL.slice(0, 10), mkAt({ pools: [t2Pool()] }));
    const s = bull(out)!;
    expect(s.id).toBe("bo:T:1h:bullish:rng:0");
    expect(s.reasons.find((r) => r.id === "B3")?.met).toBe(false);
    expect(s.metadata?.anchorPoolId).toBeNull();
  });
});

describe("breakout — causality and determinism", () => {
  it("future candles cannot alter a setup's past (full vs prefix replay)", () => {
    const cut = 11;
    const full = run(BULL, mkAt());
    const prefix = run(BULL.slice(0, cut), mkAt());
    const sF = bull(full)!;
    const sP = bull(prefix)!;
    expect(sP.id).toBe(sF.id);
    expect(sP.createdAt).toBe(sF.createdAt);
    const last = [...full.events].reverse().find((e) => e.refId === sF.id && e.atBar <= cut - 1);
    expect(sP.status).toBe(last?.metadata?.to);
    expect(JSON.stringify(prefix.events)).toBe(JSON.stringify(full.events.filter((e) => e.atBar <= cut - 1)));
  });

  it("identical replay → byte-identical output", () => {
    expect(JSON.stringify(run(BULL, mkAt()))).toBe(JSON.stringify(run(BULL, mkAt())));
  });

  it("no duplicate setups on the same range anchor", () => {
    const out = run(BULL, mkAt());
    const ids = out.setups.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("scale invariance — BTC-like and forex-like prices detect identically", () => {
    const scaled = (k: number) => BULL.map((b) => ({
      time: b.time, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k,
    }));
    const at = (k: number) => (idx: number): BreakoutInput => {
      const r = mkAt()(idx);
      return {
        ...r,
        pools: r.pools?.map((p) => ({ ...p, price: p.price * k, upperPrice: p.upperPrice && p.upperPrice * k, lowerPrice: p.lowerPrice && p.lowerPrice * k })),
        zones: r.zones?.map((z) => ({ ...z, upperPrice: z.upperPrice * k, lowerPrice: z.lowerPrice * k })),
      };
    };
    const base = run(BULL, mkAt()).setups.map((s) => s.status);
    expect(run(scaled(60000 / 100), at(60000 / 100)).setups.map((s) => s.status)).toEqual(base);
    expect(run(scaled(0.01), at(0.01)).setups.map((s) => s.status)).toEqual(base);
  });
});

describe("breakout — engine contract", () => {
  const input = {
    series: { symbol: "T", timeframe: "1h" as const, candles: BULL },
    structure: struct("range"),
    pools: [hiPool(), loPool(), t2Pool()],
    zones: [t2Zone()],
    imbalances: [],
    momentum: mom("bullish", 75),
    config: { ...CFG, reversal: {} as never, continuation: {} as never },
  };

  it("detect — ok, data, deterministic meta", () => {
    const res = createBreakoutSetupEngine().detect(input);
    expect(res.ok).toBe(true);
    expect(res.meta.stage).toBe("setups");
    expect(res.data?.filter((s) => s.direction === "bullish")).toHaveLength(1);
    expect(res.meta.events.some((e) => e.kind === "setup_transition")).toBe(true);
  });

  it("invalid config → invalid_config, no data", () => {
    const res = createBreakoutSetupEngine().detect({
      ...input,
      config: { ...input.config, breakout: { ...CFG.breakout, holdBars: 0 } },
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0].code).toBe("invalid_config");
  });

  it("empty series → ok, empty data", () => {
    const res = createBreakoutSetupEngine().detect({ ...input, series: { ...input.series, candles: [] } });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual([]);
  });
});
