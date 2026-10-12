/**
 * Phase 6 — Outcome measurement (spec 17): deterministic rows over the post-confirmation
 * window; lifecycle stamps are the authoritative timeline; no intrabar-order assumptions.
 */
import { describe, expect, it } from "vitest";
import type { Candle, ScoreContribution, Setup } from "@/lib/types";
import { createOutcomeEngine, measureOutcome } from "../outcomes";

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;
const mkBar = (i: number, o: number, h: number, l: number, c: number): Candle =>
  ({ time: T0 + i * HOUR, open: o, high: h, low: l, close: c, volume: 100 });

/** Flat 100s baseline; caller overlays scenario bars after confirmBar=2. */
const mkCandles = (n = 20, bars: Record<number, Candle> = {}): Candle[] => {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) out.push(bars[i] ?? mkBar(i, 100, 100.5, 99.5, 100));
  return out;
};

/** Long reversal: confirmed at bar 2, band [99,101], inv 98, targets 102/104/106. */
const mkSetup = (over?: {
  status?: Setup["status"]; type?: Setup["type"]; direction?: Setup["direction"];
  metadata?: Record<string, unknown>;
}): Setup => ({
  id: "t:setup:1",
  symbol: "T",
  timeframe: "1h",
  type: over?.type ?? "reversal",
  direction: over?.direction ?? "bullish",
  score: 87,
  status: over?.status ?? "target_reached",
  reasons: [],
  createdAt: new Date(T0).toISOString(),
  metadata: {
    candidateBar: 1, confirmBar: 2,
    entryBandLow: 99, entryBandHigh: 101, invalidation: 98, targets: "102,104,106",
    ...(over?.metadata as Record<string, string | number | boolean | null> | undefined),
  },
});

const CONTRIBS: ScoreContribution[] = [
  { dimension: "structure", weight: 20, feature: 1, points: 20, label: "aligned", signalIds: ["brk:1"] },
  { dimension: "zoneQuality", weight: 20, feature: 0.8, points: 16, label: "zone 80", signalIds: ["z:1"] },
];

const measure = (setup: Setup, candles: Candle[],
  extra?: Omit<Parameters<typeof measureOutcome>[0], "setup" | "candles">) =>
  measureOutcome({ setup, candles, ...extra });

describe("outcomes — gating & window", () => {
  it("unconfirmed setup (developing / missing confirmBar) → no row", () => {
    const noBar = measure(mkSetup({ status: "developing", metadata: { confirmBar: null } }), mkCandles());
    expect(noBar.ok).toBe(false);
    expect(noBar.errors[0].code).toBe("insufficient_data");
  });

  it("confirmed on the last bar → empty observation window, still a row", () => {
    const s = mkSetup({ status: "confirmed" }); // no active/terminal stamps
    const res = measure(s, mkCandles(3)); // confirmBar=2 is the last bar
    expect(res.ok).toBe(true);
    expect(res.data?.entryPrice).toBeUndefined();
    expect(res.data?.targetsReached).toBe(0);
    expect(res.data?.barsToActive).toBeNull();
    expect(res.meta.diagnostics?.unresolved).toBe(true);
  });

  it("missing band/invalidation metadata → insufficient_data", () => {
    const s = mkSetup({ metadata: { entryBandLow: null, invalidation: null } });
    expect(measure(s, mkCandles()).errors[0].code).toBe("insufficient_data");
  });

  it("empty series → insufficient_data", () => {
    expect(measure(mkSetup(), []).errors[0].code).toBe("insufficient_data");
  });
});

