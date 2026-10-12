import { describe, expect, it } from "vitest";
import type {
  ProbabilityEstimate,
  ScanCandidate,
  ScannerConfig,
  ScanUniverse,
  Setup,
  SetupStatus,
  StatisticalEvidence,
} from "@/lib/types";
import { scanUniverse } from "../scanner";

// ---- Fixtures ----------------------------------------------------------------
const T0 = Date.parse("2026-01-01T00:00:00Z");
const H = 3_600_000;

const CFG: ScannerConfig = { topK: 0, includeDeveloping: false, methodVersion: "v1-scan" };
const UNI: ScanUniverse = { symbols: ["AAA", "BBB"], timeframes: ["15m", "1h"] };

let seq = 0;
const mkSetup = (o: Partial<Setup> = {}): Setup => ({
  id: `set${seq++}`,
  symbol: "AAA",
  timeframe: "15m",
  type: "reversal",
  direction: "bullish",
  score: 80,
  status: "confirmed" as SetupStatus,
  reasons: [],
  createdAt: new Date(T0 - H).toISOString(),
  ...o,
});

const mkCand = (o: Omit<Partial<ScanCandidate>, "setup"> & { setup?: Partial<Setup> } = {}): ScanCandidate => {
  const { setup, ...rest } = o;
  const s = mkSetup(setup);
  return {
    setup: s,
    score: { score: s.score },
    cell: { symbol: s.symbol, timeframe: s.timeframe },
    provenance: { evaluatedAt: T0 - H, evaluatedBar: 9 },
    ...rest,
  };
};

const mkEvidence = (o: Partial<StatisticalEvidence> = {}): StatisticalEvidence => ({
  decisionTime: T0,
  estimate: {
    cohortKey: "*",
    cohortLevel: 4,
    sampleSize: 40,
    pTarget: [0.5, 0.3, 0.1],
    pStop: 0.4,
    pExpired: 0.1,
    expectancyR: 0.12,
    methodVersion: "v1-empirical",
    paramsVersion: "v5|ms30|sb0-50-70-85",
  } satisfies ProbabilityEstimate,
  ...o,
});

const scan = (candidates: ScanCandidate[], extra: Partial<Parameters<typeof scanUniverse>[0]> = {}) =>
  scanUniverse({ asOf: T0, universe: UNI, candidates, config: CFG, ...extra });

// ---- Basic --------------------------------------------------------------------
describe("scanner — basic", () => {
  it("one eligible candidate → rank 1 with projected fields", () => {
    const c = mkCand({ setup: { score: 77 }, plan: { entry: 100, stopLoss: 95, riskReward: 2.4 } });
    const r = scan([c]);
    expect(r.ok).toBe(true);
    const item = r.data!.ranked[0];
    expect(item.rank).toBe(1);
    expect(item.score).toBe(77);
    expect(item.entry).toBe(100);
    expect(item.riskReward).toBe(2.4);
    expect(item.setupId).toBe(c.setup.id);
  });

  it("empty candidates → ok with empty lists, not a failure", () => {
    const r = scan([]);
    expect(r.ok).toBe(true);
    expect(r.data?.ranked).toEqual([]);
    expect(r.data?.developing).toEqual([]);
    expect(r.meta.diagnostics?.candidatesIn).toBe(0);
  });

  it("empty universe → cellsEvaluated 0, still ok", () => {
    const r = scan([mkCand()], { universe: { symbols: [], timeframes: [] } });
    expect(r.ok).toBe(true);
    expect(r.meta.diagnostics?.cellsEvaluated).toBe(0);
  });
});

