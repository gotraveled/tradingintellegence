/**
 * Spec 26 — System-Level Historical Backtesting & Validation (docs/engine/26).
 *
 * The crafted 1h series below is shaped to exercise the REAL pipeline end-to-end:
 * an uptrend with HH/HL chains, a selloff sweeping sell-side liquidity with a
 * lower-high bounce, a two-step bottom (surviving low → LL classification →
 * downtrend), and a displacement recovery that fires a bullish CHOCH at bar 47.
 * One bullish reversal setup develops (47), confirms (49), then resolves as the
 * rally continues; two bearish reversal setups develop late and are cancelled by
 * the opposing CHOCH. All assertions are invariants over the emitted records —
 * never hardcoded detector internals.
 */
import { describe, expect, it } from "vitest";
import type {
  BacktestCell,
  BacktestSelection,
  BacktestWindow,
  Candle,
  CandleSeries,
  EngineConfig,
  SystemBacktestResult,
} from "@/lib/types";
import { runBacktest } from "../backtest";

const E = Date.UTC(2024, 0, 1);
const H1 = 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  time: E + i * H1, open: o, high: h, low: l, close: c, volume: 1000,
});

const mk = (): Candle[] => {
  const c: Candle[] = [];
  // Phase A: uptrend 100 → 114 with pullbacks deep enough to register swing lows.
  const a: [number, number][] = [
    [100, 101], [101, 102], [102, 103], [103, 104], [104, 102.6],
    [102.7, 103.5], [103.5, 104.5], [104.5, 105.5], [105.5, 107], [107, 105.6],
    [105.7, 106.5], [106.5, 107.5], [107.5, 108.5], [108.5, 110], [110, 108.6],
    [108.7, 109.5], [109.5, 110.5], [110.5, 111.5], [111.5, 112.5], [112.5, 113],
    [113, 111.8], [111.9, 112.4], [112.4, 113], [113, 113.5], [113.5, 112.6],
    [112.7, 113], [113, 113.8], [113.8, 114.3], [114.3, 113.9], [113.9, 114.2],
  ];
  a.forEach(([o, cl], i) => c.push(bar(i, o, Math.max(o, cl) + 0.4, Math.min(o, cl) - 0.3, cl)));
  // Phase B: selloff sweeping prior lows. Lower-high at bar 35 (107.8); two-step
  // bottom: L1 low 95.3 (survives — closes stay above it), then a deeper-wick L2
  // pivot at 94.8 → "LL" → downtrend → the recovery fires a bullish CHOCH at 47.
  const b: [number, number][] = [
    [111.9, 110.2], [110.2, 108.5], [108.5, 107], [107, 106], [106, 105.9], [105.9, 107.5],
    [106.2, 105.5], [105.5, 104.3], [104.3, 102.8], [102.8, 101.3],
    [101.3, 95.8],
    [95.9, 96.3],
    [96.3, 96.0],
    [97.4, 95.6],
    [95.8, 96.4],
    [96.4, 95.9],
  ];
  b.forEach(([o, cl], i) => {
    if (30 + i === 43) c.push(bar(43, o, Math.max(o, cl) + 0.3, 94.8, cl)); // deep wick — LL pivot
    else c.push(bar(30 + i, o, Math.max(o, cl) + 0.3, Math.min(o, cl) - 0.5, cl));
  });
  // Phase C: violent displacement recovery through the lower highs (CHOCH @ 47).
  const d: [number, number][] = [
    [95.9, 96.8], [96.8, 99], [99, 101.5], [101.5, 104], [104, 106.5], [106.5, 109],
    [109, 111], [111, 112.8], [112.8, 113], [113, 112.7],
  ];
  d.forEach(([o, cl], i) => c.push(bar(46 + i, o, Math.max(o, cl) + 0.2, Math.min(o, cl) - 0.2, cl)));
  // Phase D: continuation to new highs — resolves the confirmed setup.
  const e: [number, number][] = [
    [112.7, 113.4], [113.4, 114.2], [114.2, 115], [115, 115.8], [115.8, 116.5],
    [116.5, 117.2], [117.2, 118], [118, 118.6], [118.6, 119], [119, 119.3],
  ];
  e.forEach(([o, cl], i) => {
    if (56 + i === 56) c.push(bar(56, o, Math.max(o, cl) + 0.2, 96.0, cl)); // pullback wick — activates the confirmed setup
    else c.push(bar(56 + i, o, Math.max(o, cl) + 0.2, Math.min(o, cl) - 0.2, cl));
  });
  return c;
};

