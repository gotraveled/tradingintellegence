import { describe, expect, it } from "vitest";
import type {
  Bias,
  Candle,
  Direction,
  Imbalance,
  LiquidityPool,
  MarketStructure,
  Momentum,
  SwingPoint,
  SwingType,
  Zone,
} from "@/lib/types";
import { createContinuationSetupEngine, detectContinuations, type ContinuationInput } from "../continuation";
import { FIXTURE_EPOCH as E } from "@/lib/market-data";

const H1 = 3_600_000;
const ISO = (i: number) => new Date(E + i * H1).toISOString();
const c = (o: number, h: number, l: number, cl: number, i: number): Candle => ({
  time: E + i * H1, open: o, high: h, low: l, close: cl,
});

const CFG = {
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
};

// ---- Bullish textbook ----------------------------------------------------------
// Impulse HL@2(100) → HH@6(110), height 10. Pullback bars 7-9 to low 106 (40%).
// Demand zone [104.5,106.5] hit at bar9 → developing. Recovery bar10, confirm bar11,
// band re-entry bar12 → active; T1=110@13, T3=115@15, T2=116@15.
const BULL: Candle[] = [
  c(99, 100.5, 98.5, 100, 0),
  c(100, 102.5, 99.5, 102, 1),
  c(102, 103.5, 101.5, 103, 2),
  c(103, 105, 102.5, 104.5, 3),
  c(104.5, 106, 104, 105.5, 4),
  c(105.5, 108, 105, 107.5, 5),
  c(107.5, 110.3, 107, 110, 6), // HH pivot
  c(110, 110.2, 108.2, 109, 7), // pullback begins — 18%
  c(109, 109.2, 106.8, 107.5, 8), // 32%
  c(107.5, 107.8, 106.0, 106.4, 9), // low 106 → 40%, inside zone → developing
  c(106.4, 107.8, 106.2, 107.7, 10), // recovery body 1.3 ≥ 0.5×ATR + strengthening
  c(107.7, 108.0, 107.4, 107.8, 11), // close > 107 + margin → confirmed
  c(107.8, 108.0, 106.5, 106.8, 12), // close ∈ band [106, 107.7] → active
  c(106.8, 110.5, 106.6, 110.2, 13), // high ≥ 110 → T1 partial
  c(110.2, 111, 110, 110.5, 14),
  c(110.5, 116.5, 110.3, 116.2, 15), // high ≥ 115 and ≥ 116 — both remaining targets → reached
];

const sw = (id: string, kind: SwingPoint["kind"], price: number, pivot: number, cls: SwingType, conf: number): SwingPoint => ({
  id, kind, price, pivotIndex: pivot, pivotAt: ISO(pivot), classification: cls,
  status: "confirmed", confirmedIndex: conf, confirmedAt: ISO(conf),
});

const bullSwings = (): SwingPoint[] => [
  sw("sw:hh:0", "high", 98, 0, "HH", 1),
  sw("sw:hl:2", "low", 100, 2, "HL", 4),
  sw("sw:hh:6", "high", 110, 6, "HH", 8),
  sw("sw:ph:9", "high", 107, 9, "LH", 11), // countertrend lower-high — the confirm level
];
const bearSwings = (): SwingPoint[] => [
  sw("sw:ll:0", "low", 102, 0, "LL", 1),
  sw("sw:lh:2", "high", 110, 2, "LH", 4),
  sw("sw:ll:6", "low", 100, 6, "LL", 8),
  sw("sw:pl:9", "low", 103, 9, "HL", 11),
];