// ---- Eligibility ----------------------------------------------------------------
describe("scanner — eligibility", () => {
  it.each(["confirmed", "active", "partial_target"] as SetupStatus[])(
    "rankable status %s with a score is ranked", (status) => {
      const r = scan([mkCand({ setup: { status } })]);
      expect(r.data?.ranked).toHaveLength(1);
    },
  );

  it.each(["target_reached", "invalidated", "expired", "cancelled"] as SetupStatus[])(
    "terminal status %s is excluded", (status) => {
      const r = scan([mkCand({ setup: { status } })]);
      expect(r.data?.ranked).toHaveLength(0);
      expect(r.meta.diagnostics?.terminal).toBe(1);
    },
  );

  it("gated score result is excluded as gated", () => {
    const c = mkCand();
    c.score = { gate: "countertrend" };
    const r = scan([c]);
    expect(r.data?.ranked).toHaveLength(0);
    expect(r.meta.diagnostics?.gated).toBe(1);
  });

  it("rankable status without score or gate → unrankable", () => {
    const c = mkCand();
    c.score = {};
    const r = scan([c]);
    expect(r.data?.ranked).toHaveLength(0);
    expect(r.meta.diagnostics?.unrankable).toBe(1);
  });
});

// ---- Filters --------------------------------------------------------------------
describe("scanner — filters narrow membership, never order", () => {
  const a = mkCand({ setup: { symbol: "AAA", type: "reversal", direction: "bullish", score: 90 } });
  const b = mkCand({ setup: { symbol: "BBB", timeframe: "1h", type: "breakout", direction: "bearish", score: 80, status: "active" } });

  it("symbols filter", () => {
    expect(scan([a, b], { filters: { symbols: ["AAA"] } }).data?.ranked).toHaveLength(1);
  });
  it("timeframes filter", () => {
    expect(scan([a, b], { filters: { timeframes: ["1h"] } }).data?.ranked[0].timeframe).toBe("1h");
  });
  it("setupTypes filter", () => {
    expect(scan([a, b], { filters: { setupTypes: ["breakout"] } }).data?.ranked[0].setupType).toBe("breakout");
  });
  it("directions filter", () => {
    expect(scan([a, b], { filters: { directions: ["bearish"] } }).data?.ranked[0].direction).toBe("bearish");
  });
  it("statuses filter", () => {
    expect(scan([a, b], { filters: { statuses: ["active"] } }).data?.ranked[0].status).toBe("active");
  });
  it("minScore filter", () => {
    expect(scan([a, b], { filters: { minScore: 85 } }).data?.ranked).toHaveLength(1);
  });
  it("filters do not reorder — survivors keep score order", () => {
    const lo = mkCand({ setup: { symbol: "AAA", score: 60 } });
    const hi = mkCand({ setup: { symbol: "AAA", score: 95 } });
    const r = scan([lo, hi], { filters: { symbols: ["AAA"] } });
    expect(r.data?.ranked.map((x) => x.score)).toEqual([95, 60]);
  });
});

// ---- Ranking --------------------------------------------------------------------
describe("scanner — ranking & tie-breaks", () => {
  it("score descending", () => {
    const r = scan([
      mkCand({ setup: { score: 50 } }),
      mkCand({ setup: { score: 90 } }),
      mkCand({ setup: { score: 70 } }),
    ]);
    expect(r.data?.ranked.map((x) => [x.score, x.rank])).toEqual([[90, 1], [70, 2], [50, 3]]);
  });

  it("tie → symbol asc", () => {
    const r = scan([
      mkCand({ setup: { symbol: "BBB", score: 80 } }),
      mkCand({ setup: { symbol: "AAA", score: 80 } }),
    ]);
    expect(r.data?.ranked.map((x) => x.symbol)).toEqual(["AAA", "BBB"]);
  });

  it("tie → timeframe canonical order", () => {
    const r = scan([
      mkCand({ setup: { symbol: "AAA", timeframe: "1h", score: 80 } }),
      mkCand({ setup: { symbol: "AAA", timeframe: "15m", score: 80 } }),
    ]);
    expect(r.data?.ranked.map((x) => x.timeframe)).toEqual(["15m", "1h"]);
  });

  it("tie → setupId asc", () => {
    const c1 = mkCand({ setup: { score: 80 } });
    const c2 = mkCand({ setup: { score: 80 } });
    c1.setup.id = "zzz";
    c2.setup.id = "aaa";
    const r = scan([c1, c2]);
    expect(r.data?.ranked.map((x) => x.setupId)).toEqual(["aaa", "zzz"]);
  });

  it("statistical evidence never reorders — score remains the key", () => {
    const weak = mkCand({ setup: { score: 90 }, statisticalEvidence: mkEvidence() });
    const strong = mkCand({ setup: { score: 60 }, statisticalEvidence: mkEvidence({ estimate: { ...mkEvidence().estimate!, expectancyR: 9, pTarget: [1, 1, 1] } }) });
    const r = scan([strong, weak]);
    expect(r.data?.ranked.map((x) => x.score)).toEqual([90, 60]);
  });
});

