import { describe, expect, it } from "vitest";
import type {
  Candle,
  Direction,
  Imbalance,
  LifecycleConfig,
  LiquidityPool,
  MarketStructure,
  Metadata,
  Momentum,
  OpportunityScoreResult,
  ScoreContribution,
  Setup,
  SetupReason,
  SetupStatus,
  SetupType,
  StructureBreak,
  Zone,
} from "@/lib/types";
import { buildTradePlan, createTradePlanEngine, planStateAt } from "../trade-plan";
import { detectReversals, type ReversalInput } from "../reversal";
import { FIXTURE_EPOCH as E } from "@/lib/market-data";

const H1 = 3_600_000;
const ISO = (i: number) => new Date(E + i * H1).toISOString();
const CFG: LifecycleConfig = { expiryBars: 30, invalidateAtr: 0.1 };

// ---- Fixtures ---------------------------------------------------------------

const reason = (id: string, met: boolean): SetupReason => ({
  id, category: "market_structure", label: `cond ${id}`, met,
});
const REASONS: SetupReason[] = [reason("C1", true), reason("C2", true), reason("C3", true)];

const mkSetup = (
  type: SetupType,
  dir: Direction,
  metadata: Metadata,
  reasons: SetupReason[] = REASONS,
  status: SetupStatus = "confirmed",
): Setup => ({
  id: `test:${type}:${dir}`,
  symbol: "T",
  timeframe: "1h",
  type,
  direction: dir,
  score: 80,
  status,
  reasons,
  createdAt: ISO(2),
  updatedAt: ISO(3),
  metadata,
});

const CONTRIBUTIONS: ScoreContribution[] = [
  { dimension: "structure", weight: 20, feature: 0.9, points: 18, label: "BOS aligned" },
  { dimension: "momentum", weight: 15, feature: 0.8, points: 12, label: "displacement" },
];
const SCORE: OpportunityScoreResult = { score: 82, contributions: CONTRIBUTIONS };
const GATED: OpportunityScoreResult = { gate: "rr_below_min", emittedStatus: "cancelled" };

/** Canonical stamped reversal setup: confirmBar 8, active 10, targets hit at 12/14/16. */
const REV_META: Metadata = {
  candidateBar: 5,
  zoneId: "z:dem:0",
  poolId: "p:sell:1",
  fvgId: "fvg:T:1h:bull:7",
  breakId: "brk:bullish:8",
  entryBandLow: 99,
  entryBandHigh: 100.5,
  invalidation: 98.5,
  targets: "104.5,106,110",
  confirmBar: 8,
  activeBar: 10,
  targetBars: "12,14,16",
  targetReachedBar: 16,
  partialTargetBar: 14,
};

const build = (over: Partial<Parameters<typeof buildTradePlan>[0]> = {}) =>
  buildTradePlan({
    setup: mkSetup("reversal", "bullish", { ...REV_META }),
    score: SCORE,
    atIndex: 11,
    config: CFG,
    ...over,
  });

// ---- Happy paths ------------------------------------------------------------