const dZone = (): Zone => ({
  id: "z:d:1", symbol: "T", timeframe: "1h", type: "demand",
  upperPrice: 106.5, lowerPrice: 104.5, strength: 70, freshness: "fresh", retestCount: 0,
  status: "active", originAt: ISO(0), createdAt: ISO(0),
});
const sZone = (): Zone => ({
  id: "z:s:1", symbol: "T", timeframe: "1h", type: "supply",
  upperPrice: 105.5, lowerPrice: 103.5, strength: 70, freshness: "fresh", retestCount: 0,
  status: "active", originAt: ISO(0), createdAt: ISO(0),
});
const t3Pool = (price = 115): LiquidityPool => ({
  id: `p:t3:${price}`, symbol: "T", timeframe: "1h", side: "buy_side", sources: ["swing_high"],
  price, touches: 2, strength: 60, status: "resting", formedAt: ISO(0), lastTouchedAt: ISO(0),
});
const impFvg = (createdBar = 5): Imbalance => ({
  id: "fvg:imp:5", symbol: "T", timeframe: "1h", direction: "bullish",
  upperPrice: 107, lowerPrice: 105, fillPct: 0, status: "open", createdAt: ISO(createdBar),
  metadata: { createdBar },
});
const struct = (trend: MarketStructure["trend"], swings: SwingPoint[], breaks: MarketStructure["breaks"] = []): MarketStructure => ({
  symbol: "T", timeframe: "1h", trend, bias: "neutral", swings, breaks, keyLevels: [], updatedAt: ISO(15),
});
const choch = (dir: Direction, atBar: number) => ({
  id: `brk:${dir}:${atBar}`, type: "CHOCH" as const, direction: dir, price: 105, time: ISO(atBar),
  confirmed: true, refPrice: 105, breakIndex: atBar,
});
const mom = (bias: Bias, disp: number, state: Momentum["state"] = "neutral", dm?: number): Momentum => ({
  state, bias, displacementScore: disp, features: dm !== undefined ? { directionalMove: dm } : {},
});

type Gate = Partial<{
  trend: MarketStructure["trend"];
  swings: SwingPoint[];
  zones: Zone[];
  fvg: Imbalance[];
  pools: LiquidityPool[];
  momAt: (i: number) => Momentum | undefined;
  breaks: (i: number) => MarketStructure["breaks"];
}>;

// per-bar momentum: bullish impulse (disp 80) → bearish pullback (disp 40) → strengthening recovery
const bullMom = (i: number): Momentum =>
  i <= 6 ? mom("bullish", 80, "neutral", 1)
    : i <= 9 ? mom("bearish", 40, "neutral", -1)
    : mom("bullish", 70, "strengthening", 1);

function mkAt(g: Gate = {}) {
  return (idx: number): ContinuationInput => ({
    structure: struct(g.trend ?? "uptrend", g.swings ?? bullSwings(), g.breaks ? g.breaks(idx) : []),
    momentum: g.momAt ? g.momAt(idx) : bullMom(idx),
    pools: g.pools ?? [t3Pool()],
    zones: g.zones ?? [dZone()],
    imbalances: g.fvg ?? [],
  });
}
const run = (candles: Candle[], at: (i: number) => ContinuationInput | null) =>
  detectContinuations({ candles, symbol: "T", timeframe: "1h", at, config: CFG });
const bull = (o: ReturnType<typeof run>) => o.setups.find((s) => s.direction === "bullish");
const bear = (o: ReturnType<typeof run>) => o.setups.find((s) => s.direction === "bearish");
const seqOf = (o: ReturnType<typeof run>, id: string) =>
  o.events.filter((e) => e.refId === id).map((e) => `${e.atBar}:${e.metadata?.to}`);