// ---- Deduplication -----------------------------------------------------------------
describe("scanner — deduplication", () => {
  it("duplicate setupId → freshest evaluatedAt wins", () => {
    const old = mkCand({ setup: { score: 50 }, provenance: { evaluatedAt: T0 - 5 * H } });
    const fresh = mkCand({ setup: { score: 50 }, provenance: { evaluatedAt: T0 - H } });
    old.setup.id = fresh.setup.id; // same detection instance
    const r = scan([old, fresh]);
    expect(r.data?.ranked).toHaveLength(1);
    expect(r.meta.diagnostics?.duplicatesDropped).toBe(1);
    expect(r.meta.diagnostics?.duplicateSetupIds).toBe(old.setup.id);
    expect(r.data?.ranked[0].setupId).toBe(fresh.setup.id);
  });

  it("same evaluatedAt → higher score wins", () => {
    const lo = mkCand({ setup: { score: 40 } });
    const hi = mkCand({ setup: { score: 90 } });
    lo.setup.id = hi.setup.id;
    const r = scan([lo, hi]);
    expect(r.data?.ranked[0].score).toBe(90);
  });

  it("identical key fields → stable serialization decides, permutation-independently", () => {
    const x = mkCand({ setup: { score: 80, direction: "bearish" } });
    const y = mkCand({ setup: { score: 80, direction: "bullish" } });
    x.setup.id = y.setup.id;
    const r1 = scan([x, y]).data!.ranked;
    const r2 = scan([y, x]).data!.ranked;
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(r1).toHaveLength(1);
  });

  it("different setupIds on the same cell are NOT deduplicated", () => {
    const r = scan([
      mkCand({ setup: { type: "reversal" } }),
      mkCand({ setup: { type: "continuation" } }),
    ]);
    expect(r.data?.ranked).toHaveLength(2);
    expect(r.meta.diagnostics?.duplicatesDropped).toBe(0);
  });
});

// ---- Developing -----------------------------------------------------------------
describe("scanner — developing bucket", () => {
  const dev = mkCand({ setup: { status: "developing", reasons: [
    { id: "r1", category: "liquidity", label: "sweep", met: false },
    { id: "r2", category: "market_structure", label: "choch", met: true },
  ] } });

  it("includeDeveloping=false → developing excluded, counted unrankable", () => {
    const r = scan([dev]);
    expect(r.data?.developing).toHaveLength(0);
    expect(r.meta.diagnostics?.unrankable).toBe(1);
  });

  it("includeDeveloping=true → surfaced separately, never ranked, no score/probability", () => {
    const r = scan([dev, mkCand()], { config: { ...CFG, includeDeveloping: true } });
    expect(r.data?.developing).toHaveLength(1);
    expect(r.data?.ranked).toHaveLength(1);
    const d = r.data!.developing[0];
    expect(d.setupId).toBe(dev.setup.id);
    expect(d.reasons?.every((x) => !x.met)).toBe(true); // unmet only
    expect("score" in d).toBe(false);
    expect("rank" in d).toBe(false);
    expect("statisticalEvidence" in d).toBe(false);
    expect(r.meta.paramsVersion).toBe("tk*|dev1");
  });
});

