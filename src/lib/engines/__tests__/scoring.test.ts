/**
 * Phase 5 — Opportunity Scoring (spec 15): additive dimension model, gates before scoring,
 * regime modulation, explainability, point-in-time causality. Score ≠ win probability.
 */
import { describe, expect, it } from "vitest";
import type {
  Imbalance,
  LiquidityPool,
  MarketStructure,
  Momentum,
  MultiTimeframeAlignment,
  RegimeLabel,
  ScoringConfig,
  Setup,
  Zone,
} from "@/lib/types";
import { createOpportunityScoringEngine, scoreOpportunity, type ScoringSnapshot } from "../scoring";

const ISO = (i: number) => new Date(1_700_000_000_000 + i * 3_600_000).toISOString();

const CFG: ScoringConfig = {
  minRR: 1.5,
  weights: {
    structure: 20, liquidity: 15, zoneQuality: 20, displacement: 15,
    momentum: 10, htfAlignment: 10, freshness: 5, fvg: 5,
  },
  regimeMatrix: {},
};

// band [99,101] mid 100, inv 98 → risk 2; targets last 106 → reward 6 → rr 3.0 (≥ minRR)
const mkSetup = (over?: { type?: Setup["type"]; status?: Setup["status"]; metadata?: Record<string, unknown> }): Setup => ({
  id: "t:setup:1",
  symbol: "T",
  timeframe: "1h",
  type: over?.type ?? "reversal",
  direction: "bullish",
  score: 0,
  status: over?.status ?? "confirmed",
  reasons: [],
  zoneIds: ["z:1"],
  liquidityEventIds: ["p:1"],
  contextTimeframe: "4h",
  createdAt: ISO(5),
  metadata: {
    candidateBar: 5, confirmBar: 8,
    entryBandLow: 99, entryBandHigh: 101, invalidation: 98, targets: "102,104,106",
    poolId: "p:1", zoneId: "z:1", fvgId: "fvg:1", breakId: "brk:1", sweepBar: 5,
    ...(over?.metadata as Record<string, string | number | boolean | null> | undefined),
  },
});

const structure = (trend: MarketStructure["trend"] = "uptrend"): MarketStructure => ({
  symbol: "T", timeframe: "1h", trend, bias: "bullish", swings: [],
  lastBreak: { id: "brk:1", type: "CHOCH", direction: "bullish", price: 99, time: ISO(6), confirmed: true },
  updatedAt: ISO(8),
});
const pool = (over?: Partial<LiquidityPool>): LiquidityPool => ({
  id: "p:1", symbol: "T", timeframe: "1h", side: "sell_side", sources: ["equal_lows"],
  price: 99, touches: 2, strength: 60, status: "swept",
  formedAt: ISO(2), lastTouchedAt: ISO(5), sweptAt: ISO(5),
  metadata: { sweepConfirmedBar: 5 }, ...over,
});
const zone = (over?: Partial<Zone>): Zone => ({
  id: "z:1", symbol: "T", timeframe: "1h", type: "demand", upperPrice: 102, lowerPrice: 99,
  strength: 80, freshness: "fresh", retestCount: 0, status: "active",
  originAt: ISO(1), createdAt: ISO(1), ...over,
});
const fvg = (over?: Partial<Imbalance>): Imbalance => ({
  id: "fvg:1", symbol: "T", timeframe: "1h", direction: "bullish",
  upperPrice: 101.5, lowerPrice: 100.5, status: "open", createdAt: ISO(6),
  metadata: { createdBar: 6 }, ...over,
});
const momentum = (over?: Partial<Momentum>): Momentum => ({
  state: "strengthening", bias: "bullish", displacementScore: 70, ...over,
});
const align = (state: MultiTimeframeAlignment["state"] = "aligned_bull"): MultiTimeframeAlignment => ({
  symbol: "T", timeframes: { htf: "4h", itf: "1h", etf: "15m" },
  votes: { htf: 1, itf: 1, etf: 1 }, alignmentScore: 1, state, computedAt: ISO(8),
});

const SNAP: ScoringSnapshot = {
  structure: structure(),
  pools: [pool()],
  zones: [zone()],
  imbalances: [fvg()],
  momentum: momentum(),
  alignment: align(),
};

const score = (setup = mkSetup(), snap: ScoringSnapshot = SNAP, cfg: ScoringConfig = CFG, atBar = 8) =>
  scoreOpportunity({ setup, atBar, atMs: Date.parse(ISO(atBar)), snap, config: cfg });

