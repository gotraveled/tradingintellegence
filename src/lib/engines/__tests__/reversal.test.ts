import { describe, expect, it } from "vitest";
import type {
  Bias,
  Candle,
  Direction,
  Imbalance,
  LiquidityPool,
  MarketStructure,
  Momentum,
  MultiTimeframeAlignment,
  StructureBreak,
  Zone,
} from "@/lib/types";
import { atrAt, createReversalSetupEngine, detectReversals, type ReversalInput } from "../reversal";
import { FIXTURE_EPOCH as E } from "@/lib/market-data";

const H1 = 3_600_000;
const ISO = (i: number) => new Date(E + i * H1).toISOString();
const c = (o: number, h: number, l: number, cl: number, i: number, k = 1): Candle => ({
  time: E + i * H1, open: o * k, high: h * k, low: l * k, close: cl * k,
});

const CFG = {
  lifecycle: { expiryBars: 30, invalidateAtr: 0.1 },
  reversal: { zoneMaxAgeBars: 500, zoneMinStrength: 50, sweepMaxAgeBars: 10, dispMinScore: 60, entryZoneDepth: 0.5, invalidateAtr: 0.1 },
};

// ---- Bullish textbook fixture ------------------------------------------------
// bars 0-4 flat ~105 (ATR ≈ 1); bar5 dips into demand zone [99,101]; bar6 sweeps the
// sell-side pool at 99.5 and reclaims; bar7 displacement; bar8 bullish CHOCH;
// bar10 re-enters the band; bar12/14/16 take T1/T2/T3 (104.5 / 106 / 110).
const FLAT = [0, 1, 2, 3, 4].map((i) => c(105, 105.5, 104.5, 105, i));
const BULL: Candle[] = [
  ...FLAT,
  c(105, 105.4, 100.8, 101.5, 5),  // approach — C1
  c(101.5, 101.6, 98.5, 100.2, 6), // sweep sell-side, reclaim above 99.5 — C3/C4
  c(100.2, 101.8, 99.9, 101.6, 7), // displacement leg — C5
  c(101.6, 103.4, 101.4, 103.2, 8),// bullish CHOCH closes beyond LH — C6
  c(103.2, 103.5, 102.4, 103.0, 9),
  c(103.0, 103.2, 99.5, 100.3, 10),// re-entry into band [99,100] — C9 → active
  c(100.3, 102.4, 100.1, 102.2, 11),
  c(102.2, 104.8, 102.0, 104.4, 12),// high ≥ 104.5 → T1 → partial_target
  c(104.4, 104.6, 103.0, 103.6, 13),
  c(103.6, 106.5, 103.4, 106.2, 14),// high ≥ 106 → T2 → partial_target
  c(106.2, 106.4, 105.0, 105.6, 15),
  c(105.6, 110.5, 105.4, 110.1, 16),// high ≥ 110 → T3 → target_reached
  c(110.1, 110.6, 109.6, 110.2, 17),
  c(110.2, 110.4, 109.8, 110.0, 18),
];

const demandZone = (): Zone => ({
  id: "z:dem:0", symbol: "T", timeframe: "1h", type: "demand",
  upperPrice: 101, lowerPrice: 99, strength: 70, freshness: "fresh", retestCount: 0,
  status: "active", originAt: ISO(0), createdAt: ISO(0),
});
const supplyZone = (): Zone => ({
  id: "z:sup:0", symbol: "T", timeframe: "1h", type: "supply",
  upperPrice: 108, lowerPrice: 106, strength: 70, freshness: "fresh", retestCount: 0,
  status: "active", originAt: ISO(0), createdAt: ISO(0),
});
const sellPool = (sweepBar = 6): LiquidityPool => ({
  id: "p:sell:1", symbol: "T", timeframe: "1h", side: "sell_side", sources: ["swing_low"],
  price: 99.5, touches: 2, strength: 60, status: "swept",
  formedAt: ISO(2), lastTouchedAt: ISO(2), sweptAt: ISO(6),
  metadata: { sweepConfirmedBar: sweepBar, sweepConfirmedAt: ISO(sweepBar) },
});
const buyPool = (): LiquidityPool => ({
  id: "p:buy:1", symbol: "T", timeframe: "1h", side: "buy_side", sources: ["swing_high"],
  price: 104.5, touches: 2, strength: 60, status: "resting", formedAt: ISO(2), lastTouchedAt: ISO(2),
});
const choch = (dir: Direction, atBar: number): StructureBreak => ({
  id: `brk:${dir}:${atBar}`, type: "CHOCH", direction: dir, price: 103, time: ISO(atBar),
  confirmed: true, refPrice: 103, breakIndex: atBar,
});
const structure = (breaks: StructureBreak[]): MarketStructure => ({
  symbol: "T", timeframe: "1h", trend: "range", bias: "neutral", swings: [], breaks,
  keyLevels: [{ label: "HH", price: 110 }], updatedAt: ISO(18),
});
const mom = (bias: Bias, disp?: number): Momentum => ({ state: "neutral", bias, displacementScore: disp });
const align = (state: MultiTimeframeAlignment["state"]): MultiTimeframeAlignment => ({
  symbol: "T",
  timeframes: { htf: "4h", itf: "1h", etf: "15m" },
  votes: { htf: 1, itf: 1, etf: 1 }, alignmentScore: 1, state, computedAt: ISO(18),
});
const bullFvg = (bar = 7): Imbalance => ({
  id: `fvg:T:1h:bull:${bar}`, symbol: "T", timeframe: "1h", direction: "bullish",
  upperPrice: 101.8, lowerPrice: 101.6, status: "open", createdAt: ISO(bar),
});