describe("outcomes — entry & risk (spec 17: first-touched = conservative proximal edge)", () => {
  // Spec 05/06: demand-zone upperPrice is proximal, supply-zone lowerPrice is proximal →
  // bullish entries book band.high, bearish book band.low — regardless of the activation
  // bar's open (no intrabar touch-order inference; spec 11 same-bar rule).
  it("activation → entryPrice = proximal edge; risk from entry to invalidation", () => {
    const candles = mkCandles(20, { 3: mkBar(3, 102, 102.5, 99, 101) });
    const s = mkSetup({ status: "active", metadata: { activeBar: 3 } });
    const res = measure(s, candles);
    expect(res.data?.entryPrice).toBe(101);
    expect(res.data?.initialRisk).toBe(3);
    expect(res.data?.barsToActive).toBe(1);
    expect(res.data?.riskAtr).toBeGreaterThan(0);
  });

  it.each([
    ["long, open above band", "bullish", 102, 102.5, 99, 101, 101],
    ["long, open below band", "bullish", 97, 101, 96.5, 100, 101],
    ["long, open inside band", "bullish", 100, 102, 99, 100, 101],
    ["short, open above band", "bearish", 102, 102.5, 99, 101, 99],
    ["short, open below band", "bearish", 97, 101, 96.5, 100, 99],
    ["short, open inside band", "bearish", 100, 102, 99, 100, 99],
  ] as const)("%s → entryPrice %d", (_label, dir, o, h, l, cl, expected) => {
    const s = mkSetup({
      status: "active", direction: dir as Setup["direction"],
      metadata: dir === "bearish"
        ? { activeBar: 3, invalidation: 104, targets: "98,96,94" }
        : { activeBar: 3 },
    });
    const res = measure(s, mkCandles(20, { 3: mkBar(3, o, h, l, cl) }));
    expect(res.data?.entryPrice).toBe(expected);
  });

  it("gap-through the band (open beyond invalidation, close back inside) → still proximal edge", () => {
    // Long: opens at 96 (< inv 98) but closes 99.5 back inside — lifecycle activates on
    // overlap; spec books the conservative proximal edge (101), even though the bar never
    // printed there. Same convention, no special case.
    const s = mkSetup({ status: "active", metadata: { activeBar: 3 } });
    const res = measure(s, mkCandles(20, { 3: mkBar(3, 96, 100, 95, 99.5) }));
    expect(res.data?.entryPrice).toBe(101);
    expect(res.data?.initialRisk).toBe(3);
  });

  it("activated setup with non-positive risk → invalid_input, never a silent row", () => {
    const s = mkSetup({ status: "active", metadata: { activeBar: 3, invalidation: 101 } });
    const res = measure(s, mkCandles(20, { 3: mkBar(3, 102, 102.5, 99, 101) }));
    expect(res.ok).toBe(false);
    expect(res.errors[0].code).toBe("invalid_input");
  });
});