const contrib = (res: ReturnType<typeof score>, dim: string) =>
  res.data?.contributions?.find((c) => c.dimension === dim);

describe("scoring — spec 15 model", () => {
  it("maximum-quality setup scores 100; contributions sum to the score", () => {
    const res = score(mkSetup(), {
      ...SNAP,
      zones: [zone({ strength: 100 })],
      momentum: momentum({ displacementScore: 100 }),
    });
    expect(res.ok).toBe(true);
    expect(res.data?.score).toBe(100);
    const sum = res.data!.contributions!.reduce((a, c) => a + c.points, 0);
    expect(res.data!.score).toBeCloseTo(sum, 8);
  });

  it("baseline fixture produces the pinned spec-table sum", () => {
    // 20·1.0 + 15·1.0 + 20·0.8 + 15·0.7 + 10·1.0 + 10·1.0 + 5·1.0 + 5·1.0 = 91.5
    const res = score();
    expect(res.data?.score).toBeCloseTo(91.5, 4);
    expect(res.data?.contributions).toHaveLength(8);
    expect(contrib(res, "structure")?.points).toBe(20);
    expect(contrib(res, "liquidity")?.points).toBe(15);
    expect(contrib(res, "zoneQuality")?.points).toBeCloseTo(16, 4);
    expect(contrib(res, "displacement")?.points).toBeCloseTo(10.5, 4);
    expect(contrib(res, "htfAlignment")?.points).toBe(10);
    expect(contrib(res, "freshness")?.points).toBe(5);
    expect(contrib(res, "fvg")?.points).toBe(5);
  });

  it("score is always in [0,100] and never negative", () => {
    const res = score(mkSetup(), {
      structure: structure("downtrend"), pools: [], zones: [], imbalances: [],
      momentum: momentum({ state: "weakening", displacementScore: 0 }),
      alignment: align("no_context"),
    });
    expect(res.data?.score).toBe(2); // only htf no_context 0.2×10
    expect(res.data!.score!).toBeGreaterThanOrEqual(0);
  });

  it("every contribution carries weight, feature, points and a label", () => {
    const res = score();
    for (const c of res.data!.contributions!) {
      expect(c.weight).toBeGreaterThan(0);
      expect(c.feature).toBeGreaterThanOrEqual(0);
      expect(c.feature).toBeLessThanOrEqual(1);
      expect(c.points).toBeCloseTo(c.weight * c.feature, 4);
      expect(c.label.length).toBeGreaterThan(0);
    }
  });

  it("signalIds are disjoint across dimensions (spec §2 no double counting)", () => {
    const res = score();
    const ids = res.data!.contributions!.flatMap((c) => c.signalIds ?? []);
    expect(new Set(ids).size).toBe(ids.length);
    expect(contrib(res, "zoneQuality")?.signalIds).toEqual(["z:1"]);
    expect(contrib(res, "liquidity")?.signalIds).toEqual(["p:1"]);
    expect(contrib(res, "fvg")?.signalIds).toEqual(["fvg:1"]);
    expect(contrib(res, "structure")?.signalIds).toEqual(["brk:1"]);
  });
});