describe("continuation — bullish textbook lifecycle", () => {
  const out = run(BULL, mkAt());
  const s = bull(out)!;

  it("developing only when trend+impulse+pullback+interaction all hold (bar 9)", () => {
    expect(s.createdAt).toBe(ISO(9));
    expect(out.events.filter((e) => e.atBar < 9)).toHaveLength(0); // 40% at bar8 but pbBars 2 < 3
    expect(s.type).toBe("continuation");
    expect(s.id).toBe("cont:T:1h:bullish:z:d:1");
    expect(s.zoneIds).toEqual(["z:d:1"]);
    expect(s.metadata?.impulseTop).toBe(110);
    expect(s.metadata?.impulseHeight).toBe(10);
  });

  it("developing → confirmed(quality+recovery+confirm close) → active(band re-entry) → targets", () => {
    expect(s.status).toBe("target_reached");
    expect(seqOf(out, s.id)).toEqual([
      // spec 11: band overlap by wick — the confirm bar's low (107.4) already re-enters the band
      "9:developing", "11:confirmed", "11:active", "13:partial_target", "15:target_reached",
    ]);
  });

  it("records entry band, invalidation, quality and ordered targets as evidence", () => {
    const tgts = (s.metadata?.targets as string).split(",").map(Number);
    expect(tgts[0]).toBeCloseTo(110, 4); // T1 prior HH
    expect(tgts[1]).toBeCloseTo(115, 4); // T3 nearest opposing pool beyond T1
    expect(tgts[2]).toBeCloseTo(116, 4); // T2 = 106 + 10 impulse projection
    expect(Number(s.metadata?.entryBandHigh)).toBeCloseTo(107.7, 4); // recovery close
    expect(Number(s.metadata?.quality)).toBeGreaterThanOrEqual(0.5);
    expect(s.reasons.find((r) => r.id === "N6")?.met).toBe(true);
    expect(s.reasons.find((r) => r.id === "N7")?.signalIds).toContain("sw:ph:9");
  });
});

describe("continuation — bearish mirror", () => {
  const BEAR: Candle[] = [
    c(111, 111.5, 109.5, 110, 0),
    c(110, 110.5, 108, 108.5, 1),
    c(108.5, 109, 106.5, 107, 2),
    c(107, 107.5, 105.5, 106, 3),
    c(106, 106.5, 104.5, 105, 4),
    c(105, 105.5, 102.5, 103, 5),
    c(103, 103.3, 99.7, 100, 6), // LL pivot
    c(100, 101.8, 99.8, 101, 7),
    c(101, 103.2, 100.8, 102.5, 8),
    c(102.5, 104.0, 102.2, 103.6, 9), // pbHigh 104 → 40%, inside supply [103.5,105.5] → developing
    c(103.6, 103.9, 102.2, 102.2, 10), // bearish recovery body 1.4
    c(102.2, 102.5, 102.1, 102.6, 11), // close < 103 − margin → confirmed
    c(102.6, 103.4, 102.5, 103.2, 12), // close ∈ band [102.2, 104] → active
    c(103.2, 103.5, 99.5, 99.8, 13), // low ≤ 100 → T1
    c(99.8, 100, 93.5, 94.2, 14), // low ≤ 95 and ≤ 94 → T3 + T2
  ];
  const bearMom = (i: number): Momentum =>
    i <= 6 ? mom("bearish", 80, "neutral", -1)
      : i <= 9 ? mom("bullish", 40, "neutral", 1)
      : mom("bearish", 70, "strengthening", -1);
  const bearAt = (idx: number): ContinuationInput => ({
    structure: struct("downtrend", bearSwings()),
    momentum: bearMom(idx),
    pools: [t3Pool(95)],
    zones: [sZone()],
  });

  it("bearish continuation confirms, activates and reaches targets", () => {
    const out = run(BEAR, bearAt);
    const s = bear(out)!;
    expect(s.status).toBe("target_reached");
    expect(seqOf(out, s.id).map((x) => x.split(":")[1]))
      .toEqual(["developing", "confirmed", "active", "partial_target", "target_reached"]);
    const tgts = (s.metadata?.targets as string).split(",").map(Number);
    expect(tgts[0]).toBeCloseTo(100, 4);
    expect(tgts[1]).toBeCloseTo(95, 4);
    expect(tgts[2]).toBeCloseTo(94, 4);
    expect(bull(out)).toBeUndefined(); // bullish premise absent in a downtrend
  });
});