describe("outcomes — terminal paths (spec 17)", () => {
  it("all targets hit → target_reached; rMultiple = equal-third weighted sum", () => {
    // E=101, risk=3, targets 102/104/106 → per-target R = 1/3, 1, 5/3; averaged → 1.0
    const s = mkSetup({ metadata: { activeBar: 3, targetBars: "4,5,6", targetReachedBar: 6 } });
    const candles = mkCandles(20, { 3: mkBar(3, 102, 102.5, 99, 101) });
    const res = measure(s, candles);
    expect(res.data?.targetsReached).toBe(3);
    expect(res.data?.timeToTarget).toEqual([2, 3, 4]); // bars from confirmation
    expect(res.data?.rMultiple).toBeCloseTo(1, 4);
    expect(res.data?.stopReached).toBe(false);
    expect(res.data?.expired).toBe(false);
    expect(res.meta.diagnostics?.resolvedStatus).toBe("target_reached");
  });

  it("partial target then invalidated → banks T1, remainder exits at invalidating close", () => {
    // E=101, risk=3; T1=102 hit at bar 4; bar 7 closes 97 (<98) → invalidated.
    const s = mkSetup({ status: "invalidated",
      metadata: { activeBar: 3, targetBars: "4", invalidatedBar: 7 } });
    const candles = mkCandles(20, {
      3: mkBar(3, 102, 102.5, 99, 101),
      4: mkBar(4, 101, 103, 100.5, 102),
      7: mkBar(7, 99, 99.5, 96.5, 97),
    });
    const res = measure(s, candles);
    expect(res.data?.targetsReached).toBe(1);
    expect(res.data?.timeToTarget).toEqual([2, null, null]);
    expect(res.data?.timeToInvalidation).toBe(5);
    // banked (1/3)·(102−101)/3 = 0.1111; remainder (2/3)·(97−101)/3 = −0.8889 → −0.7778
    expect(res.data?.rMultiple).toBeCloseTo(-7 / 9, 4);
    expect(res.data?.stopReached).toBe(true);
  });

  it("clean stop at invalidation → exactly −1R; gap through → beyond −1R (invalidating close rule)", () => {
    const s = mkSetup({ status: "invalidated", metadata: { activeBar: 3, invalidatedBar: 7 } });
    const clean = measure(s, mkCandles(20, {
      3: mkBar(3, 102, 102.5, 99, 101), 7: mkBar(7, 99, 99.5, 97.8, 98), // close == inv
    }));
    expect(clean.data?.rMultiple).toBeCloseTo(-1, 4);
    const gap = measure(s, mkCandles(20, {
      3: mkBar(3, 102, 102.5, 99, 101), 7: mkBar(7, 99, 99.5, 96, 96.5), // gapped through
    }));
    expect(gap.data?.rMultiple).toBeCloseTo((96.5 - 101) / 3, 4); // −1.5
  });

  it("never activated then invalidated while confirmed → row, no fill, rMultiple 0", () => {
    const s = mkSetup({ status: "invalidated", metadata: { invalidatedBar: 5 } });
    const res = measure(s, mkCandles(20, { 5: mkBar(5, 99, 99.5, 97, 97.5) }));
    expect(res.data?.entryPrice).toBeUndefined();
    expect(res.data?.initialRisk).toBeUndefined();
    expect(res.data?.stopReached).toBe(true);
    expect(res.data?.rMultiple).toBe(0);
    expect(res.data?.timeToInvalidation).toBe(3);
  });

  it("expired unactivated → rMultiple 0, expired flag set, no fill fields", () => {
    const s = mkSetup({ status: "expired", metadata: { expiredBar: 10 } });
    const res = measure(s, mkCandles());
    expect(res.data?.expired).toBe(true);
    expect(res.data?.stopReached).toBe(false);
    expect(res.data?.rMultiple).toBe(0);
    expect(res.data?.entryPrice).toBeUndefined();
    expect(res.data?.mfeR).toBeUndefined();
  });

  it("activated but expired unresolved → remainder exits at last window close", () => {
    const s = mkSetup({ status: "expired", metadata: { activeBar: 3, expiredBar: 10 } });
    const candles = mkCandles(20, {
      3: mkBar(3, 102, 102.5, 99, 101),
      10: mkBar(10, 100, 100.4, 99.6, 100), // last close of the window
    });
    const res = measure(s, candles);
    expect(res.data?.rMultiple).toBeCloseTo((100 - 101) / 3, 4); // −0.3333 mark-to-market
  });

  it("cancelled post-confirmation (unactivated) → 0, not a loss", () => {
    const s = mkSetup({ status: "cancelled", metadata: { cancelledBar: 6 } });
    const res = measure(s, mkCandles());
    expect(res.data?.rMultiple).toBe(0);
    expect(res.data?.stopReached).toBe(false);
    expect(res.meta.diagnostics?.resolvedStatus).toBe("cancelled");
  });

  it.each([
    // k hits banked at target price; remainder exits at the invalidating close (97).
    ["no targets hit → invalidation", "", 0, (97 - 101) / 3],                 // −4/3 ≈ −1.333
    ["T1 hit → invalidation", "4", 1, 0.1111 + (2 / 3) * ((97 - 101) / 3)],   // −7/9 ≈ −0.778
    ["T1+T2 hit → invalidation", "4,5", 2, (1 + 3) / 9 + (1 / 3) * ((97 - 101) / 3)], // −4/9 + 4/9…
    ["all targets hit → no invalidation exit", "4,5,6", 3, (1 + 3 + 5) / 9],  // 1.0 — remW=0
  ] as const)("banking rule, long: %s", (_label, tb, k, expected) => {
    const s = mkSetup({ status: "invalidated",
      metadata: { activeBar: 3, ...(tb ? { targetBars: tb } : {}), invalidatedBar: 7 } });
    const candles = mkCandles(20, {
      3: mkBar(3, 102, 102.5, 99, 101), 7: mkBar(7, 99, 99.5, 96.5, 97),
    });
    const res = measure(s, candles);
    expect(res.data?.targetsReached).toBe(k);
    expect(res.data?.rMultiple).toBeCloseTo(expected, 4);
  });

  it("banking rule, short mirror: T1 banked, remainder exits at invalidating close", () => {
    // E=99 (proximal = band.low), risk 5; T1=98 hit at 4; invalidated at 7 close 105.
    const s = mkSetup({ direction: "bearish", status: "invalidated",
      metadata: { invalidation: 104, targets: "98,96,94",
        activeBar: 3, targetBars: "4", invalidatedBar: 7 } });
    const candles = mkCandles(20, {
      3: mkBar(3, 98, 101, 97, 99), 7: mkBar(7, 101, 105.5, 100, 105),
    });
    const res = measure(s, candles);
    expect(res.data?.targetsReached).toBe(1);
    // (1/3)·(99−98)/5 + (2/3)·(99−105)/5 = 1/15 − 12/15 = −11/15 ≈ −0.7333
    expect(res.data?.rMultiple).toBeCloseTo(-11 / 15, 4);
  });

  it("no terminal event → unresolved window ends at series end, marked-to-market", () => {
    const s = mkSetup({ status: "active", metadata: { activeBar: 3 } });
    const candles = mkCandles(10, {
      3: mkBar(3, 102, 102.5, 99, 101),
      9: mkBar(9, 103, 104, 102.5, 103), // last close
    });
    const res = measure(s, candles);
    expect(res.meta.diagnostics?.unresolved).toBe(true);
    expect(res.data?.rMultiple).toBeCloseTo((103 - 101) / 3, 4); // 0.6667
    expect(res.data?.resolvedAt).toBe(new Date(T0 + 9 * HOUR).toISOString());
  });
});