type Gate = Partial<{
  dispBar: number; // first bar with bullish displacement ≥ threshold
  breakBar: number | false;
  sweepBar: number | false;
  fvgBar: number | false;
  mtf: MultiTimeframeAlignment["state"] | undefined;
  zones: Zone[];
  pools: LiquidityPool[];
  dir: Direction;
}>;

/** Gated provider — each field becomes knowable only at its own bar, mirroring the 4G join. */
function bullAt(g: Gate = {}) {
  const dispBar = g.dispBar ?? 7;
  const dir = g.dir ?? "bullish";
  return (idx: number): ReversalInput => ({
    zones: g.zones ?? [demandZone(), supplyZone()],
    pools: g.pools ?? (g.sweepBar === false ? [buyPool()] : [sellPool(g.sweepBar ?? 6), buyPool()]),
    structure: structure(g.breakBar === false ? [] : g.breakBar !== undefined && idx >= g.breakBar ? [choch(dir, g.breakBar ?? 8)] : idx >= 8 ? [choch(dir, 8)] : []),
    momentum: idx >= dispBar ? mom(dir, 75) : mom("neutral"),
    imbalances: g.fvgBar !== false && idx >= (g.fvgBar ?? 7) ? [bullFvg()] : [],
    alignment: g.mtf === undefined ? undefined : align(g.mtf),
  });
}
const run = (candles: Candle[], at: (i: number) => ReversalInput | null) =>
  detectReversals({ candles, symbol: "T", timeframe: "1h", at, config: CFG });

describe("reversal — bullish textbook lifecycle", () => {
  const out = run(BULL, bullAt());
  const s = out.setups[0];

  it("detects exactly one setup, explainable evidence chain", () => {
    expect(out.setups).toHaveLength(1);
    expect(s.type).toBe("reversal");
    expect(s.direction).toBe("bullish");
    expect(s.id).toBe("rev:T:1h:bullish:z:dem:0:pre");
    expect(s.zoneIds).toEqual(["z:dem:0"]);
    expect(s.liquidityEventIds).toEqual(["p:sell:1"]);
    expect(s.metadata?.fvgId).toBe("fvg:T:1h:bull:7");
    expect(s.metadata?.breakId).toBe("brk:bullish:8");
    expect(s.metadata?.sweepBar).toBe(6);
    expect(s.reasons.slice(0, 6).every((r) => r.met)).toBe(true);
  });

  it("walks the lifecycle: developing → confirmed → active → partial → target_reached", () => {
    expect(s.status).toBe("target_reached");
    const seq = out.events.filter((e) => e.refId === s.id).map((e) => `${e.atBar}:${e.metadata?.to}`);
    expect(seq).toEqual(["5:developing", "8:confirmed", "10:active", "12:partial_target", "14:partial_target", "16:target_reached"]);
  });

  it("records entry band, invalidation and ordered targets as evidence", () => {
    expect(s.metadata?.entryBandLow).toBe(99);
    expect(s.metadata?.entryBandHigh).toBe(100);
    expect(Number(s.metadata?.invalidation)).toBeCloseTo(99 - 0.1 * atrAt(BULL, 5), 5); // zone.low − invalidateAtr×ATR(t)
    expect(s.metadata?.targets).toBe("104.5,106,110");
  });
});