describe("spec 28 — happy paths per setup family", () => {
  it("reversal: assembles band/basis/invalidation/targets/score verbatim", () => {
    const r = build({ atIndex: 11 });
    expect(r.ok).toBe(true);
    const p = r.data!.plan;
    expect(p.setupId).toBe("test:reversal:bullish");
    expect(p.symbol).toBe("T");
    expect(p.timeframe).toBe("1h");
    expect(p.direction).toBe("bullish");
    expect(p.entryZone).toEqual({ low: 99, high: 100.5, basis: "demand zone z:dem:0 proximal band" });
    expect(p.invalidation).toEqual({ price: 98.5, basis: "zone z:dem:0 distal boundary", closeOnly: true });
    expect(p.targets.map((t) => t.label)).toEqual(["T1", "T2", "T3"]);
    expect(p.targets.map((t) => t.price)).toEqual([104.5, 106, 110]);
    expect(p.score).toBe(82);
    expect(p.scoreContributions).toEqual(CONTRIBUTIONS);
    expect(p.reasons).toEqual(REASONS);
    expect(p.expiryBars).toBe(30);
    expect(p.paramsVersion).toBe("exp30");
    expect(p.final).toBeUndefined();
  });

  it("reversal bearish: supply basis + mirrored RR", () => {
    const meta: Metadata = {
      ...REV_META,
      entryBandLow: 99.5,
      entryBandHigh: 101,
      invalidation: 101.5,
      targets: "96,95,90",
    };
    const r = build({
      setup: mkSetup("reversal", "bearish", { ...meta, zoneId: "z:sup:0" }),
      atIndex: 11,
    });
    const p = r.data!.plan;
    expect(p.entryZone.basis).toBe("supply zone z:sup:0 proximal band");
    expect(p.invalidation.basis).toBe("zone z:sup:0 distal boundary");
    expect(p.riskReward).toBeCloseTo(8.2, 10); // mid 100.25, risk 1.25, reward 10.25
  });

  it("breakout: range-boundary basis from stamped evidence", () => {
    const meta: Metadata = {
      candidateBar: 4,
      rangeKey: "p:pool:3",
      boundary: 105,
      anchorPoolId: "p:pool:3",
      entryBandLow: 104.75,
      entryBandHigh: 105.25,
      invalidation: 104.5,
      targets: "106,108",
      confirmBar: 8,
      activeBar: 9,
    };
    const r = build({
      setup: mkSetup("breakout", "bullish", meta),
      atIndex: 9,
    });
    const p = r.data!.plan;
    expect(p.entryZone.basis).toBe("range p:pool:3 boundary 105");
    expect(p.invalidation.basis).toBe("range p:pool:3 boundary 105 ±ATR");
    expect(p.targets.map((t) => t.label)).toEqual(["T1", "T2"]);
  });

  it("continuation: pullback band basis + targets", () => {
    const meta: Metadata = {
      candidateBar: 3,
      impulseTop: 112,
      pullbackExtreme: 107.5,
      t3PoolId: "p:buy:9",
      entryBandLow: 107,
      entryBandHigh: 108,
      invalidation: 106.9,
      targets: "112,120,125",
      confirmBar: 6,
    };
    const r = build({
      setup: mkSetup("continuation", "bullish", meta),
      atIndex: 6,
    });
    const p = r.data!.plan;
    expect(p.entryZone.basis).toBe("pullback extreme 107.5 band");
    expect(p.invalidation.basis).toBe("pullback 107.5 ±ATR");
    expect(p.targets).toHaveLength(3);
  });

  it("createdAt: atMs → ISO; absent → setup.createdAt fallback", () => {
    const withMs = build({ atMs: E + 11 * H1 });
    expect(withMs.data!.plan.createdAt).toBe(ISO(11));
    const without = build({ atIndex: 11 });
    expect(without.data!.plan.createdAt).toBe(ISO(2)); // setup.createdAt
  });
});

// ---- Status reconstruction --------------------------------------------------

describe("spec 28 — status-at-t reconstruction from lifecycle stamps", () => {
  const noTerminal = { ...REV_META };
  delete noTerminal.targetReachedBar;

  it.each<[string, Metadata, number, SetupStatus | undefined, boolean | undefined]>([
    ["developing (no confirmBar) → unavailable", { ...REV_META, confirmBar: 40 }, 11, undefined, undefined],
    ["confirmBar > atIndex → unavailable", REV_META, 7, undefined, undefined],
    ["confirmed only → confirmed plan", { ...noTerminal, activeBar: 40, partialTargetBar: 40, targetBars: "40" }, 9, "confirmed", undefined],
    ["activeBar ≤ t → active", { ...noTerminal, partialTargetBar: 40, targetBars: "40" }, 11, "active", undefined],
    ["partialTargetBar ≤ t → partial_target", noTerminal, 14, "partial_target", undefined],
    ["targetReachedBar ≤ t → final", REV_META, 18, "target_reached", true],
    ["invalidatedBar ≤ t → final", { ...noTerminal, invalidatedBar: 15 }, 15, "invalidated", true],
    ["expiredBar ≤ t → final", { ...noTerminal, expiredBar: 20 }, 21, "expired", true],
    ["cancelledBar ≤ t → final", { ...noTerminal, cancelledBar: 13 }, 13, "cancelled", true],
    ["future terminal stamp > t → not final", REV_META, 11, "active", undefined],
  ])("%s", (_n, metadata, atIndex, wantStatus, wantFinal) => {
    const r = build({ setup: mkSetup("reversal", "bullish", { ...metadata }), atIndex });
    if (wantStatus === undefined) {
      expect(r.ok).toBe(false);
      expect(r.errors[0].code).toBe("unavailable");
    } else {
      expect(r.ok).toBe(true);
      expect(r.data!.plan.final).toBe(wantFinal);
      expect(r.meta.diagnostics?.statusAt).toBe(wantStatus);
    }
  });

  it("never reads setup.status — final-series terminal invisible at early t", () => {
    // setup.status says target_reached (end of series) but atIndex precedes every terminal stamp.
    const s = mkSetup("reversal", "bullish", { ...REV_META }, REASONS, "target_reached");
    const r = build({ setup: s, atIndex: 9 });
    expect(r.ok).toBe(true);
    expect(r.data!.plan.final).toBeUndefined();
    expect(r.meta.diagnostics?.statusAt).toBe("confirmed");
  });
});