const CFG: EngineConfig = {
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
  stats: { minSamples: 2, scoreBands: [40, 60, 80], methodVersion: "v1-stats" },
  scanner: { topK: 0, includeDeveloping: true, methodVersion: "v1-scan" },
  backtest: { methodVersion: "v1-bt" },
};

const cell = (symbol = "T", timeframe: "1h" = "1h", candles: Candle[] = mk()): BacktestCell => ({
  symbol,
  timeframe,
  series: { symbol, timeframe, candles } as CandleSeries,
});

const run = (
  over: Partial<Parameters<typeof runBacktest>[0]> = {},
): SystemBacktestResult => {
  const res = runBacktest({ cells: [cell()], config: CFG, ...over });
  if (!res.ok || res.data === undefined) {
    throw new Error(`run failed: ${JSON.stringify(res.errors)}`);
  }
  return res.data;
};

/** Evaluation-time identity — outcomeRef deliberately excluded (outcome pass may
 *  legitimately produce different rows under different series lengths). */
const evalView = (r: { setupId: string; evaluatedIndex: number; status?: string; evaluatedAt: number; rank?: number; score?: unknown; selected?: boolean }) =>
  ({ setupId: r.setupId, evaluatedIndex: r.evaluatedIndex, status: r.status, evaluatedAt: r.evaluatedAt, rank: r.rank, score: r.score, selected: r.selected });