describe("reversal — developing vs confirmed (spec 11)", () => {
  it("C1+C2 met, sweep pending → developing with missing conditions named", () => {
    const out = run(BULL.slice(0, 6), bullAt()); // bars 0-5: approach only
    const s = out.setups[0];
    expect(s.status).toBe("developing");
    expect(s.reasons.find((r) => r.id === "C1")?.met).toBe(true);
    expect(s.reasons.find((r) => r.id === "C3")?.met).toBe(false);
    expect(s.reasons.find((r) => r.id === "C6")?.met).toBe(false);
  });

  it("sweep + reclaim but weak displacement stays developing (anti-fixture)", () => {
    const out = run(BULL.slice(0, 9), bullAt({ dispBar: 99 }));
    const s = out.setups[0];
    expect(s.status).toBe("developing");
    expect(s.reasons.find((r) => r.id === "C5")?.met).toBe(false);
  });

  it("displacement without structure break stays developing (anti-fixture)", () => {
    const out = run(BULL.slice(0, 9), bullAt({ breakBar: false }));
    const s = out.setups[0];
    expect(s.status).toBe("developing");
    expect(s.reasons.find((r) => r.id === "C6")?.met).toBe(false);
  });

  it("no sweep → C3/C4 unmet, never confirms", () => {
    const out = run(BULL, bullAt({ sweepBar: false }));
    // sell pool absent → no candidate at all (C2 fails)
    expect(out.setups.filter((s) => s.direction === "bullish")).toHaveLength(0);
  });

  it("mitigated/invalidated zone produces no candidate", () => {
    const dead: Zone = { ...demandZone(), status: "mitigated", freshness: "mitigated" };
    const out = run(BULL, bullAt({ zones: [dead, supplyZone()] }));
    expect(out.setups.filter((s) => s.direction === "bullish")).toHaveLength(0);
  });
});

describe("reversal — invalidation, expiry, cancellation", () => {
  it("close through invalidation → invalidated (close-only, wick safe)", () => {
    const kill: Candle[] = [...BULL.slice(0, 11), c(100.3, 100.6, 97.9, 98.4, 11)];
    const out = run(kill, bullAt());
    expect(out.setups[0].status).toBe("invalidated");
    // wick below the level but close above → never invalidated (the band touch also activates)
    const wickSafe: Candle[] = [...BULL.slice(0, 11), c(100.3, 100.6, 98.0, 99.4, 11)];
    const wickOut = run(wickSafe, bullAt());
    expect(wickOut.setups[0].status).not.toBe("invalidated");
    expect(wickOut.events.every((e) => e.metadata?.transitionReason !== "close_through_invalidation")).toBe(true);
  });

  it("sweep ages beyond sweepMaxAgeBars without confirmation → expired", () => {
    const tail = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((i) => c(101, 101.5, 100.5, 101, i));
    const out = run([...BULL.slice(0, 9), ...tail], bullAt({ dispBar: 99, breakBar: false }));
    const s = out.setups[0];
    expect(s.status).toBe("expired");
    expect(out.events.at(-1)?.metadata?.to).toBe("expired");
  });

  it("opposing confirmed break before confirmation → cancelled", () => {
    const at = (idx: number): ReversalInput => ({
      ...bullAt()(idx),
      structure: structure(idx >= 7 ? [choch("bearish", 7)] : []),
    });
    const out = run(BULL.slice(0, 9), at);
    expect(out.setups[0].status).toBe("cancelled");
  });

  it("countertrend MTF state is a hard veto → cancelled", () => {
    const out = run(BULL.slice(0, 9), bullAt({ mtf: "countertrend_bull" }));
    expect(out.setups[0].status).toBe("cancelled");
    expect(out.events.at(-1)?.metadata?.transitionReason).toBe("mtf_veto_countertrend_bull");
  });

  it("aligned_bull MTF context is acceptable (C8 optional, does not block)", () => {
    const out = run(BULL, bullAt({ mtf: "aligned_bull" }));
    const s = out.setups[0];
    expect(s.reasons.find((r) => r.id === "C8")?.met).toBe(true);
    expect(s.contextTimeframe).toBe("4h");
    expect(s.status).toBe("target_reached");
  });
});