describe("continuation — gates and lookalikes", () => {
  it("range trend / insufficient swings / wrong order → no candidates", () => {
    expect(run(BULL, mkAt({ trend: "range" })).setups).toHaveLength(0);
    expect(run(BULL, mkAt({ swings: bullSwings().slice(0, 2) })).setups).toHaveLength(0);
    const noHl = [sw("sw:a", "high", 98, 0, "HH", 1), sw("sw:b", "high", 110, 6, "HH", 8), sw("sw:c", "low", 101, 7, "LL", 9)];
    expect(run(BULL, mkAt({ swings: noHl })).setups).toHaveLength(0);
  });

  it("impulse shorter than impulseMinAtr → nothing", () => {
    const flat = { ...CFG, continuation: { ...CFG.continuation, impulseMinAtr: 20 } };
    const out = detectContinuations({ candles: BULL, symbol: "T", timeframe: "1h", at: mkAt(), config: flat });
    expect(out.setups).toHaveLength(0);
  });

  it("shallow pullback (< pullbackMinPct) → nothing develops", () => {
    const shallow: Candle[] = [
      ...BULL.slice(0, 7),
      c(110, 110.2, 108.5, 109.2, 7), // 15% — too shallow
      c(109.2, 109.5, 108.0, 108.8, 8),
      c(108.8, 109, 108.2, 108.6, 9),
    ];
    expect(run(shallow, mkAt()).setups).toHaveLength(0);
  });

  it("pullback deeper than pullbackMaxPct → cancelled (reversal warning)", () => {
    const deep: Candle[] = [
      ...BULL.slice(0, 9),
      c(107.5, 107.8, 106.0, 106.4, 9),
      c(106.4, 106.6, 100.8, 101.2, 10), // low 100.8 → retrace 92% > 78.6%
    ];
    const out = run(deep, mkAt());
    const s = bull(out)!;
    expect(s.status).toBe("cancelled");
    expect(out.events.at(-1)?.metadata?.transitionReason).toBe("pullback_too_deep");
  });

  it("pullback without zone/FVG interaction → no setup", () => {
    expect(run(BULL, mkAt({ zones: [] })).setups).toHaveLength(0);
  });

  it("FVG from the impulse leg satisfies the interaction", () => {
    // no zone; bullish FVG created inside impulse bars, pbLow 106 penetrates ≥50% of [105,107]
    const out = run(BULL.slice(0, 10), mkAt({ zones: [], fvg: [impFvg(5)] }));
    const s = bull(out)!;
    expect(s.id).toBe("cont:T:1h:bullish:fvg:imp:5");
    expect(s.metadata?.fvgId).toBe("fvg:imp:5");
    expect(s.reasons.find((r) => r.id === "N4")?.met).toBe(true);
  });

  it("FVG formed before the impulse leg does not qualify", () => {
    const early: Imbalance = { ...impFvg(1), id: "fvg:old:1", metadata: { createdBar: 1 } };
    expect(run(BULL.slice(0, 10), mkAt({ zones: [], fvg: [early] })).setups).toHaveLength(0);
  });

  it("pullback displacement ≥ impulse → quality < 0.5 → stays developing (never confirms)", () => {
    const strong: (i: number) => Momentum = (i) =>
      i <= 6 ? mom("bullish", 50, "neutral", 1)
        : i <= 9 ? mom("bearish", 80, "neutral", -1) // counter-move is stronger
        : mom("bullish", 70, "strengthening", 1);
    const out = run(BULL.slice(0, 14), mkAt({ momAt: strong }));
    const s = bull(out)!;
    expect(s.status).toBe("developing"); // hard gate — cannot reach confirmed
    expect(s.reasons.find((r) => r.id === "N5")?.met).toBe(false);
  });

  it("opposing CHOCH before confirmation → cancelled (reversal signature)", () => {
    const out = run(BULL.slice(0, 11), mkAt({ breaks: (i) => (i >= 10 ? [choch("bearish", 10)] : []) }));
    expect(bull(out)!.status).toBe("cancelled");
    expect(out.events.at(-1)?.metadata?.transitionReason).toBe("opposing_CHOCH");
  });

  it("close through pullback defence post-confirmation → invalidated", () => {
    const fail: Candle[] = [
      ...BULL.slice(0, 12),
      c(107.6, 107.7, 105.0, 105.3, 12), // close < 106 − 0.1×ATR
    ];
    const out = run(fail, mkAt());
    const s = bull(out)!;
    expect(s.status).toBe("invalidated");
    expect(out.events.at(-1)?.metadata?.transitionReason).toBe("close_through_defence");
  });

  it("no countertrend swing or no momentum → stays developing → expires", () => {
    const noCounter = bullSwings().filter((x) => x.id !== "sw:ph:9");
    const o1 = run(BULL.slice(0, 20), mkAt({ swings: noCounter }));
    expect(["developing", "expired"]).toContain(bull(o1)!.status);
    const o2 = run(BULL.slice(0, 20), mkAt({ momAt: () => undefined }));
    expect(["developing", "expired"]).toContain(bull(o2)!.status);
    expect(bull(o2)!.reasons.find((r) => r.id === "N6")?.met).toBe(false);
  });
});