describe("outcomes — same-bar semantics & excursions", () => {
  it("bar touching a target but closing through invalidation → invalidated wins (stamps authoritative)", () => {
    // Lifecycle checks invalidation-close BEFORE target touches (spec 11 ordering) — so the
    // stamps contain invalidatedBar and NO targetBars even though the wick tagged T1.
    const s = mkSetup({ status: "invalidated", metadata: { activeBar: 3, invalidatedBar: 5 } });
    const candles = mkCandles(20, {
      3: mkBar(3, 102, 102.5, 99, 101),
      5: mkBar(5, 100, 103, 96, 96.5), // high 103 ≥ T1=102 but close 96.5 < 98
    });
    const res = measure(s, candles);
    expect(res.data?.targetsReached).toBe(0);        // touch without confirmation close → not a hit
    expect(res.data?.timeToTarget).toEqual([null, null, null]);
    expect(res.data?.stopReached).toBe(true);
    expect(res.data?.rMultiple).toBeCloseTo((96.5 - 101) / 3, 4);
    // excursion still records the wick honestly:
    expect(res.data?.mfeR).toBeCloseTo((103 - 101) / 3, 4);
    expect(res.data?.maeR).toBeCloseTo((101 - 96) / 3, 4);
  });

  it("two targets on one bar both count (ordered hits)", () => {
    const s = mkSetup({ metadata: { activeBar: 3, targetBars: "4,4,6", targetReachedBar: 6 } });
    const res = measure(s, mkCandles());
    expect(res.data?.timeToTarget).toEqual([2, 2, 4]);
    expect(res.data?.targetsReached).toBe(3);
  });

  it("mfe/mae measure extremes across the whole window, excursion only after activation exists", () => {
    const s = mkSetup({ status: "active", metadata: { activeBar: 3 } });
    const candles = mkCandles(10, {
      3: mkBar(3, 102, 102.5, 99, 101),
      4: mkBar(4, 101, 105, 100, 104),
      5: mkBar(5, 104, 104.5, 98.5, 99),
    });
    const res = measure(s, candles);
    expect(res.data?.mfeR).toBeCloseTo((105 - 101) / 3, 4);
    expect(res.data?.maeR).toBeCloseTo((101 - 98.5) / 3, 4);
  });
});