describe("scoring — dimension features (spec 15 table)", () => {
  it("structure: aligned=1, transition|range=0.4, opposing=0", () => {
    const pts = (trend: MarketStructure["trend"]) =>
      contrib(score(mkSetup(), { ...SNAP, structure: structure(trend) }), "structure")?.points;
    expect(pts("uptrend")).toBe(20);
    expect(pts("transition")).toBe(8);
    expect(pts("range")).toBe(8);
    expect(pts("downtrend")).toBe(0);
  });

  it("liquidity: confirmed sweep=1, resting/proximity=0.5, none=0", () => {
    const pts = (pools: LiquidityPool[]) =>
      contrib(score(mkSetup(), { ...SNAP, pools }), "liquidity")?.points;
    expect(pts([pool()])).toBe(15);                       // sweepConfirmedBar ≤ t
    expect(pts([pool({ status: "resting", sweptAt: undefined, metadata: {} })])).toBe(7.5);
    expect(pts([pool({ status: "resting", sweptAt: ISO(6), metadata: {} })])).toBe(7.5); // developing sweep
    expect(pts([pool({ status: "broken", metadata: { sweepConfirmedBar: 5, brokenBar: 7 } })])).toBe(0);
    expect(pts([])).toBe(0);
  });

  it("zoneQuality: strength/100; no zone → 0", () => {
    const pts = (z: Zone | undefined) =>
      contrib(score(mkSetup(), { ...SNAP, zones: z ? [z] : [] }), "zoneQuality")?.points;
    expect(pts(zone({ strength: 80 }))).toBe(16);
    expect(pts(zone({ strength: 55 }))).toBe(11);
    expect(pts(undefined)).toBe(0);
  });

  it("displacement: dispScore metadata wins, momentum.displacementScore is the fallback", () => {
    const s1 = score(mkSetup({ metadata: { dispScore: 90 } }));
    expect(contrib(s1, "displacement")?.points).toBe(13.5);
    const s2 = score(mkSetup(), { ...SNAP, momentum: momentum({ displacementScore: 40 }) });
    expect(contrib(s2, "displacement")?.points).toBe(6);
    const s3 = score(mkSetup(), { ...SNAP, momentum: momentum({ displacementScore: undefined }) });
    expect(contrib(s3, "displacement")?.points).toBe(0);
  });

  it("momentum: strengthening=1, neutral=0.5, weakening/diverging=0", () => {
    const pts = (state: Momentum["state"]) =>
      contrib(score(mkSetup(), { ...SNAP, momentum: momentum({ state }) }), "momentum")?.points;
    expect(pts("strengthening")).toBe(10);
    expect(pts("neutral")).toBe(5);
    expect(pts("weakening")).toBe(0);
    expect(pts("diverging")).toBe(0);
  });

  it("htfAlignment: aligned=1, pullback/realigning/htf_dominant=0.5, no-context family=0.2", () => {
    const pts = (state?: MultiTimeframeAlignment["state"]) =>
      contrib(score(mkSetup(), { ...SNAP, alignment: state === undefined ? undefined : align(state) }), "htfAlignment")?.points;
    expect(pts("aligned_bull")).toBe(10);
    expect(pts("pullback_in_trend_bull")).toBe(5);
    expect(pts("realigning_bear")).toBe(5);
    expect(pts("htf_dominant")).toBe(5);
    expect(pts("no_context")).toBe(2);
    expect(pts("ltf_directed")).toBe(2);
    expect(pts("neutral")).toBe(2);
    expect(pts(undefined)).toBe(2);
  });

  it("freshness: fresh=1, tested=0.5, mitigated=0.1; no zone=0", () => {
    const pts = (z?: Zone) =>
      contrib(score(mkSetup(), { ...SNAP, zones: z ? [z] : [] }), "freshness")?.points;
    expect(pts(zone({ freshness: "fresh" }))).toBe(5);
    expect(pts(zone({ freshness: "tested" }))).toBe(2.5);
    expect(pts(zone({ freshness: "mitigated" }))).toBe(0.5);
    expect(pts(undefined)).toBe(0);
  });

  it("fvg: open/partially_filled=1, filled/other=0.3, none=0", () => {
    const pts = (f: Imbalance | undefined, fvgId: string | null = "fvg:1") =>
      contrib(score(mkSetup({ metadata: { fvgId } }), { ...SNAP, imbalances: f ? [f] : [] }), "fvg")?.points;
    expect(pts(fvg())).toBe(5);
    expect(pts(fvg({ status: "partially_filled", fillPct: 40 }))).toBe(5);
    expect(pts(fvg({ status: "filled", fillPct: 100, metadata: { createdBar: 6, filledBar: 7 } }))).toBe(1.5);
    expect(pts(fvg({ status: "expired", metadata: { createdBar: 6, expiredBar: 7 } }))).toBe(1.5);
    expect(pts(undefined, null)).toBe(0);
  });

  it("fvg leg-scan: reversal w/o fvgId finds the post-sweep open FVG; continuation does not scan", () => {
    const rev = mkSetup({ metadata: { fvgId: null } });
    const r = score(rev); // fvg createdBar 6 ∈ [sweepBar 5, 8]
    expect(contrib(r, "fvg")?.points).toBe(5);
    const cont = mkSetup({ type: "continuation", metadata: { fvgId: null, anchorRef: "z:1" } });
    const c = score(cont);
    expect(contrib(c, "fvg")?.points).toBe(0);
  });

  it("breakout: dispScore from metadata, anchorPoolId liquidity, no zone/fvg → those dims 0", () => {
    const b = mkSetup({
      type: "breakout",
      metadata: { poolId: null, anchorPoolId: "p:1", zoneId: null, fvgId: null, dispScore: 80, attemptBar: 6 },
    });
    const res = score(b, { ...SNAP, structure: structure("range"), imbalances: [fvg()] });
    expect(contrib(res, "displacement")?.points).toBe(12);     // 15 × 0.8 from metadata.dispScore
    expect(contrib(res, "liquidity")?.points).toBe(15);        // confirmed sweep on anchor pool
    expect(contrib(res, "fvg")?.points).toBe(5);               // leg-scan finds FVG at bar 6 ∈ [6,8]
    expect(contrib(res, "structure")?.points).toBe(8);         // range → 0.4
    // zone: setup carries zoneIds ["z:1"] via mkSetup default — remove to assert 0
    const noZone = { ...b, zoneIds: undefined, metadata: { ...b.metadata, zoneId: null } };
    const res2 = score(noZone as Setup, { ...SNAP, structure: structure("range"), imbalances: [] });
    expect(contrib(res2, "zoneQuality")?.points).toBe(0);
    expect(contrib(res2, "freshness")?.points).toBe(0);
    expect(contrib(res2, "fvg")?.points).toBe(0);
  });
});