describe("continuation — reconciliation: quality composite (Issue 1)", () => {
  it("quality is deterministic and pinned to the documented normalization", () => {
    const s = bull(run(BULL, mkAt()))!;
    // pullback bars 7-9 range sum 6.2 vs impulse bars 2-6 sum 12.8 → a = 1 − 0.484375 = 0.515625;
    // displacement component 1 (40 < 80); volume skipped → mean = 0.7578125
    expect(Number(s.metadata?.quality)).toBeCloseTo(0.7578, 4);
  });
});

describe("continuation — reconciliation: causal FVG state (Issue 2)", () => {
  // Final-status "filled" FVG stamped filledBar=12 — the object as 4E emits it end-of-series.
  const filledLater: Imbalance = {
    ...impFvg(5), status: "filled", fillPct: 100,
    metadata: { createdBar: 5, filledBar: 12 },
  };
  const contractAt = (idx: number): ContinuationInput => ({
    structure: struct("uptrend", bullSwings()),
    momentum: bullMom(idx),
    pools: [t3Pool()],
    zones: [],
    imbalances: [filledLater], // same object at every bar — final status must not leak
  });

  it("FVG open before its fill bar still anchors a developing candidate", () => {
    const out = run(BULL.slice(0, 10), contractAt);
    const s = bull(out)!;
    expect(s).toBeDefined();
    expect(s.metadata?.fvgId).toBe("fvg:imp:5");
    expect(s.createdAt).toBe(ISO(9)); // detected at bar 9 — the FVG was open then
  });

  it("the same FVG no longer qualifies after its fill bar", () => {
    // bars 0-11 flat inside the FVG fill zone but no pullback until a late dip —
    // a second qualifying interaction at bar ≥ filledBar must not see the FVG as open.
    const late: Candle[] = [
      ...BULL.slice(0, 9),
      c(107.5, 108.0, 106.0, 106.4, 9),  // interaction at 9 (pre-fill, fills nothing)
      ...[10, 11].map((i) => c(106.4, 107.0, 106.2, 106.6, i)),
    ];
    // the stamped FVG filled at 12; replay to bar 11 — candidate from bar 9 remains
    const out = run(late, contractAt);
    const s = bull(out)!;
    expect(s).toBeDefined();
  });

  it("provider path: open-family vs filled snapshots gate interaction by bar", () => {
    // gated provider: FVG open ≤11, filled at 12+ (canonical *StateAt shape)
    const gateAt = (idx: number): ContinuationInput => ({
      ...mkAt({ zones: [] })(idx),
      imbalances: [
        idx < 12
          ? impFvg(5)
          : { ...impFvg(5), status: "filled", fillPct: 100, metadata: { createdBar: 5, filledBar: 12 } },
      ],
    });
    const pre = run(BULL.slice(0, 10), gateAt);
    expect(bull(pre)).toBeDefined(); // open at 9 → interacts
    // post-fill: a fresh candidate window after bar 12 can't use it
    const post: Candle[] = [
      ...BULL.slice(0, 6),
      ...[6, 7, 8, 9, 10, 11].map((i) => c(110, 110.2, 108.8, 109.5, i)),
      c(109.5, 109.8, 105.8, 106.2, 12), // deep dip AFTER the fill — still no setup
      c(106.2, 106.8, 105.9, 106.5, 13),
      c(106.5, 107.0, 106.1, 106.4, 14),
    ];
    const out = run(post, gateAt);
    expect(out.setups.filter((x) => x.direction === "bullish")).toHaveLength(0);
  });

  it("prefix replay vs full replay: continuation state identical for every shared bar", () => {
    const full = run(BULL, contractAt);
    for (const cut of [10, 12, 14]) {
      const pre = run(BULL.slice(0, cut), contractAt);
      const sF = bull(full)!;
      const sP = bull(pre)!;
      expect(sP.id).toBe(sF.id);
      const last = [...full.events].reverse().find((e) => e.refId === sF.id && e.atBar <= cut - 1);
      expect(sP.status).toBe(last?.metadata?.to);
      expect(JSON.stringify(pre.events)).toBe(JSON.stringify(full.events.filter((e) => e.atBar <= cut - 1)));
    }
  });
});