// ---- Score gating -----------------------------------------------------------

describe("spec 28 — score source (spec 15 authoritative)", () => {
  it.each<[string, OpportunityScoreResult]>([
    ["gated → unavailable", GATED],
    ["gate without emittedStatus → unavailable", { gate: "unconfirmed" }],
    ["score undefined, no gate → unavailable", {}],
    ["NaN score → unavailable", { score: NaN, contributions: CONTRIBUTIONS }],
    ["empty contributions → unavailable", { score: 82, contributions: [] }],
    ["missing contributions → unavailable", { score: 82 }],
  ])("%s", (_n, score) => {
    const r = build({ score });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe("unavailable");
    expect(r.data).toBeUndefined();
  });

  it("score/contributions passed verbatim — never recomputed", () => {
    const p = build().data!.plan;
    expect(p.score).toBe(82);
    expect(p.scoreContributions).toBe(CONTRIBUTIONS);
    expect(p.scoreContributions[0].dimension).toBe("structure");
  });
});

// ---- RR ---------------------------------------------------------------------

describe("spec 28 — risk/reward", () => {
  it("bullish: (finalTarget − mid) / (mid − invalidation)", () => {
    // mid = 99.75, risk = 1.25, reward = 110 − 99.75 = 10.25 → 8.2
    expect(build().data!.plan.riskReward).toBeCloseTo(8.2, 10);
  });

  it("bearish: mirrored", () => {
    const meta: Metadata = {
      ...REV_META, entryBandLow: 98, entryBandHigh: 100, invalidation: 100.5, targets: "97,96,95",
    };
    const p = build({ setup: mkSetup("reversal", "bearish", meta) }).data!.plan;
    // mid = 99, risk = 1.5, reward = 4 → 2.6667
    expect(p.riskReward).toBeCloseTo(4 / 1.5, 10);
  });

  it.each<[string, Direction, Metadata]>([
    ["zero risk (mid == invalidation) bullish", "bullish", { ...REV_META, entryBandLow: 98, entryBandHigh: 100, invalidation: 99 }],
    ["negative risk bullish (inv above mid)", "bullish", { ...REV_META, invalidation: 101 }],
    ["zero risk bearish (inv == mid)", "bearish", { ...REV_META, entryBandLow: 98, entryBandHigh: 100, invalidation: 99 }],
    ["negative risk bearish (inv below mid)", "bearish", { ...REV_META, entryBandLow: 98, entryBandHigh: 100, invalidation: 98.5 }],
  ])("%s → invalid_input", (_n, dir, metadata) => {
    const r = build({ setup: mkSetup("reversal", dir, metadata) });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe("invalid_input");
  });
});

// ---- Targets ----------------------------------------------------------------