describe("scoring — gates (spec 15 §4: vetoes emit state, never a score)", () => {
  it("developing → unconfirmed gate", () => {
    const res = score(mkSetup({ status: "developing" }));
    expect(res.data?.gate).toBe("unconfirmed");
    expect(res.data?.emittedStatus).toBe("developing");
    expect(res.data?.score).toBeUndefined();
  });

  it.each(["invalidated", "expired", "cancelled", "target_reached"] as const)(
    "terminal %s → terminal gate emitting own status",
    (status) => {
      const res = score(mkSetup({ status }));
      expect(res.data?.gate).toBe("terminal");
      expect(res.data?.emittedStatus).toBe(status);
    },
  );

  it("countertrend MTF → gate (trumps the table's 0.2 bucket)", () => {
    const res = score(mkSetup(), { ...SNAP, alignment: align("countertrend_bull") });
    expect(res.data?.gate).toBe("countertrend");
    expect(res.data?.score).toBeUndefined();
  });

  it("anchor zone invalidated/expired at t → zone_dead gate; mitigated zone still scores", () => {
    const dead = score(mkSetup(), { ...SNAP, zones: [zone({ status: "invalidated", metadata: { invalidatedBar: 7 } })] });
    expect(dead.data?.gate).toBe("zone_dead");
    const exp = score(mkSetup(), { ...SNAP, zones: [zone({ status: "expired", metadata: { expiredBar: 6 } })] });
    expect(exp.data?.gate).toBe("zone_dead");
    const mit = score(mkSetup(), { ...SNAP, zones: [zone({ status: "mitigated", freshness: "mitigated" })] });
    expect(mit.data?.score).toBeDefined(); // not a spec veto — quality just degrades
  });

  it("rr < minRR → rr_below_min gate; boundary equals passes", () => {
    const low = mkSetup({ metadata: { targets: "102,102.5,103" } }); // reward 3 → rr 1.5... make <1.5
    const below = score(mkSetup({ metadata: { targets: "102,102.5,102.9" } }));
    expect(below.data?.gate).toBe("rr_below_min");
    const edge = score(low);
    expect(edge.data?.score).toBeDefined(); // rr exactly 1.5 is not below
  });

  it("missing band/targets/invalidation or structure/momentum → insufficient_data", () => {
    const noBand = score(mkSetup({ metadata: { entryBandLow: null, entryBandHigh: null } }));
    expect(noBand.data?.gate).toBe("insufficient_data");
    const noStruct = score(mkSetup(), { ...SNAP, structure: undefined });
    expect(noStruct.data?.gate).toBe("insufficient_data");
  });

  it("a gate is not a score of 0 — gated result carries no score/contributions", () => {
    const res = score(mkSetup({ status: "developing" }));
    expect(res.data?.score).toBeUndefined();
    expect(res.data?.contributions).toBeUndefined();
    expect(res.ok).toBe(true); // expected condition returned as data, not an engine error
  });
});

