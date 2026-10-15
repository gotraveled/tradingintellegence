import type { EngineConfig } from "@/lib/types";

/**
 * Canonical V1 engine parameter set — the `defaultConfig()` factory spec 21 names
 * ("defaults live in one factory, versioned like everything else"). One object, one
 * `version`; a param change means a new version and results are never comparable across
 * versions (spec 21 / spec 15 paramsVersion rule).
 *
 * Sourcing: every value traces to its spec's parameter table where one exists. Where the
 * spec left the value caller-supplied or undocumented (`breakout.dispBars`,
 * `breakout.anchorNearAtr`, `fvg.atrLength`, `liquidity.range.lookbackBars`,
 * `lifecycle.*`, `mtf.weights`, `momentum.disp.bars`), the V1 value is marked — these are
 * product-layer defaults, never hidden constants inside engine logic.
 *
 * Dormant fields stay dormant: `regime.minBars` is the reserved hysteresis slot
 * (spec 19 — activation requires backtest evidence of regime noise); it is never consumed
 * by the regime engine.
 */
export const ENGINE_CONFIG_VERSION = "v1-engine";

export function defaultConfig(): EngineConfig {
  return {
    version: ENGINE_CONFIG_VERSION,
    // spec 01: providers may refuse input above `maxMissingBarPct` (default 2%).
    marketData: { maxMissingBarPct: 2 },
    // spec 02 parameter table.
    swing: {
      leftBars: 3,
      rightBars: 3,
      atrLength: 14,
      minSignificanceAtr: 0.25,
      equalToleranceAtr: 0.05,
      mergeEqual: true,
    },
    // spec 03 parameter table.
    structure: {
      classifyToleranceAtr: 0.05,
      minBreakAtr: 0.1,
      failedBreakBars: 3,
      minSwingsForTrend: 3,
    },
    // spec 04 parameter table. `range.lookbackBars` is an implementation-added typed
    // field (spec names the window, no default) — V1 platform value.
    liquidity: {
      equalToleranceAtr: 0.05,
      clusterMinCount: 3,
      clusterWidthAtr: 0.25,
      poolExpiryBars: 250,
      sweep: {
        minPenetrationAtr: 0.05,
        maxReclaimBars: 3,
        displacementBars: 3,
        displacementBodyAtr: 0.6,
        displacementRangeAtr: 1.2,
      },
      break: { minCloseAtr: 0.1, holdBars: 5, retestWindow: 10 },
      range: { lookbackBars: 20 }, // V1: undocumented in spec 04 — caller-owned value.
    },
    // spec 05/06/07 parameter tables + the shared zone-strength weight table (spec 06 §"Zone
    // strength"). `gapInvalidates` is a per-market rule (spec 06: true for sessioned
    // equities/indices, false for continuous markets) — the V1 global default is `false`;
    // market-specific behaviour belongs to `zone.sideOverrides`-style configuration, not a
    // hidden branch.
    zone: {
      leg: { lookbackBars: 5, minMoveAtr: 1.0 },
      base: { minBars: 2, maxBars: 10, maxRangeAtr: 1.0, maxBodyAtr: 0.5 },
      departure: {
        minMoveAtr: 1.5,
        maxBars: 5,
        displacementBodyAtr: 0.6,
        displacementRangeAtr: 1.2,
      },
      retest: {
        depthMitigatedPct: 80,
        invalidateCloseAtr: 0.1,
        maxRetests: 3,
        retestDecay: 0.15,
        depthDecay: 0.7,
      },
      freshnessMaxBars: 500,
      boundaryMode: "extremes",
      gapInvalidates: false,
      weights: {
        departureStrength: 0.25,
        structureBreak: 0.15,
        liquidityInteraction: 0.15,
        freshness: 0.15,
        fvgAssociation: 0.1,
        htfConfluence: 0.1,
        volumeExpansion: 0.05,
        zoneWidth: 0.05,
      },
    },
    // spec 08 parameter table. `fvg.atrLength` is an implementation-added typed field
    // (spec's `ATR[i+1]` needs a window) — V1 uses the engine-wide Wilder convention.
    fvg: {
      minGapAtr: 0.15,
      minMidBodyAtr: 0.3,
      partialFillPct: 50,
      invalidateAtr: 0.1,
      expiryBars: 200,
      atrLength: 14, // V1: spec adds no window default — Wilder ATR(14) convention.
    },
    // spec 09: lookback 10, ATR(14), atrTrend baseline "20 bars ago" → trendShift,
    // vol windows 5/20, state thresholds 1.5/0.6/0.7/0.5, disp weights table, threshold 60.
    // `disp.bars` has no spec-table default — V1 matches `liquidity.sweep.displacementBars`.
    momentum: {
      lookback: 10,
      atrLength: 14,
      trendShift: 20,
      vol: { fast: 5, slow: 20 },
      state: {
        strengthMoveAtr: 1.5,
        strengthBodyAtr: 0.6,
        weakenFactor: 0.7,
        biasMoveAtr: 0.5,
      },
      disp: {
        bars: 3, // V1: caller-supplied per spec 09/13 — matches the sweep window.
        threshold: 60,
        weights: { body: 0.2, range: 0.15, close: 0.15, dir: 0.15, move: 0.15, vol: 0.05, struct: 0.15 },
      },
    },
    // spec 10/23: default frame set 4H/1H/15M. `weights` — spec names the weighted vote
    // without values; V1 keeps the test-suite convention (0.5/0.3/0.2).
    mtf: {
      set: { htf: "4h", itf: "1h", etf: "15m" },
      weights: { htf: 0.5, itf: 0.3, etf: 0.2 }, // V1: undocumented in spec 10 — caller-owned.
    },
    // spec 11 names `expiryBars`/`invalidateAtr` without a parameter table — V1 values.
    lifecycle: { expiryBars: 200, invalidateAtr: 0.5 }, // V1: undocumented in spec 11.
    // spec 12 parameter table.
    reversal: {
      zoneMaxAgeBars: 500,
      zoneMinStrength: 50,
      sweepMaxAgeBars: 10,
      dispMinScore: 60,
      entryZoneDepth: 0.5,
      invalidateAtr: 0.1,
    },
    // spec 13 parameter table. `dispBars` is caller-supplied per spec ("pass
    // `momentum.disp.bars`-consistent values"); `anchorNearAtr` is spec-required but has no
    // default — both V1 platform values.
    breakout: {
      rangeMinBars: 15,
      rangeMaxWidthAtr: 2.5,
      compressionRatio: 0.7,
      compressionBars: 10,
      breakAtr: 0.15,
      dispMinScore: 60,
      dispBars: 3, // V1: consistent with `momentum.disp.bars` per spec-13 note.
      holdBars: 5,
      retestWindow: 10,
      volumeMinRatio: 1.3,
      anchorNearAtr: 0.5, // V1: spec ties boundary to a pool, defines no tolerance.
    },
    // spec 14 parameter table.
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
    // spec 15 dimensions table (max points) + `minRR` gate default 1.5. `regimeMatrix`
    // ships empty — V1 has no evidence-tuned multipliers (spec 15: fit on outcomes later).
    scoring: {
      minRR: 1.5,
      weights: {
        structure: 20,
        liquidity: 15,
        zoneQuality: 20,
        displacement: 15,
        momentum: 10,
        htfAlignment: 10,
        freshness: 5,
        fvg: 5,
      },
      regimeMatrix: {},
    },
    // spec 19: atrTrend thresholds 1.5/0.7 over ATR(14)/20-bar baseline. `minBars` is the
    // documented-but-deferred hysteresis slot — dormant, never consumed by the engine.
    regime: {
      expandAtrTrend: 1.5,
      compressAtrTrend: 0.7,
      atrLength: 14,
      atrLookback: 20,
      minBars: 5, // dormant — spec-19 example value only; no activation condition met.
    },
    // spec 24 documented V1 defaults (engine fallback grammar).
    stats: {
      minSamples: 30,
      scoreBands: [0, 50, 70, 85],
      methodVersion: "v1-empirical",
    },
    // spec 25/26 methodology stamps — V1 grammar, caller versioned.
    scanner: { topK: 0, includeDeveloping: false, methodVersion: "v1-scan" },
    backtest: { methodVersion: "v1-bt" },
  };
}
