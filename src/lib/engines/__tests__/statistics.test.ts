import { describe, expect, it } from "vitest";
import type { SetupOutcome, StatisticalDecision, StatsConfig } from "@/lib/types";
import { estimateProbability } from "../statistics";

// ---- Fixtures ---------------------------------------------------------------
const T0 = Date.parse("2026-01-01T00:00:00Z");
const H = 3_600_000;
const ISO = (ms: number) => new Date(ms).toISOString();

const CFG: StatsConfig = { minSamples: 4, scoreBands: [0, 50, 70, 85], methodVersion: "v1-empirical" };

let seq = 0;
/** A resolved spec-17 row in the default cohort: reversal|bullish|trending_bullish|70-84. */
const mkRow = (o: Partial<SetupOutcome> = {}): SetupOutcome => ({
  setupId: `s${seq++}`,
  symbol: "T",
  timeframe: "1h",
  setupType: "reversal",
  direction: "bullish",
  regime: "trending_bullish",
  scoreAtConfirmation: 78, // band 70-84
  paramsVersion: "v5",
  targetsReached: 0,
  stopReached: true,
  expired: false,
  unresolved: false,
  rMultiple: -1,
  confirmedAt: ISO(T0 - 20 * H),
  resolvedAt: ISO(T0 - 10 * H),
  ...o,
});

const DECISION: StatisticalDecision = {
  setupType: "reversal",
  direction: "bullish",
  regime: "trending_bullish",
  scoreAtConfirmation: 78,
  decisionTime: T0,
  paramsVersion: "v5",
};

const est = (rows: SetupOutcome[], d: StatisticalDecision = DECISION, c: StatsConfig = CFG) =>
  estimateProbability({ decision: d, outcomes: rows, config: c });

// ---- Cohort ladder -----------------------------------------------------------
describe("statistics — cohort ladder (L0→L4, drop regime→direction→setupType→scoreBand)", () => {
  it("L0: exact cohort match — all four axes", () => {
    const res = est([mkRow(), mkRow(), mkRow(), mkRow()]);
    expect(res.ok).toBe(true);
    expect(res.data?.cohortLevel).toBe(0);
    expect(res.data?.cohortKey).toBe("st=reversal|dir=bullish|reg=trending_bullish|sb=70-84");
    expect(res.data?.sampleSize).toBe(4);
  });

  it("L1: regime mismatch drops the regime axis", () => {
    const rows = Array.from({ length: 4 }, () => mkRow({ regime: "ranging" }));
    const res = est(rows);
    expect(res.data?.cohortLevel).toBe(1);
    expect(res.data?.cohortKey).toBe("st=reversal|dir=bullish|sb=70-84");
  });

  it("L2: direction mismatch drops regime and direction", () => {
    const rows = Array.from({ length: 4 }, () => mkRow({ direction: "bearish", regime: "ranging" }));
    const res = est(rows);
    expect(res.data?.cohortLevel).toBe(2);
    expect(res.data?.cohortKey).toBe("st=reversal|sb=70-84");
  });

  it("L3: setupType mismatch keeps only the scoreBand axis", () => {
    const rows = Array.from({ length: 4 }, () => mkRow({ setupType: "breakout", direction: "bearish" }));
    const res = est(rows);
    expect(res.data?.cohortLevel).toBe(3);
    expect(res.data?.cohortKey).toBe("sb=70-84");
  });

  it("L4: scoreBand mismatch falls through to the global cohort", () => {
    const rows = Array.from({ length: 4 }, () =>
      mkRow({ setupType: "breakout", direction: "bearish", regime: "ranging", scoreAtConfirmation: 90 }));
    const res = est(rows);
    expect(res.data?.cohortLevel).toBe(4);
    expect(res.data?.cohortKey).toBe("*");
  });

  it("L4 below minSamples → insufficient_data, never fabricated", () => {
    const res = est([mkRow(), mkRow(), mkRow()]);
    expect(res.ok).toBe(false);
    expect(res.errors[0].code).toBe("insufficient_data");
    expect(res.data).toBeUndefined();
  });

  it("absent decision regime: L0 skipped, matching starts at L1", () => {
    const d: StatisticalDecision = { ...DECISION, regime: undefined };
    const rows = Array.from({ length: 4 }, () => mkRow({ regime: undefined }));
    const res = est(rows, d);
    expect(res.data?.cohortLevel).toBe(1); // L0 constrains reg — unavailable
    expect(res.data?.cohortKey).toBe("st=reversal|dir=bullish|sb=70-84");
  });

  it("rows missing a constrained axis never join that level", () => {
    // 3 regime-less + 2 regime rows → L0 sees only the 2 regime rows < 4 → L1 takes all 5.
    const rows = [
      ...Array.from({ length: 3 }, () => mkRow({ regime: undefined })),
      mkRow(), mkRow(),
    ];
    const res = est(rows);
    expect(res.data?.cohortLevel).toBe(1);
    expect(res.data?.sampleSize).toBe(5);
  });

  it("fallback is one-way and deterministic — deeper levels are never revisited", () => {
    const rows = [
      ...Array.from({ length: 3 }, () => mkRow()),                              // L0: 3
      ...Array.from({ length: 2 }, () => mkRow({ regime: "ranging" })),          // L1: 5
    ];
    const res = est(rows);
    expect(res.data?.cohortLevel).toBe(1);
    expect(res.data?.sampleSize).toBe(5);
    expect(res.meta.diagnostics?.eligiblePerLevel).toBe("3,5"); // loop stops at the selected level
  });
});