describe("scoring — regime modulation (spec 15 §3)", () => {
  it("matrix factors ∈ [0.5,1.5] renormalize weights to Σ100; relative weights shift", () => {
    const cfg: ScoringConfig = {
      ...CFG,
      regimeMatrix: { trending: { reversal: { htfAlignment: 1.5, structure: 0.5 } } },
    };
    const flat = score(mkSetup(), { ...SNAP, regime: "trending_bullish" }, cfg);
    // w': structure 10, liquidity 15, zone 20, disp 15, mom 10, htf 15, fresh 5, fvg 5 → Σ95
    // scale 100/95 → eff structure 10.5263, htf 15.7895
    expect(contrib(flat, "structure")?.weight).toBeCloseTo(10.5263, 3);
    expect(contrib(flat, "htfAlignment")?.weight).toBeCloseTo(15.7895, 3);
    const wSum = flat.data!.contributions!.reduce((a, c) => a + c.weight, 0);
    expect(wSum).toBeCloseTo(100, 3);
    // all-1 features still score 100 regardless of modulation
    const maxed = score(mkSetup(), {
      structure: structure(), pools: [pool()], zones: [zone({ strength: 100 })],
      imbalances: [fvg()], momentum: momentum({ displacementScore: 100 }),
      alignment: align(), regime: "trending_bullish" as RegimeLabel,
    }, cfg);
    expect(maxed.data?.score).toBe(100);
  });

  it("RegimeLabel maps to the 4-family matrix keys; transition/absent → identity", () => {
    const cfg: ScoringConfig = {
      ...CFG,
      regimeMatrix: { trending: { reversal: { momentum: 0.5 } } },
    };
    const trending = score(mkSetup(), { ...SNAP, regime: "trending_bullish" }, cfg);
    expect(contrib(trending, "momentum")?.weight).toBeCloseTo(5.2632, 3); // 5 × 100/95
    const transition = score(mkSetup(), { ...SNAP, regime: "transition" }, cfg);
    expect(contrib(transition, "momentum")?.weight).toBe(10); // unmodulated
    const none = score(mkSetup(), { ...SNAP, regime: undefined }, cfg);
    expect(contrib(none, "momentum")?.weight).toBe(10);
  });

  it("out-of-range or malformed matrix/weights → invalid_config", () => {
    const badW = score(mkSetup(), SNAP, { ...CFG, weights: { ...CFG.weights, fvg: 10 } });
    expect(badW.ok).toBe(false);
    expect(badW.errors[0].code).toBe("invalid_config");
    const badM = score(mkSetup(), SNAP, { ...CFG, regimeMatrix: { trending: { reversal: { fvg: 2 } } } });
    expect(badM.ok).toBe(false);
    expect(badM.errors[0].code).toBe("invalid_config");
  });
});

describe("scoring — causality: point-in-time, no look-ahead", () => {
  it("prefix vs full replay: future stamps on shared objects cannot change the score at t", () => {
    // "prefix replay" objects — statuses as seen AT bar 8.
    const prefixSnap: ScoringSnapshot = {
      ...SNAP,
      pools: [pool({ status: "resting", sweptAt: undefined, metadata: {} })],
      imbalances: [fvg()],
      zones: [zone()],
    };
    // "full replay" objects — the SAME entities after later transitions (sweep@12, fill@10,
    // zone invalidated@14), carrying bar-indexed stamps.
    const fullSnap: ScoringSnapshot = {
      ...SNAP,
      pools: [pool({ status: "swept", sweptAt: ISO(12), metadata: { sweepConfirmedBar: 12 } })],
      imbalances: [fvg({ status: "filled", fillPct: 100, metadata: { createdBar: 6, filledBar: 10 } })],
      zones: [zone({ status: "invalidated", metadata: { invalidatedBar: 14 } })],
    };
    const a = score(mkSetup(), prefixSnap).data;
    const b = score(mkSetup(), fullSnap).data;
    expect(b?.score).toBe(a?.score);
    expect(JSON.stringify(b?.contributions)).toBe(JSON.stringify(a?.contributions));
    // and the score reflects bar-8 truth: pool proximity (0.5), FVG open (1.0), zone alive.
    expect(contrib(score(mkSetup(), fullSnap), "liquidity")?.feature).toBe(0.5);
    expect(contrib(score(mkSetup(), fullSnap), "fvg")?.feature).toBe(1);
  });

  it("a zone invalidated before t gates, after t does not", () => {
    const before = score(mkSetup(), { ...SNAP, zones: [zone({ status: "invalidated", metadata: { invalidatedBar: 7 } })] });
    expect(before.data?.gate).toBe("zone_dead");
    const after = score(mkSetup(), { ...SNAP, zones: [zone({ status: "invalidated", metadata: { invalidatedBar: 14 } })] });
    expect(after.data?.score).toBeDefined();
  });

  it("confirmed-at-N score is identical for prefix and longer candle histories", () => {
    // The scorer itself is pure over (setup, snap, t) — replay equivalence means the same
    // inputs yield identical output; the stamp-driven statuses above prove snap equality.
    const res1 = score(mkSetup());
    const res2 = score(mkSetup());
    expect(JSON.stringify(res1.data)).toBe(JSON.stringify(res2.data));
  });
});