describe("outcomes — direction symmetry", () => {
  it("bearish mirror: proximal edge low, mirrored excursions and rMultiple", () => {
    const s = mkSetup({
      direction: "bearish", status: "target_reached",
      metadata: {
        invalidation: 104, targets: "98,96,94",
        activeBar: 3, targetBars: "4,5,6", targetReachedBar: 6,
      },
    });
    const candles = mkCandles(20, {
      3: mkBar(3, 98, 101, 97, 99), // opens below band → enters via band low
      4: mkBar(4, 99, 99.5, 97.5, 98),
      5: mkBar(5, 98, 98.5, 95.5, 96),
      6: mkBar(6, 96, 96.5, 93.5, 94),
    });
    const res = measure(s, candles);
    expect(res.data?.entryPrice).toBe(99);           // E=99, risk |99−104|=5
    // rMultiple: (1/3)·[(99−98)+(99−96)+(99−94)]/5 = (1+3+5)/15 = 0.6
    expect(res.data?.rMultiple).toBeCloseTo(0.6, 4);
    expect(res.data?.mfeR).toBeCloseTo((99 - 93.5) / 5, 4); // extremes below entry
    expect(res.data?.maeR).toBeGreaterThanOrEqual(0);
  });
});

describe("outcomes — determinism, replay equivalence, identity", () => {
  const FIX = () => ({
    setup: mkSetup({ metadata: { activeBar: 3, targetBars: "4,5", invalidatedBar: 8 } }),
    candles: mkCandles(12, {
      3: mkBar(3, 102, 102.5, 99, 101),
      8: mkBar(8, 99, 99.4, 97, 97.2),
    }),
  });

  it("repeated measurement is bit-identical", () => {
    const { setup, candles } = FIX();
    const a = measure(setup, candles);
    const b = measure(setup, candles);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("trailing candles after resolution never change the row (no future leak)", () => {
    const { setup } = FIX();
    const short = measure(setup, mkCandles(12, { 3: mkBar(3, 102, 102.5, 99, 101), 8: mkBar(8, 99, 99.4, 97, 97.2) }));
    const long = measure(setup, mkCandles(30, {
      3: mkBar(3, 102, 102.5, 99, 101),
      8: mkBar(8, 99, 99.4, 97, 97.2),
      15: mkBar(15, 200, 210, 190, 205), // wild post-resolution bars
      25: mkBar(25, 50, 60, 40, 55),
    }));
    expect(JSON.stringify(long.data)).toBe(JSON.stringify(short.data));
  });

  it("prefix vs full replay: identical outcome when the prefix covers the resolution bar", () => {
    const { setup, candles } = FIX();
    const prefix = measure(setup, candles.slice(0, 9)); // ends at resolvedBar=8
    const full = measure(setup, candles);
    expect(JSON.stringify(prefix.data)).toBe(JSON.stringify(full.data));
  });

  it("identity = setupId + confirmedAt — deterministic composite key, no randomness", () => {
    const { setup, candles } = FIX();
    const a = measure(setup, candles).data!;
    const b = measure(setup, candles).data!;
    expect(`${a.setupId}:${a.confirmedAt}`).toBe(`${b.setupId}:${b.confirmedAt}`);
    expect(a.confirmedAt).toBe(new Date(T0 + 2 * HOUR).toISOString());
  });
});

describe("outcomes — feature vector, scores, family coverage", () => {
  it("score fields + namespaced featureVector from contributions", () => {
    const s = mkSetup({ status: "expired", metadata: { expiredBar: 10 } });
    const res = measure(s, mkCandles(), {
      scoreAtConfirmation: 87, scoreAtDetection: 41, contributions: CONTRIBS,
      regime: "trending_bullish", paramsVersion: "p5",
    });
    const d = res.data!;
    expect(d.scoreAtConfirmation).toBe(87);
    expect(d.scoreAtDetection).toBe(41);
    expect(d.regime).toBe("trending_bullish");
    expect(d.paramsVersion).toBe("p5");
    expect(d.featureVector?.["score.structure"]).toBe(1);
    expect(d.featureVector?.["score.zoneQuality"]).toBe(0.8);
    expect(d.featureVector?.["score.total"]).toBe(87);
  });

  it("scoreAtDetection is the at_bar score at candidateBar — later transitions can't rewrite it", () => {
    // Spec 17: "the score when the setup first became `developing`" — the engines emit
    // status `developing` at candidateBar, so that is the authoritative bar. The caller
    // computes it via scoreOpportunity(..., provenance "at_bar") at candidateBar; the
    // outcome row carries it verbatim regardless of what the setup did afterwards.
    const base = { scoreAtDetection: 41 };
    const stillDeveloping = measure(
      mkSetup({ status: "confirmed" }), mkCandles(), base).data!;
    const reachedTarget = measure(
      mkSetup({ metadata: { activeBar: 3, targetBars: "4,5,6", targetReachedBar: 6 } }),
      mkCandles(), base).data!;
    const gotInvalidated = measure(
      mkSetup({ status: "invalidated", metadata: { invalidatedBar: 5 } }),
      mkCandles(), base).data!;
    expect(stillDeveloping.scoreAtDetection).toBe(41);
    expect(reachedTarget.scoreAtDetection).toBe(41);
    expect(gotInvalidated.scoreAtDetection).toBe(41);
    // and it is a distinct field from the confirmation score (different bar, different number)
    expect(reachedTarget.scoreAtConfirmation).toBe(87); // fixture's setup.score
  });

  it("measurement is family-agnostic — reversal/breakout/continuation rows all derive from stamps", () => {
    for (const type of ["reversal", "breakout", "continuation"] as const) {
      const s = mkSetup({ type, metadata: { activeBar: 3, targetReachedBar: 6, targetBars: "4,5,6" } });
      const res = measure(s, mkCandles());
      expect(res.ok).toBe(true);
      expect(res.data?.setupType).toBe(type);
      expect(res.data?.rMultiple).toBeCloseTo(1, 4);
    }
  });

  it("different symbol/price scale measures identically in R", () => {
    const s = mkSetup({
      metadata: {
        activeBar: 3, targetReachedBar: 6, targetBars: "4,5,6",
        entryBandLow: 0.0099, entryBandHigh: 0.0101, invalidation: 0.0098,
        targets: "0.0102,0.0104,0.0106",
      },
    });
    const candles = mkCandles(20, {
      3: { time: T0 + 3 * HOUR, open: 0.0102, high: 0.01025, low: 0.0099, close: 0.0101 },
    });
    const res = measure(s, candles);
    expect(res.data?.entryPrice).toBeCloseTo(0.0101, 8);
    expect(res.data?.rMultiple).toBeCloseTo(1, 3);
  });
});

describe("outcomes — contract adapter", () => {
  const engine = createOutcomeEngine();

  it("maps opportunity score/contributions + optional scoreAtDetection/paramsVersion", () => {
    const s = mkSetup({ status: "expired", metadata: { expiredBar: 10 } });
    const res = engine.measure({
      setup: s,
      opportunity: {
        id: "opp:1", setupId: s.id, symbol: "T", assetClass: "crypto",
        setupType: "reversal", direction: "bullish", score: 73,
        scoreContributions: CONTRIBS, timeframe: "1h", status: "expired",
        createdAt: new Date(T0).toISOString(),
        metadata: { scoreAtDetection: 55 },
      },
      series: { symbol: "T", timeframe: "1h", candles: mkCandles() },
      regime: "ranging",
      paramsVersion: "cfgX",
    });
    expect(res.ok).toBe(true);
    expect(res.data?.scoreAtConfirmation).toBe(73);
    expect(res.data?.scoreAtDetection).toBe(55); // from opportunity.metadata
    expect(res.data?.featureVector?.["score.total"]).toBe(73);
    expect(res.meta.diagnostics?.resolvedStatus).toBe("expired");
  });

  it("input field overrides opportunity.metadata for scoreAtDetection", () => {
    const s = mkSetup({ status: "expired", metadata: { expiredBar: 10 } });
    const res = engine.measure({
      setup: s,
      opportunity: {
        id: "opp:1", setupId: s.id, symbol: "T", assetClass: "crypto",
        setupType: "reversal", direction: "bullish", score: 73, timeframe: "1h",
        status: "expired", createdAt: new Date(T0).toISOString(),
        metadata: { scoreAtDetection: 55 },
      },
      series: { symbol: "T", timeframe: "1h", candles: mkCandles() },
      scoreAtDetection: 12,
    });
    expect(res.data?.scoreAtDetection).toBe(12);
  });
});