// ---- Probability -------------------------------------------------------------

describe("statistics — empirical probabilities (raw frequency, no smoothing)", () => {
  it("all-success cohort → pTarget [1,1,1]", () => {
    const rows = Array.from({ length: 4 }, () => mkRow({ targetsReached: 3, stopReached: false, rMultiple: 1 }));
    const res = est(rows);
    expect(res.data?.pTarget).toEqual([1, 1, 1]);
    expect(res.data?.pStop).toBe(0);
  });

  it("all-failure cohort → pTarget [0,0,0], pStop 1", () => {
    const res = est(Array.from({ length: 4 }, () => mkRow()));
    expect(res.data?.pTarget).toEqual([0, 0, 0]);
    expect(res.data?.pStop).toBe(1);
  });

  it("mixed cohort — exact fractions (worked example values)", () => {
    const rows = [
      mkRow({ targetsReached: 3, stopReached: false, rMultiple: 1.0 }),   // A
      mkRow({ targetsReached: 1, stopReached: true, rMultiple: -0.78 }),  // B — T1 then stopped
      mkRow({ targetsReached: 0, stopReached: true, rMultiple: -1.0 }),   // C
      mkRow({ targetsReached: 0, stopReached: false, expired: true, rMultiple: 0 }), // D
      mkRow({ targetsReached: 0, stopReached: false, rMultiple: 0 }),     // E — cancelled
    ];
    const res = est(rows);
    const d = res.data!;
    expect(d.sampleSize).toBe(5);
    expect(d.pTarget).toEqual([0.4, 0.2, 0.2]); // 2/5, 1/5, 1/5 — monotone
    expect(d.pStop).toBeCloseTo(0.4);           // B,C — coexists with pTarget[0]
    expect(d.pExpired).toBeCloseTo(0.2);        // D
    expect(d.expectancyR).toBeCloseTo(-0.156);  // (1 − .78 − 1 + 0 + 0)/5
  });

  it("exact 50% cohort", () => {
    const rows = [
      mkRow({ targetsReached: 1, stopReached: false }), mkRow({ targetsReached: 1, stopReached: false }),
      mkRow(), mkRow(),
    ];
    expect(est(rows).data?.pTarget[0]).toBe(0.5);
  });

  it("targetsReached drives the label — rMultiple is never substituted", () => {
    // High rMultiple without target hits (mark-to-market expiry) counts as no target hit.
    const rows = [
      mkRow({ targetsReached: 0, expired: true, stopReached: false, rMultiple: 2.5 }),
      mkRow({ targetsReached: 1, stopReached: false, rMultiple: 0.4 }),
      mkRow({ targetsReached: 2, stopReached: false, rMultiple: 0.8 }),
      mkRow({ targetsReached: 3, stopReached: false, rMultiple: 1.2 }),
    ];
    const res = est(rows);
    expect(res.data?.pTarget).toEqual([0.75, 0.5, 0.25]);
    expect(res.data?.expectancyR).toBeCloseTo((2.5 + 0.4 + 0.8 + 1.2) / 4);
  });

  it("pTarget is monotone non-increasing across all cohorts", () => {
    const rows = [
      mkRow({ targetsReached: 0 }), mkRow({ targetsReached: 1 }),
      mkRow({ targetsReached: 2 }), mkRow({ targetsReached: 3 }),
    ];
    const p = est(rows).data!.pTarget;
    expect(p[2]).toBeLessThanOrEqual(p[1]);
    expect(p[1]).toBeLessThanOrEqual(p[0]);
    [...p].forEach((x) => { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); });
  });

  it("scoreBand boundary: score exactly on an edge lands in the upper band", () => {
    const rows = Array.from({ length: 4 }, () => mkRow({ scoreAtConfirmation: 70 }));
    const res = est(rows);
    expect(res.data?.cohortKey).toContain("sb=70-84");
    const top = Array.from({ length: 4 }, () => mkRow({ scoreAtConfirmation: 100 }));
    expect(est(top, { ...DECISION, scoreAtConfirmation: 100 }).data?.cohortKey).toContain("sb=85-100");
  });
});