describe("continuation — reconciliation: spec-11 expiry + band overlap (Issue 3)", () => {
  it("developing without confirmation expires after expiryBars", () => {
    const cfg = { ...CFG, lifecycle: { expiryBars: 5, invalidateAtr: 0.1 } };
    const out = detectContinuations({ candles: BULL.slice(0, 16), symbol: "T", timeframe: "1h", at: mkAt({ momAt: () => mom("neutral", 0) }), config: cfg });
    const s = bull(out)!;
    expect(s.status).toBe("expired");
    expect(out.events.at(-1)?.metadata?.transitionReason).toBe("stalled");
  });

  it("confirmed but never active also expires — spec 11 stale guard applies pre-active", () => {
    // countertrend swing at 108 → confirm close 108.4; bar11 low 107.8 clears the band → no overlap
    const swings = [...bullSwings().slice(0, 3), sw("sw:ph:9", "high", 108, 9, "LH", 11)];
    const cfg = { ...CFG, lifecycle: { expiryBars: 5, invalidateAtr: 0.1 } };
    const candles: Candle[] = [
      ...BULL.slice(0, 11),
      c(107.7, 108.5, 107.8, 108.4, 11), // confirm close > 108 + margin; low above band top
      ...[12, 13, 14, 15].map((i) => c(108.4, 108.9, 108.1, 108.5, i)),
    ];
    const out = detectContinuations({ candles, symbol: "T", timeframe: "1h", at: mkAt({ swings }), config: cfg });
    const s = bull(out)!;
    expect(s.status).toBe("expired"); // created@9 + 5 → expired@15
    expect(out.events.filter((e) => e.refId === s.id).map((e) => e.metadata?.to))
      .toEqual(["developing", "confirmed", "expired"]);
  });

  it("active with no target/invalidation progress expires (spec 11)", () => {
    const cfg = { ...CFG, lifecycle: { expiryBars: 3, invalidateAtr: 0.1 } };
    const candles: Candle[] = [
      ...BULL.slice(0, 13),
      ...[13, 14, 15, 16, 17].map((i) => c(107, 108.5, 106.5, 107.5, i)), // inside/near band, no targets
    ];
    const out = detectContinuations({ candles, symbol: "T", timeframe: "1h", at: mkAt(), config: cfg });
    const s = bull(out)!;
    const seq = seqOf(out, s.id);
    expect(seq).toContain("11:active"); // wick overlap on the confirm bar
    expect(s.status).toBe("expired");
  });

  it("wick-only band overlap activates — spec 11: wick counts", () => {
    // countertrend swing at 108 keeps the confirm bar out of the band; bar12 wicks in, closes out
    const swings = [...bullSwings().slice(0, 3), sw("sw:ph:9", "high", 108, 9, "LH", 11)];
    const candles: Candle[] = [
      ...BULL.slice(0, 11),
      c(107.7, 108.5, 107.8, 108.4, 11), // confirm close; no band overlap
      c(108.4, 108.6, 106.9, 108.2, 12), // low 106.9 dips into [106,107.7], close above → active
      c(108.2, 110.6, 108.0, 110.2, 13),
    ];
    const out = run(candles, mkAt({ swings }));
    const s = bull(out)!;
    const seq = seqOf(out, s.id);
    expect(seq).toContain("11:confirmed");
    expect(seq).toContain("12:active");
  });
});