describe("spec26 — system backtest", () => {
  // ------------------------------------------------------------------------
  describe("pipeline sanity", () => {
    it("produces ranked + developing observations and real outcome rows", () => {
      const r = run();
      expect(r.opportunities.length).toBeGreaterThan(0);
      expect(r.developing.length).toBeGreaterThan(0);
      expect(r.outcomes.length).toBeGreaterThan(0);
      const agg = r.aggregate;
      expect(agg.observationCount).toBe(r.opportunities.length);
      expect(agg.developingObservationCount).toBe(r.developing.length);
      expect(agg.uniqueSetupCount).toBe(
        new Set([...r.opportunities, ...r.developing].map((x) => x.setupId)).size,
      );
    });

    it("attaches outcomeRef only to setups that measureOutcome accepted", () => {
      const r = run();
      const ids = new Set(r.outcomes.map((o) => o.setupId));
      for (const rec of [...r.opportunities, ...r.developing]) {
        if (rec.outcomeRef !== undefined) expect(ids.has(rec.outcomeRef)).toBe(true);
        else expect(ids.has(rec.setupId)).toBe(false); // no fabricated refs
      }
    });
  });

  // ------------------------------------------------------------------------
  describe("determinism", () => {
    it("is byte-identical across runs on identical inputs", () => {
      expect(run()).toEqual(run());
    });
    it("is cell-order invariant — canonical (symbol, timeframe) ordering", () => {
      const c2: BacktestCell = { ...cell("B"), series: { symbol: "B", timeframe: "1h", candles: mk().map((c) => ({ ...c })) } };
      const r1 = run({ cells: [cell("A"), c2] });
      const r2 = run({ cells: [c2, cell("A")] });
      expect(r1).toEqual(r2);
      expect(r1.cells.map((c) => c.symbol)).toEqual(["A", "B"]);
    });
  });

  // ------------------------------------------------------------------------
  describe("causality", () => {
    it("truncated series — evaluation-time records inside the shared window are identical", () => {
      const cut = 50; // before the bullish setup's resolution
      const candles = mk();
      const trunc: BacktestCell = {
        symbol: "T", timeframe: "1h",
        series: { symbol: "T", timeframe: "1h", candles: candles.slice(0, cut + 1) },
      };
      const full = run();
      const short = run({ cells: [trunc] });
      const fOpps = full.opportunities.filter((o) => o.evaluatedIndex <= cut).map(evalView);
      const sOpps = short.opportunities.map(evalView);
      expect(sOpps.length).toBeGreaterThan(0);
      expect(sOpps).toEqual(fOpps);
      const fDev = full.developing.filter((d) => d.evaluatedIndex <= cut).map(evalView);
      const sDev = short.developing.map(evalView);
      expect(sDev).toEqual(fDev);
      // No record may reference a bar beyond the truncated series.
      for (const rec of [...short.opportunities, ...short.developing]) {
        expect(rec.evaluatedIndex).toBeLessThanOrEqual(cut);
      }
    });

    it("evaluatedAt is always candle.time[evaluatedIndex] — UnixMs, never the index", () => {
      const candles = mk();
      const r = run();
      for (const rec of [...r.opportunities, ...r.developing]) {
        expect(rec.evaluatedAt).toBe(candles[rec.evaluatedIndex].time);
      }
    });

    it("window endIndex bounds every observation", () => {
      const window: BacktestWindow = { startIndex: 40, endIndex: 50 };
      const r = run({ window });
      for (const rec of [...r.opportunities, ...r.developing]) {
        expect(rec.evaluatedIndex).toBeGreaterThanOrEqual(40);
        expect(rec.evaluatedIndex).toBeLessThanOrEqual(50);
      }
    });
  });

  // ------------------------------------------------------------------------
  describe("Model B — outcome horizon", () => {
    it("outcome measurement may consume candles past endIndex", () => {
      // Eval window ends at 52 — the bullish setup is confirmed there but not yet
      // resolved; its outcome still resolves against the FULL series.
      const r = run({ window: { startIndex: 0, endIndex: 52 } });
      const withRef = [...r.opportunities, ...r.developing].filter((x) => x.outcomeRef !== undefined);
      expect(withRef.length).toBeGreaterThan(0);
      expect(r.outcomes.length).toBeGreaterThan(0);
    });

    it("outcome rows are identical whether the window ends early or late", () => {
      const early = run({ window: { startIndex: 0, endIndex: 50 } });
      const late = run({ window: { startIndex: 0, endIndex: 62 } });
      expect(early.outcomes).toEqual(late.outcomes);
    });
  });

  // ------------------------------------------------------------------------
  describe("outcome eligibility (spec 17 authority)", () => {
    it("never-confirmed setups produce no outcome row and no outcomeRef", () => {
      const r = run();
      const ids = new Set(r.outcomes.map((o) => o.setupId));
      const cancelled = r.opportunities.filter((x) => x.status === "cancelled");
      for (const rec of cancelled) {
        expect(ids.has(rec.setupId)).toBe(false);
        expect(rec.outcomeRef).toBeUndefined();
      }
    });
  });

  // ------------------------------------------------------------------------
  describe("aggregation", () => {
    it("outcomeCounts sum to resolvedOutcomeCount + unresolved rows", () => {
      const r = run();
      const a = r.aggregate;
      const c = a.outcomeCounts;
      expect(c.target + c.stop + c.expired + c.cancelled).toBe(a.resolvedOutcomeCount);
      expect(a.resolvedOutcomeCount + c.unresolved).toBe(a.uniqueSetupCount);
    });

    it("rate metrics divide by resolvedOutcomeCount — never NaN", () => {
      const r = run();
      const a = r.aggregate;
      if (a.resolvedOutcomeCount > 0) {
        expect(a.targetOutcomeRate).toBeCloseTo(a.outcomeCounts.target / a.resolvedOutcomeCount);
        expect(a.stopRate).toBeCloseTo(a.outcomeCounts.stop / a.resolvedOutcomeCount);
      }
      const rMults = r.outcomes.filter((o) => o.rMultiple !== undefined).map((o) => o.rMultiple!);
      if (rMults.length > 0) {
        expect(a.expectancyR).toBeCloseTo(rMults.reduce((x, y) => x + y, 0) / rMults.length);
        expect(a.totalR).toBeCloseTo(rMults.reduce((x, y) => x + y, 0));
      }
    });

    it("bySetupType partitions match the parent population", () => {
      const r = run();
      const a = r.aggregate;
      if (a.bySetupType === undefined) return;
      const parts = Object.values(a.bySetupType);
      expect(parts.reduce((s, p) => s + p.observationCount, 0)).toBe(a.observationCount);
    });
  });

  // ------------------------------------------------------------------------
  describe("record integrity", () => {
    it("ranks are a contiguous 1..k sequence per evaluation bar (spec 25)", () => {
      const r = run();
      const byBar = new Map<number, number[]>();
      for (const o of r.opportunities) {
        byBar.set(o.evaluatedIndex, [...(byBar.get(o.evaluatedIndex) ?? []), o.rank]);
      }
      for (const ranks of byBar.values()) {
        const sorted = [...ranks].sort((x, y) => x - y);
        expect(sorted).toEqual(sorted.map((_, i) => i + 1));
      }
    });

    it("no cross-T deduplication — a setup may repeat across evaluation bars", () => {
      const r = run();
      const counts = new Map<string, number>();
      for (const o of r.opportunities) counts.set(o.setupId, (counts.get(o.setupId) ?? 0) + 1);
      // At least the confirmed bullish setup should appear at multiple eval bars.
      expect([...counts.values()].some((n) => n > 1)).toBe(true);
    });

    it("opportunities carry non-negative scores and integer ranks", () => {
      const r = run();
      for (const o of r.opportunities) {
        expect(Number.isInteger(o.rank)).toBe(true);
        expect(o.rank).toBeGreaterThanOrEqual(1);
        expect(o.score).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ------------------------------------------------------------------------
  describe("selection grammar", () => {
    it("topK marks selected only for rank <= topK", () => {
      const selection: BacktestSelection = { topK: 1 };
      const r = run({ selection });
      for (const o of r.opportunities) {
        expect(o.selected).toBe(o.rank <= 1);
      }
      expect(r.aggregate.selectedObservationCount).toBe(
        r.opportunities.filter((o) => o.selected === true).length,
      );
    });

    it("filters exclude non-matching members — selected absent unless grammar given", () => {
      const r1 = run();
      for (const o of r1.opportunities) expect(o.selected).toBeUndefined();
      const r2 = run({ selection: { filters: { directions: ["bearish"] } } });
      for (const o of r2.opportunities) {
        expect(o.selected).toBe(o.direction === "bearish");
      }
    });
  });

  // ------------------------------------------------------------------------
  describe("edge cases", () => {
    it("empty cells → ok with empty records and zero aggregates", () => {
      const res = runBacktest({ cells: [], config: CFG });
      expect(res.ok).toBe(true);
      const d = res.data!;
      expect(d.opportunities).toEqual([]);
      expect(d.aggregate.observationCount).toBe(0);
      expect(d.aggregate.uniqueSetupCount).toBe(0);
      expect(d.aggregate.resolvedOutcomeCount).toBe(0);
    });

    it("tiny series → ok; malformed series → cell skipped, run continues", () => {
      const tiny = cell("T", "1h", mk().slice(0, 3));
      const bad = cell("B", "1h", [{ ...bar(0, 1, 0.5, 0.4, 0.9) }]); // high < close
      const res = runBacktest({ cells: [bad, tiny], config: CFG });
      expect(res.ok).toBe(true);
      expect(res.data!.cells.map((c) => c.symbol)).toEqual(["B", "T"]);
      expect((res.meta.diagnostics?.cellsSkipped as string).split(",")).toContain("B:1h");
    });

    it("missing backtest.methodVersion → !ok invalid_config", () => {
      const res = runBacktest({ cells: [cell()], config: { ...CFG, backtest: undefined } });
      expect(res.ok).toBe(false);
      expect(res.errors[0].code).toBe("invalid_config");
    });

    it("empty window (startIndex > endIndex) → cell skipped", () => {
      const res = runBacktest({ cells: [cell()], window: { startIndex: 60, endIndex: 10 }, config: CFG });
      expect(res.ok).toBe(true);
      expect(res.data!.opportunities).toEqual([]);
    });

    it("runId and version stamps round-trip", () => {
      const r = run({ runId: "run-1" });
      expect(r.runId).toBe("run-1");
      expect(r.versions.methodVersion).toBe("v1-bt");
      expect(r.versions.configVersion).toBe("v1");
      expect(typeof r.versions.paramsVersion).toBe("string");
    });
  });
});