// ---- Historical availability -------------------------------------------------

describe("statistics — resolution-gated history (E1/E2)", () => {
  it("unresolved row is excluded (E1)", () => {
    const rows = [mkRow(), mkRow(), mkRow(), mkRow(), mkRow({ unresolved: true })];
    const res = est(rows);
    expect(res.data?.sampleSize).toBe(4);
    expect(res.meta.diagnostics?.e1Unresolved).toBe(1);
  });

  it("resolvedAt == decisionTime is excluded — the comparison is strict", () => {
    const rows = [mkRow(), mkRow(), mkRow(), mkRow(), mkRow({ resolvedAt: ISO(T0) })];
    const res = est(rows);
    expect(res.meta.diagnostics?.e2NotYetResolved).toBe(1);
    expect(res.data?.sampleSize).toBe(4);
  });

  it("resolvedAt < decisionTime is included", () => {
    const rows = Array.from({ length: 4 }, (_, i) => mkRow({ resolvedAt: ISO(T0 - (i + 1) * H) }));
    expect(est(rows).data?.sampleSize).toBe(4);
  });

  it("confirmed before τ but resolved after τ contributes nothing (right-censoring)", () => {
    // Setup H: confirmed long before τ, resolves after → invisible at τ.
    const rows = [mkRow(), mkRow(), mkRow(), mkRow(), mkRow({
      confirmedAt: ISO(T0 - 100 * H), resolvedAt: ISO(T0 + 6 * H), targetsReached: 3, rMultiple: 1,
    })];
    const res = est(rows);
    expect(res.data?.sampleSize).toBe(4);
    expect(res.data?.pTarget[0]).toBe(0); // H's targets must not lift the estimate
  });

  it("a row without resolvedAt cannot be gated → excluded", () => {
    const rows = [mkRow(), mkRow(), mkRow(), mkRow(), mkRow({ resolvedAt: undefined })];
    const res = est(rows);
    expect(res.meta.diagnostics?.e2NotYetResolved).toBe(1);
    expect(res.data?.sampleSize).toBe(4);
  });
});

// ---- Eligibility: version + superseded ---------------------------------------

describe("statistics — eligibility E3/E4", () => {
  it("paramsVersion mismatch excludes the row (E3)", () => {
    const rows = [mkRow(), mkRow(), mkRow(), mkRow(), mkRow({ paramsVersion: "v4" })];
    const res = est(rows);
    expect(res.meta.diagnostics?.e3Version).toBe(1);
    expect(res.data?.sampleSize).toBe(4);
  });

  it("superseded row is excluded; the correction remains (E4)", () => {
    const old = mkRow({ setupId: "s:old" });
    const fix = mkRow({ setupId: "s:new", supersedes: "s:old", targetsReached: 1 });
    const rows = [old, fix, mkRow(), mkRow(), mkRow()];
    const res = est(rows);
    expect(res.meta.diagnostics?.e4Superseded).toBe(1);
    expect(res.data?.sampleSize).toBe(4); // fix + 3 others; s:old gone
    expect(res.data?.pTarget[0]).toBeCloseTo(1 / 4);
  });

  it("supersedes chain a→b→c resolves to the latest row only (spec 17 append-only)", () => {
    const a = mkRow({ setupId: "s:a" });                                   // superseded by b
    const b = mkRow({ setupId: "s:b", supersedes: "s:a" });                // superseded by c
    const c = mkRow({ setupId: "s:c", supersedes: "s:b", targetsReached: 1 });
    const rows = [a, b, c, mkRow(), mkRow(), mkRow()];
    const res = est(rows);
    expect(res.meta.diagnostics?.e4Superseded).toBe(2); // a and b both drop
    expect(res.data?.sampleSize).toBe(4);               // c + 3 clean rows
    expect(res.data?.pTarget[0]).toBeCloseTo(1 / 4);    // only c's T1 counts
  });

  it("a non-superseded row is included — supersedes only excludes the referenced id", () => {
    const rows = Array.from({ length: 4 }, () => mkRow()); // no supersedes anywhere
    const res = est(rows);
    expect(res.meta.diagnostics?.e4Superseded).toBe(0);
    expect(res.data?.sampleSize).toBe(4);
  });
});

// ---- Causality / determinism -------------------------------------------------