describe("spec 28 — targets and reachability", () => {
  it.each<[number, boolean[]]>([
    [8, [false, false, false]],
    [11, [false, false, false]],
    [12, [true, false, false]],
    [14, [true, true, false]],
    [16, [true, true, true]],
    [40, [true, true, true]],
  ])("atIndex %d → reached %s", (atIndex, reached) => {
    const p = build({ atIndex }).data!.plan;
    expect(p.targets.map((t) => t.reached)).toEqual(reached);
    expect(p.targets.map((t) => t.label)).toEqual(["T1", "T2", "T3"]);
  });

  it("future targetBar never marked reached", () => {
    const p = build({ atIndex: 15 }).data!.plan;
    expect(p.targets[2].reached).toBe(false); // targetBars[2]=16 > 15
  });

  it("targetBars absent → all unreached (targets still emitted)", () => {
    const meta = { ...REV_META };
    delete meta.targetBars;
    const p = build({ setup: mkSetup("reversal", "bullish", meta) }).data!.plan;
    expect(p.targets.every((t) => t.reached === false)).toBe(true);
  });

  it.each<[string, string | undefined, "insufficient_data" | "invalid_input"]>([
    ["missing targets key", undefined, "insufficient_data"],
    ["empty targets CSV", "", "insufficient_data"],
    ["non-numeric token", "104,abc,110", "invalid_input"],
    ["NaN token", "104,NaN,110", "invalid_input"],
    ["Infinity token", "104,Infinity,110", "invalid_input"],
    ["trailing garbage", "104,106,1.5x", "invalid_input"],
  ])("%s → %s", (_n, targets, code) => {
    const meta = { ...REV_META };
    if (targets === undefined) delete meta.targets;
    else meta.targets = targets;
    const r = build({ setup: mkSetup("reversal", "bullish", meta) });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe(code);
  });

  it("malformed targetBars CSV → invalid_input", () => {
    const r = build({ setup: mkSetup("reversal", "bullish", { ...REV_META, targetBars: "12,x,16" }) });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe("invalid_input");
  });
});

// ---- Missing / invalid stamped data -----------------------------------------

describe("spec 28 — missing/invalid stamped evidence", () => {
  it.each<[string, Metadata]>([
    ["entryBandLow missing", { ...REV_META, entryBandLow: undefined } as unknown as Metadata],
    ["entryBandHigh missing", { ...REV_META, entryBandHigh: undefined } as unknown as Metadata],
    ["invalidation missing", { ...REV_META, invalidation: undefined } as unknown as Metadata],
  ])("%s → insufficient_data", (_n, metadata) => {
    const clean = { ...metadata };
    for (const k of Object.keys(clean)) if (clean[k] === undefined) delete clean[k];
    const r = build({ setup: mkSetup("reversal", "bullish", clean) });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe("insufficient_data");
  });

  it.each<[string, Metadata]>([
    ["NaN entryBandLow", { ...REV_META, entryBandLow: NaN }],
    ["Infinity entryBandHigh", { ...REV_META, entryBandHigh: Infinity }],
    ["-Infinity invalidation", { ...REV_META, invalidation: -Infinity }],
    ["inverted band (low > high)", { ...REV_META, entryBandLow: 102, entryBandHigh: 99 }],
  ])("%s → invalid_input", (_n, metadata) => {
    const r = build({ setup: mkSetup("reversal", "bullish", metadata) });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe("invalid_input");
  });
});

// ---- Configuration ----------------------------------------------------------

describe("spec 28 — configuration validation", () => {
  it.each<[string, LifecycleConfig]>([
    ["expiryBars = 0", { ...CFG, expiryBars: 0 }],
    ["expiryBars negative", { ...CFG, expiryBars: -5 }],
    ["expiryBars NaN", { ...CFG, expiryBars: NaN }],
    ["expiryBars +Infinity", { ...CFG, expiryBars: Infinity }],
  ])("%s → invalid_config", (_n, config) => {
    const r = build({ config });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe("invalid_config");
  });

  it("expiryBars flows through; invalidateAtr unconsumed", () => {
    const p = build({ config: { expiryBars: 12, invalidateAtr: 999 } }).data!.plan;
    expect(p.expiryBars).toBe(12);
    expect(p.paramsVersion).toBe("exp12");
  });

  it.each<[string, number]>([
    ["atIndex -1", -1],
    ["atIndex 2.5", 2.5],
    ["atIndex NaN", NaN],
  ])("%s → invalid_input", (_n, atIndex) => {
    const r = build({ atIndex });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe("invalid_input");
  });
});