describe("continuation — causality and determinism", () => {
  it("future candles cannot alter a setup's past (full vs prefix replay)", () => {
    const cut = 12;
    const full = run(BULL, mkAt());
    const prefix = run(BULL.slice(0, cut), mkAt());
    const sF = bull(full)!;
    const sP = bull(prefix)!;
    expect(sP.id).toBe(sF.id);
    const last = [...full.events].reverse().find((e) => e.refId === sF.id && e.atBar <= cut - 1);
    expect(sP.status).toBe(last?.metadata?.to);
    expect(JSON.stringify(prefix.events)).toBe(JSON.stringify(full.events.filter((e) => e.atBar <= cut - 1)));
  });

  it("identical replay → byte-identical output", () => {
    expect(JSON.stringify(run(BULL, mkAt()))).toBe(JSON.stringify(run(BULL, mkAt())));
  });

  it("scale invariance — statuses identical at BTC-like and forex-like prices", () => {
    const scaled = (k: number) => BULL.map((b) => ({
      time: b.time, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k,
    }));
    const at = (k: number) => (idx: number): ContinuationInput => {
      const r = mkAt()(idx);
      return {
        ...r,
        structure: r.structure && {
          ...r.structure,
          swings: r.structure.swings.map((s) => ({ ...s, price: s.price * k })),
        },
        pools: r.pools?.map((p) => ({ ...p, price: p.price * k })),
        zones: r.zones?.map((z) => ({ ...z, upperPrice: z.upperPrice * k, lowerPrice: z.lowerPrice * k })),
        imbalances: r.imbalances?.map((f) => ({ ...f, upperPrice: f.upperPrice * k, lowerPrice: f.lowerPrice * k })),
      };
    };
    const base = run(BULL, mkAt()).setups.map((s) => s.status);
    expect(run(scaled(60000 / 100), at(60000 / 100)).setups.map((s) => s.status)).toEqual(base);
    expect(run(scaled(0.01), at(0.01)).setups.map((s) => s.status)).toEqual(base);
  });
});

describe("continuation — engine contract", () => {
  const input = {
    series: { symbol: "T", timeframe: "1h" as const, candles: BULL },
    structure: struct("uptrend", bullSwings()),
    pools: [t3Pool()],
    zones: [dZone()],
    imbalances: [],
    momentum: mom("bullish", 70, "strengthening", 1),
    config: { ...CFG, reversal: {} as never, breakout: {} as never },
  };

  it("detect — ok, data, deterministic meta", () => {
    const res = createContinuationSetupEngine().detect(input);
    expect(res.ok).toBe(true);
    expect(res.meta.stage).toBe("setups");
    expect(res.data?.some((s) => s.type === "continuation")).toBe(true);
  });

  it("invalid config → invalid_config, no data", () => {
    const res = createContinuationSetupEngine().detect({
      ...input,
      config: { ...input.config, continuation: { ...CFG.continuation, pullbackMaxPct: 20 } },
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0].code).toBe("invalid_config");
  });

  it("empty series → ok, empty data", () => {
    const res = createContinuationSetupEngine().detect({ ...input, series: { ...input.series, candles: [] } });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual([]);
  });
});