describe("reversal — bearish mirror", () => {
  // Dedicated path: rally into supply [106,108], sweep the 108.5 buy pool, reclaim close
  // stays below the zone's invalidation (~108+0.1×ATR), then bearish leg → CHOCH → retest.
  const BEAR: Candle[] = [
    ...FLAT,
    c(105, 106.4, 104.8, 105.8, 5),  // approach — C1 (high ≥ supply.lowerPrice)
    c(105.8, 108.9, 105.6, 107.9, 6),// sweep buy-side 108.5, reclaim close below — C3/C4
    c(107.9, 108.0, 104.9, 105.0, 7),// bearish displacement leg — C5
    c(105.0, 105.2, 102.9, 103.0, 8),// bearish CHOCH — C6
    c(103.0, 103.4, 102.5, 102.9, 9),
    c(102.9, 107.5, 102.8, 107.2, 10),// re-entry into band [107,108] — C9 → active
    c(107.2, 107.4, 105.8, 106.0, 11),
    c(106.0, 106.2, 105.4, 105.6, 12),// low ≤ 105.5 → T1 → partial_target
    c(105.6, 105.8, 103.9, 104.0, 13),
    c(104.0, 104.2, 100.9, 101.2, 14),// low ≤ 101 → T2 → partial_target
    c(101.2, 101.4, 99.9, 100.1, 15),
    c(100.1, 100.3, 98.4, 98.6, 16), // low ≤ 98.5 → T3 → target_reached
    c(98.6, 99.0, 98.2, 98.8, 17),
    c(98.8, 99.2, 98.4, 99.0, 18),
  ];
  const bearAt = (idx: number): ReversalInput => ({
    zones: [
      { ...supplyZone(), id: "z:sup:9" }, // [106,108] — top of the mirrored range
      { ...demandZone(), id: "z:dem:9" },
    ],
    pools: [
      { ...buyPool(), id: "p:buy:9", price: 108.5, status: "swept", sweptAt: ISO(6), metadata: { sweepConfirmedBar: 6 } },
      { ...sellPool(), id: "p:sell:9", price: 105.5, metadata: {} },
    ],
    structure: structure(idx >= 8 ? [choch("bearish", 8)] : []),
    momentum: idx >= 7 ? mom("bearish", 75) : mom("neutral"),
    imbalances: idx >= 7 ? [{ ...bullFvg(), direction: "bearish" }] : [],
  });

  it("bearish sequence confirms and activates (mirror of bullish)", () => {
    const out = run(BEAR, bearAt);
    const s = out.setups.find((x) => x.direction === "bearish");
    expect(s).toBeDefined();
    expect(s?.status).toBe("target_reached");
    expect(s?.metadata?.targets).toBe("105.5,104.5,101"); // T1 pool, T3 range-low fallback, T2 demand edge — ordered
    const seq = out.events.filter((e) => e.refId === s?.id).map((e) => e.metadata?.to);
    expect(seq).toEqual(["developing", "confirmed", "active", "partial_target", "partial_target", "target_reached"]);
  });

  it("wrong-side liquidity yields no bearish candidate", () => {
    const at = (idx: number): ReversalInput => ({
      ...bearAt(idx),
      pools: [{ ...sellPool(), id: "p:sell:9", price: 108.5, metadata: { sweepConfirmedBar: 6 } }],
    });
    const out = run(BEAR, at);
    expect(out.setups.filter((s) => s.direction === "bearish")).toHaveLength(0);
  });
});