// ---- Reasons / conditionsPending --------------------------------------------

describe("spec 28 — reasons and conditionsPending", () => {
  it("all met → conditionsPending absent (optional field, not forced)", () => {
    const p = build().data!.plan;
    expect(p.conditionsPending).toBeUndefined();
    expect(p.reasons).toEqual(REASONS);
  });

  it("unmet reasons → conditionsPending emitted, reasons verbatim, source unmutated", () => {
    const reasons = [reason("C1", true), reason("C4", false), reason("C5", false)];
    const setup = mkSetup("reversal", "bullish", { ...REV_META }, reasons);
    const p = build({ setup }).data!.plan;
    expect(p.reasons).toEqual(reasons);
    expect(p.conditionsPending?.map((r) => r.id)).toEqual(["C4", "C5"]);
    expect(reasons.filter((r) => !r.met)).toHaveLength(2); // source untouched
  });
});

// ---- Causality: real upstream pipeline, prefix vs full ----------------------

const c = (o: number, h: number, l: number, cl: number, i: number): Candle => ({
  time: E + i * H1, open: o, high: h, low: l, close: cl,
});
// Same bullish textbook series as reversal.test.ts — setup confirms at 8, activates at 10,
// targets hit at 12/14/16, target_reached at 16.
const BULL: Candle[] = [
  ...[0, 1, 2, 3, 4].map((i) => c(105, 105.5, 104.5, 105, i)),
  c(105, 105.4, 100.8, 101.5, 5),
  c(101.5, 101.6, 98.5, 100.2, 6),
  c(100.2, 101.8, 99.9, 101.6, 7),
  c(101.6, 103.4, 101.4, 103.2, 8),
  c(103.2, 103.5, 102.4, 103.0, 9),
  c(103.0, 103.2, 99.5, 100.3, 10),
  c(100.3, 102.4, 100.1, 102.2, 11),
  c(102.2, 104.8, 102.0, 104.4, 12),
  c(104.4, 104.6, 103.0, 103.6, 13),
  c(103.6, 106.5, 103.4, 106.2, 14),
  c(106.2, 106.4, 105.0, 105.6, 15),
  c(105.6, 110.5, 105.4, 110.1, 16),
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
const sellPool = (): LiquidityPool => ({
  id: "p:sell:1", symbol: "T", timeframe: "1h", side: "sell_side", sources: ["swing_low"],
  price: 99.5, touches: 2, strength: 60, status: "swept",
  formedAt: ISO(2), lastTouchedAt: ISO(2), sweptAt: ISO(6),
  metadata: { sweepConfirmedBar: 6, sweepConfirmedAt: ISO(6) },
});
const buyPool = (): LiquidityPool => ({
  id: "p:buy:1", symbol: "T", timeframe: "1h", side: "buy_side", sources: ["swing_high"],
  price: 104.5, touches: 2, strength: 60, status: "resting", formedAt: ISO(2), lastTouchedAt: ISO(2),
});
const choch = (): StructureBreak => ({
  id: "brk:bullish:8", type: "CHOCH", direction: "bullish", price: 103, time: ISO(8),
  confirmed: true, refPrice: 103, breakIndex: 8,
});
const structure = (breaks: StructureBreak[]): MarketStructure => ({
  symbol: "T", timeframe: "1h", trend: "range", bias: "neutral", swings: [], breaks,
  keyLevels: [{ label: "HH", price: 110 }], updatedAt: ISO(18),
});
const mom = (bias: "bullish" | "neutral", disp?: number): Momentum => ({
  state: "neutral", bias, displacementScore: disp,
});
const bullFvg = (): Imbalance => ({
  id: "fvg:T:1h:bull:7", symbol: "T", timeframe: "1h", direction: "bullish",
  upperPrice: 101.8, lowerPrice: 101.6, status: "open", createdAt: ISO(7),
});
const at = (idx: number): ReversalInput => ({
  zones: [demandZone(), supplyZone()],
  pools: [sellPool(), buyPool()],
  structure: structure(idx >= 8 ? [choch()] : []),
  momentum: idx >= 7 ? mom("bullish", 75) : mom("neutral"),
  imbalances: idx >= 7 ? [bullFvg()] : [],
});
const runRev = (candles: Candle[]) =>
  detectReversals({ candles, symbol: "T", timeframe: "1h", at, config: { lifecycle: CFG, reversal: { zoneMaxAgeBars: 500, zoneMinStrength: 50, sweepMaxAgeBars: 10, dispMinScore: 60, entryZoneDepth: 0.5, invalidateAtr: 0.1 } } });

describe("spec 28 — causal point-in-time equivalence", () => {
  it("planStateAt(t) identical on prefix-detected vs full-detected setup", () => {
    const t = 11; // active but pre-T1 — full-series setup carries future stamps
    const pre = runRev(BULL.slice(0, t + 1));
    const full = runRev(BULL);
    const ps = pre.setups[0];
    const fs = full.setups.find((x) => x.id === ps.id)!;
    expect(ps).toBeDefined();
    expect(fs).toBeDefined();
    // The full-series artifact genuinely carries post-t stamps — filtering must hide them.
    expect(fs.metadata?.targetReachedBar).toBe(16);
    expect(fs.metadata?.targetBars).toBe("12,14,16");

    const pPre = planStateAt(ps, SCORE, t, CFG);
    const pFull = planStateAt(fs, SCORE, t, CFG);
    expect(pPre).toBeDefined();
    expect(pPre).toEqual(pFull);
    expect(pFull!.targets.every((x) => !x.reached)).toBe(true);
    expect(pFull!.final).toBeUndefined();
  });

  it("prefix equivalence at terminal t too (full series resolves later identically)", () => {
    const t = 17;
    const pre = runRev(BULL.slice(0, t + 1));
    const full = runRev(BULL);
    const ps = pre.setups[0];
    const fs = full.setups.find((x) => x.id === ps.id)!;
    const pPre = planStateAt(ps, SCORE, t, CFG);
    const pFull = planStateAt(fs, SCORE, t, CFG);
    expect(pPre).toEqual(pFull);
    expect(pFull!.final).toBe(true);
    expect(pFull!.targets.every((x) => x.reached)).toBe(true);
  });
});

// ---- Determinism / adapter / metadata ---------------------------------------

describe("spec 28 — determinism, adapter parity, metadata", () => {
  it("deterministic: identical inputs → deep-equal results", () => {
    expect(build()).toEqual(build());
    expect(planStateAt(mkSetup("reversal", "bullish", { ...REV_META }), SCORE, 11, CFG)).toEqual(
      planStateAt(mkSetup("reversal", "bullish", { ...REV_META }), SCORE, 11, CFG),
    );
  });

  it("planStateAt degrades non-ok to undefined — never throws", () => {
    expect(planStateAt(mkSetup("reversal", "bullish", { candidateBar: 5 }), SCORE, 11, CFG)).toBeUndefined();
    expect(planStateAt(mkSetup("reversal", "bullish", { ...REV_META }), GATED, 11, CFG)).toBeUndefined();
  });

  it("createTradePlanEngine().build === buildTradePlan", () => {
    const engine = createTradePlanEngine();
    const input = { setup: mkSetup("reversal", "bullish", { ...REV_META }), score: SCORE, atIndex: 11, config: CFG };
    expect(engine.build(input)).toEqual(buildTradePlan(input));
  });

  it("meta: stage/paramsVersion/barsConsumed/events/diagnostics", () => {
    const r = build({ atIndex: 14 });
    expect(r.meta.stage).toBe("plan");
    expect(r.meta.paramsVersion).toBe("exp30");
    expect(r.meta.barsConsumed).toEqual({ from: -1, to: -1 });
    expect(r.meta.events).toEqual([]);
    expect(r.meta.diagnostics).toEqual({
      statusAt: "partial_target",
      targetsTotal: 3,
      targetsReached: 2,
      final: false,
    });
  });

  it("error result carries meta but no data", () => {
    const r = build({ score: GATED });
    expect(r.ok).toBe(false);
    expect(r.data).toBeUndefined();
    expect(r.meta.stage).toBe("plan");
    expect(r.errors).toHaveLength(1);
  });
});