describe("statistics — causality and determinism", () => {
  it("prefix vs full dataset: future resolutions never alter an earlier estimate", () => {
    const base = [
      mkRow({ resolvedAt: ISO(T0 - 9 * H), targetsReached: 3, rMultiple: 1 }),
      mkRow({ resolvedAt: ISO(T0 - 7 * H), targetsReached: 1, rMultiple: -0.78 }),
      mkRow({ resolvedAt: ISO(T0 - 5 * H) }),
      mkRow({ resolvedAt: ISO(T0 - 3 * H), expired: true, stopReached: false, rMultiple: 0 }),
    ];
    const future = [
      mkRow({ resolvedAt: ISO(T0 + 2 * H), targetsReached: 3, rMultiple: 1 }),
      mkRow({ resolvedAt: ISO(T0 + 4 * H), targetsReached: 3, rMultiple: 1 }),
    ];
    const a = est(base).data!;
    const b = est([...base, ...future]).data!;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // prefix == full for τ
  });

  it("a future regime/score row cannot shift an earlier cohort", () => {
    const base = Array.from({ length: 4 }, () => mkRow());
    const withFuture = [...base, mkRow({ resolvedAt: ISO(T0 + H), regime: "ranging", scoreAtConfirmation: 10 })];
    expect(JSON.stringify(est(base).data)).toBe(JSON.stringify(est(withFuture).data));
  });

  it("identical inputs → bit-identical estimate; input order irrelevant", () => {
    const rows = [
      mkRow({ targetsReached: 2, rMultiple: 0.7 }), mkRow(), mkRow({ expired: true, stopReached: false }),
      mkRow({ targetsReached: 3, rMultiple: 1 }), mkRow({ targetsReached: 1 }),
    ];
    const a = est(rows).data!;
    expect(JSON.stringify(est(rows).data)).toBe(JSON.stringify(a));
    const shuffled = [rows[3], rows[0], rows[4], rows[1], rows[2]];
    expect(JSON.stringify(est(shuffled).data)).toBe(JSON.stringify(a));
  });
});

// ---- Versioning + validation -------------------------------------------------

describe("statistics — versioning & validation", () => {
  it("exposes methodVersion and a composite paramsVersion (domain + stats params)", () => {
    const res = est(Array.from({ length: 4 }, () => mkRow()));
    expect(res.data?.methodVersion).toBe("v1-empirical");
    expect(res.data?.paramsVersion).toBe("v5|ms4|sb0-50-70-85");
    expect(res.meta.paramsVersion).toBe(res.data?.paramsVersion);
  });

  it("stats-param changes never enter eligibility — E3 compares outcome-domain versions only", () => {
    // Historical rows were generated under domain "v5". Raising minSamples re-floors the
    // estimate and re-stamps paramsVersion, but every row stays exactly as eligible.
    const rows = Array.from({ length: 6 }, () => mkRow({ paramsVersion: "v5" }));
    const before = est(rows);                                    // minSamples 4 → eligible
    const after = est(rows, DECISION, { ...CFG, minSamples: 50 }); // 6 < 50 → insufficient_data
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(false);
    expect(after.errors[0].code).toBe("insufficient_data");
    // eligibility diagnostics identical across the config change — E3 untouched:
    expect(after.meta.diagnostics?.e3Version).toBe(before.meta.diagnostics?.e3Version);
    expect(after.meta.diagnostics?.e1Unresolved).toBe(before.meta.diagnostics?.e1Unresolved);
    // the stamp changed (params bump), eligibility did not:
    expect(after.meta.paramsVersion).toBe("v5|ms50|sb0-50-70-85");
  });

  it("scoreBand edge changes re-cohort but never exclude rows via E3", () => {
    // Under [0,40,60,80]: decision score 78 → band 60-79, row score 50 → band 40-59 — the sb
    // axis mismatches, so the ladder falls to L4. Eligibility is untouched: all 4 rows count.
    const rows = Array.from({ length: 4 }, () => mkRow({ scoreAtConfirmation: 50, paramsVersion: "v5" }));
    const res = est(rows, DECISION, { ...CFG, scoreBands: [0, 40, 60, 80] });
    expect(res.meta.diagnostics?.e3Version).toBe(0);
    expect(res.meta.paramsVersion).toBe("v5|ms4|sb0-40-60-80");
    expect(res.data?.cohortLevel).toBe(4); // sb mismatch at every constrained level
    expect(res.data?.sampleSize).toBe(4);
  });

  it("invalid config is loud: minSamples < 1, unordered/ungrounded edges → invalid_config", () => {
    const rows = [mkRow()];
    expect(est(rows, DECISION, { ...CFG, minSamples: 0 }).errors[0].code).toBe("invalid_config");
    expect(est(rows, DECISION, { ...CFG, scoreBands: [50, 70] }).errors[0].code).toBe("invalid_config");
    expect(est(rows, DECISION, { ...CFG, scoreBands: [0, 70, 50] }).errors[0].code).toBe("invalid_config");
  });

  it("decision score outside [0,100] → invalid_input", () => {
    expect(est([mkRow()], { ...DECISION, scoreAtConfirmation: 140 }).errors[0].code).toBe("invalid_input");
  });
});