describe("reversal — causality and determinism", () => {
  it("future candles cannot alter a setup's past (full vs prefix replay)", () => {
    const cut = 9;
    const full = run(BULL, bullAt());
    const prefix = run(BULL.slice(0, cut), bullAt());
    const sF = full.setups[0];
    const sP = prefix.setups[0];
    expect(sP.id).toBe(sF.id);
    expect(sP.createdAt).toBe(sF.createdAt);
    // status at bar `cut-1` in the full run, replayed from its event log
    const last = [...full.events].reverse().find((e) => e.refId === sF.id && e.atBar <= cut - 1);
    expect(sP.status).toBe(last?.metadata?.to);
    expect(JSON.stringify(prefix.events)).toBe(JSON.stringify(full.events.filter((e) => e.atBar <= cut - 1)));
  });

  it("lifecycle stamps are causal — prefix replay reproduces every stamp known by bar T", () => {
    // BULL timeline: candidate 5 → confirmed 8 → active 10 → T1 12, T2 14, T3 16 (target_reached).
    const full = run(BULL, bullAt()).setups[0];
    const STAMP = ["candidateBar", "confirmBar", "activeBar",
      "partialTargetBar", "targetReachedBar", "invalidatedBar", "expiredBar", "cancelledBar"] as const;
    for (const cut of [9, 11, 13, 15, 17, 19]) {
      const sP = run(BULL.slice(0, cut), bullAt()).setups[0];
      for (const k of STAMP) {
        const fv = full.metadata?.[k] as number | undefined;
        const pv = sP.metadata?.[k] as number | undefined;
        // every stamp whose bar < cut must appear in the prefix, identical
        if (fv !== undefined && fv < cut) expect(pv, `${k}@${cut}`).toBe(fv);
        // nothing stamped strictly after T may leak into the prefix
        if (pv !== undefined) expect(pv, `${k}@${cut}`).toBeLessThan(cut);
      }
      // targetBars CSV = ordered hit bars; prefix keeps exactly the hits known by cut
      const fT = String(full.metadata?.targetBars ?? "").split(",").filter(Boolean).map(Number);
      const pT = String(sP.metadata?.targetBars ?? "").split(",").filter(Boolean).map(Number);
      expect(pT).toEqual(fT.filter((b) => b < cut));
    }
  });

  it("forming-bar FVG does not satisfy C7 early", () => {
    const out = run(BULL.slice(0, 9), bullAt({ fvgBar: 8 }));
    const s = out.setups[0];
    expect(s.reasons.find((r) => r.id === "C7")?.met).toBe(true); // bar 8 reached in this window
    const early = run(BULL.slice(0, 8), bullAt({ fvgBar: 8 }));
    expect(early.setups[0].reasons.find((r) => r.id === "C7")?.met).toBe(false);
  });

  it("identical replay → byte-identical output (no wall-clock, no random)", () => {
    expect(JSON.stringify(run(BULL, bullAt()))).toBe(JSON.stringify(run(BULL, bullAt())));
  });

  it("no duplicate setups on the same sweep anchor", () => {
    const out = run(BULL, bullAt());
    const ids = out.setups.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("scale invariance — BTC-like and forex-like prices detect identically", () => {
    const scaled = (k: number) => BULL.map((b) => ({
      time: b.time, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k,
    }));
    const at = (k: number) => (idx: number): ReversalInput => {
      const r = bullAt()(idx);
      const mul = (x: number) => x * k;
      return {
        ...r,
        zones: r.zones?.map((z) => ({ ...z, upperPrice: mul(z.upperPrice), lowerPrice: mul(z.lowerPrice) })),
        pools: r.pools?.map((p) => ({ ...p, price: mul(p.price), upperPrice: p.upperPrice && mul(p.upperPrice), lowerPrice: p.lowerPrice && mul(p.lowerPrice) })),
        imbalances: r.imbalances?.map((f) => ({ ...f, upperPrice: mul(f.upperPrice), lowerPrice: mul(f.lowerPrice) })),
        structure: r.structure && {
          ...r.structure,
          keyLevels: r.structure.keyLevels?.map((kl) => ({ ...kl, price: mul(kl.price) })),
          breaks: r.structure.breaks?.map((b) => ({ ...b, price: mul(b.price), refPrice: b.refPrice && mul(b.refPrice) })),
        },
      };
    };
    const base = run(BULL, bullAt()).setups.map((s) => s.status);
    expect(run(scaled(60000 / 105), at(60000 / 105)).setups.map((s) => s.status)).toEqual(base);
    expect(run(scaled(0.01), at(0.01)).setups.map((s) => s.status)).toEqual(base);
  });
});

describe("reversal — missing data stays explicit", () => {
  it("no zones → no candidates; null snapshot → nothing", () => {
    expect(run(BULL, bullAt({ zones: [] })).setups).toHaveLength(0);
    expect(run(BULL, () => null).setups).toHaveLength(0);
  });

  it("missing momentum cannot fabricate C5", () => {
    const at = (idx: number): ReversalInput => ({ ...bullAt()(idx), momentum: undefined });
    const s = run(BULL.slice(0, 9), at).setups[0];
    expect(s.status).toBe("developing");
    expect(s.reasons.find((r) => r.id === "C5")?.met).toBe(false);
  });
});

describe("reversal — engine contract", () => {
  const input = {
    series: { symbol: "T", timeframe: "1h" as const, candles: BULL },
    structure: structure([choch("bullish", 8)]),
    pools: [sellPool(), buyPool()],
    zones: [demandZone(), supplyZone()],
    imbalances: [bullFvg()],
    momentum: mom("bullish", 75),
    config: { ...CFG, breakout: {} as never, continuation: {} as never },
  };

  it("detect — ok, data, deterministic meta", () => {
    const res = createReversalSetupEngine().detect(input);
    expect(res.ok).toBe(true);
    expect(res.meta.stage).toBe("setups");
    expect(res.data?.length).toBe(1);
    expect(res.meta.events.some((e) => e.kind === "setup_transition")).toBe(true);
  });

  it("invalid config → invalid_config, no data", () => {
    const res = createReversalSetupEngine().detect({
      ...input,
      config: { ...input.config, reversal: { ...CFG.reversal, entryZoneDepth: 0 } },
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0].code).toBe("invalid_config");
  });

  it("empty series → ok, empty data", () => {
    const res = createReversalSetupEngine().detect({ ...input, series: { ...input.series, candles: [] } });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual([]);
  });
});