// ---- Provenance -----------------------------------------------------------------
describe("scanner — provenance validation", () => {
  it("evaluatedAt > asOf → futureCandidate excluded", () => {
    const r = scan([mkCand({ provenance: { evaluatedAt: T0 + H } })]);
    expect(r.data?.ranked).toHaveLength(0);
    expect(r.meta.diagnostics?.futureCandidate).toBe(1);
  });

  it("missing provenance → excluded and counted", () => {
    const c = mkCand();
    delete c.provenance;
    const r = scan([c]);
    expect(r.data?.ranked).toHaveLength(0);
    expect(r.meta.diagnostics?.missingProvenance).toBe(1);
  });

  it("future statistical evidence → stripped, candidate retained", () => {
    const c = mkCand({ statisticalEvidence: mkEvidence({ decisionTime: T0 + H }) });
    const r = scan([c]);
    expect(r.data?.ranked).toHaveLength(1);
    expect(r.data?.ranked[0].statisticalEvidence).toBeUndefined();
    expect(r.meta.diagnostics?.futureEvidence).toBe(1);
  });

  it("valid evidence passes through with upstream versions untouched", () => {
    const ev = mkEvidence();
    const r = scan([mkCand({ statisticalEvidence: ev })]);
    const e = r.data!.ranked[0].statisticalEvidence!;
    expect(e.estimate?.methodVersion).toBe("v1-empirical");
    expect(e.estimate?.paramsVersion).toBe("v5|ms30|sb0-50-70-85");
    expect(JSON.stringify(e)).toBe(JSON.stringify(ev));
  });

  it("insufficient_data evidence keeps the candidate ranked", () => {
    const r = scan([mkCand({ statisticalEvidence: { decisionTime: T0 - H, unavailable: "insufficient_data" } })]);
    expect(r.data?.ranked).toHaveLength(1);
    expect(r.data?.ranked[0].statisticalEvidence?.unavailable).toBe("insufficient_data");
  });
});

// ---- topK -----------------------------------------------------------------------
describe("scanner — topK", () => {
  const many = Array.from({ length: 5 }, (_, i) => mkCand({ setup: { score: 50 + i } }));

  it("topK=0 → all eligible, fully ranked", () => {
    expect(scan(many).data?.ranked).toHaveLength(5);
  });
  it("topK=1 → best only", () => {
    const r = scan(many, { config: { ...CFG, topK: 1 } });
    expect(r.data?.ranked).toHaveLength(1);
    expect(r.data?.ranked[0].score).toBe(54);
    expect(r.meta.paramsVersion).toBe("tk1|dev0");
  });
  it("topK > result count → all results", () => {
    expect(scan(many.slice(0, 2), { config: { ...CFG, topK: 99 } }).data?.ranked).toHaveLength(2);
  });
  it("ranking happens before slicing", () => {
    const r = scan(many, { config: { ...CFG, topK: 2 } });
    expect(r.data?.ranked.map((x) => x.score)).toEqual([54, 53]);
  });
  it("negative topK → invalid_config", () => {
    expect(scan(many, { config: { ...CFG, topK: -1 } }).errors[0].code).toBe("invalid_config");
  });
});

// ---- Determinism / replay ---------------------------------------------------------
describe("scanner — determinism & replay", () => {
  const set = [
    mkCand({ setup: { symbol: "BBB", score: 90 } }),
    mkCand({ setup: { symbol: "AAA", score: 90, timeframe: "1h" } }),
    mkCand({ setup: { symbol: "AAA", score: 90 } }),
    mkCand({ setup: { symbol: "AAA", score: 60, status: "active" } }),
  ];

  it("permuted candidate array → bit-identical result", () => {
    const base = JSON.stringify(scan(set).data);
    expect(JSON.stringify(scan([set[2], set[0], set[3], set[1]]).data)).toBe(base);
    expect(JSON.stringify(scan([set[3], set[2], set[1], set[0]]).data)).toBe(base);
  });

  it("repeated invocation → identical", () => {
    expect(JSON.stringify(scan(set).data)).toBe(JSON.stringify(scan(set).data));
  });

  it("prefix vs full: candidates unseen at asOf never alter the scan", () => {
    // A scan at T0 sees only candidates with evaluatedAt ≤ T0 — later-evaluated
    // candidates appended to a "full" input are excluded, result identical to prefix.
    const later = mkCand({ provenance: { evaluatedAt: T0 + 2 * H }, setup: { score: 99 } });
    const prefix = scan(set).data!;
    const full = scan([...set, later]).data!;
    expect(JSON.stringify(prefix.ranked)).toBe(JSON.stringify(full.ranked));
    expect(scan([...set, later]).meta.diagnostics?.futureCandidate).toBe(1);
  });
});