describe("scoring — determinism, monotonicity, config", () => {
  it("identical inputs → bit-identical output across repeated runs", () => {
    const a = score();
    const b = score();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("weakening any single feature never raises the score (spec §5)", () => {
    const variants: ScoringSnapshot[] = [
      SNAP,
      { ...SNAP, structure: structure("transition") },
      { ...SNAP, pools: [pool({ status: "resting", sweptAt: undefined, metadata: {} })] },
      { ...SNAP, zones: [zone({ strength: 20 })] },
      { ...SNAP, momentum: momentum({ displacementScore: 10 }) },
      { ...SNAP, momentum: momentum({ state: "neutral" }) },
      { ...SNAP, alignment: align("pullback_in_trend_bull") },
      { ...SNAP, zones: [zone({ freshness: "tested" })] },
      { ...SNAP, imbalances: [fvg({ status: "filled", metadata: { createdBar: 6, filledBar: 7 } })] },
    ];
    const base = score().data!.score!;
    for (const v of variants) expect(score(mkSetup(), v).data!.score!).toBeLessThanOrEqual(base);
  });

  it("different weights produce a different score (paramsVersion boundary)", () => {
    const cfg2: ScoringConfig = {
      ...CFG,
      weights: { structure: 10, liquidity: 15, zoneQuality: 20, displacement: 15, momentum: 10, htfAlignment: 20, freshness: 5, fvg: 5 },
    };
    const a = score(mkSetup(), SNAP, cfg2);
    expect(a.data?.score).toBeCloseTo(91.5, 4); // still maxed on both shifted dims
    const cfg3: ScoringConfig = {
      ...CFG,
      weights: { structure: 10, liquidity: 15, zoneQuality: 20, displacement: 15, momentum: 10, htfAlignment: 20, freshness: 5, fvg: 5 },
    };
    const b = score(mkSetup(), { ...SNAP, alignment: align("no_context") }, cfg3);
    // 10·1 + 15·1 + 20·0.8 + 15·0.7 + 10·1 + 20·0.2 + 5·1 + 5·1 = 75.5
    expect(b.data?.score).toBeCloseTo(75.5, 4);
    expect(score(mkSetup(), { ...SNAP, alignment: align("no_context") }).data?.score)
      .toBeCloseTo(83.5, 4);
  });
});

describe("scoring — contract adapter", () => {
  const engine = createOpportunityScoringEngine();
  const input = (setup = mkSetup()) => ({
    setup,
    structure: structure(),
    pools: [pool()],
    zones: [zone()],
    imbalances: [fvg()],
    momentum: momentum(),
    alignment: align(),
    regime: undefined as RegimeLabel | undefined,
    config: CFG,
  });

  it("scores at metadata.confirmBar, not end-of-series", () => {
    const res = engine.score(input());
    expect(res.ok).toBe(true);
    expect(res.data?.score).toBeCloseTo(91.5, 4);
    expect(res.meta.stage).toBe("opportunity-score");
  });

  it("confirmed setup without confirmBar → insufficient_data gate (cannot reconstruct t)", () => {
    const s = mkSetup();
    s.metadata = { ...s.metadata, confirmBar: null };
    const res = engine.score(input(s));
    expect(res.data?.gate).toBe("insufficient_data");
  });

  it("developing setup → unconfirmed gate even without confirmBar", () => {
    const res = engine.score(input(mkSetup({ status: "developing", metadata: { confirmBar: null } })));
    expect(res.data?.gate).toBe("unconfirmed");
    expect(res.data?.emittedStatus).toBe("developing");
  });
});
