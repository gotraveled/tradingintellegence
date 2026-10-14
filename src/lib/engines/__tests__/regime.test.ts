import { describe, expect, it } from "vitest";
import type {
  Candle,
  MarketStructure,
  MomentumConfig,
  MomentumFeatures,
  RegimeConfig,
  RegimeLabel,
  StructureConfig,
  SwingConfig,
  TrendState,
} from "@/lib/types";
import { classifyRegime, createMarketRegimeEngine, regimeStateAt } from "../regime";
import { swingStateAt } from "../swing";
import { structureStateAt } from "../structure";
import { momentumStateAt } from "../momentum";

// ---- Fixtures ---------------------------------------------------------------

const T0 = Date.parse("2026-01-01T00:00:00Z");
const H = 3_600_000;
const ISO = (ms: number) => new Date(ms).toISOString();

const CFG: RegimeConfig = {
  expandAtrTrend: 1.5,
  compressAtrTrend: 0.7,
  // reserved spec-19 fields — present for the contract, never consumed
  atrLength: 14,
  atrLookback: 20,
  minBars: 1,
};

const mkStructure = (trend: TrendState): MarketStructure => ({
  symbol: "T",
  timeframe: "1h",
  trend,
  bias: "neutral",
  swings: [],
  updatedAt: ISO(T0),
});

const feat = (atrTrend?: number): MomentumFeatures | undefined =>
  atrTrend === undefined ? undefined : { atrTrend };

const cls = (trend: TrendState, atrTrend?: number, cfg: RegimeConfig = CFG) =>
  classifyRegime({ structure: mkStructure(trend), features: feat(atrTrend), config: cfg });

const TRENDS: TrendState[] = ["uptrend", "downtrend", "range", "transition"];

// ---- A. All six states -------------------------------------------------------

describe("spec 27 — all six states", () => {
  it.each<[TrendState, number | undefined, RegimeLabel, number]>([
    ["uptrend", 2.0, "high_volatility", 1],
    ["uptrend", 0.5, "low_volatility", 2],
    ["uptrend", 1.0, "trending_bullish", 3],
    ["downtrend", 1.0, "trending_bearish", 4],
    ["range", 1.0, "ranging", 5],
    ["transition", 1.0, "transition", 6],
  ])("%s + atrTrend=%s → %s (rule %d)", (trend, atr, want, rule) => {
    const r = cls(trend, atr);
    expect(r.ok).toBe(true);
    expect(r.data?.regime).toBe(want);
    expect(r.meta.stage).toBe("regime");
    expect(r.meta.barsConsumed).toEqual({ from: -1, to: -1 });
    expect(r.meta.diagnostics?.rule).toBe(rule);
  });
});

// ---- B. Precedence — volatility dominates direction --------------------------

describe("spec 27 — precedence", () => {
  it("high volatility overrides every trend", () => {
    for (const trend of TRENDS) {
      expect(cls(trend, 2.0).data?.regime).toBe("high_volatility");
    }
  });

  it("low volatility overrides every trend", () => {
    for (const trend of TRENDS) {
      expect(cls(trend, 0.5).data?.regime).toBe("low_volatility");
    }
  });
});

// ---- C. Boundaries ------------------------------------------------------------

describe("spec 27 — boundaries", () => {
  it("atrTrend == expandAtrTrend → high_volatility", () => {
    for (const trend of TRENDS) {
      expect(cls(trend, CFG.expandAtrTrend).data?.regime).toBe("high_volatility");
    }
  });

  it("atrTrend == compressAtrTrend → low_volatility", () => {
    for (const trend of TRENDS) {
      expect(cls(trend, CFG.compressAtrTrend).data?.regime).toBe("low_volatility");
    }
  });

  it("just inside the band: 1.5-ε and 0.7+ε → middle-band rules", () => {
    expect(cls("uptrend", CFG.expandAtrTrend - 1e-9).data?.regime).toBe("trending_bullish");
    expect(cls("uptrend", CFG.compressAtrTrend + 1e-9).data?.regime).toBe("trending_bullish");
  });
});

// ---- D. Middle band -----------------------------------------------------------

describe("spec 27 — middle band", () => {
  it.each<[TrendState, RegimeLabel]>([
    ["uptrend", "trending_bullish"],
    ["downtrend", "trending_bearish"],
    ["range", "ranging"],
    ["transition", "transition"],
  ])("%s + mid atrTrend → %s", (trend, want) => {
    expect(cls(trend, 1.0).data?.regime).toBe(want);
  });
});

// ---- E. Missing ATR -----------------------------------------------------------

describe("spec 27 — missing atrTrend → absent", () => {
  it.each<[TrendState, RegimeLabel]>([
    ["uptrend", "transition"],
    ["downtrend", "transition"],
    ["range", "ranging"],
    ["transition", "transition"],
  ])("%s + features undefined → %s", (trend, want) => {
    expect(cls(trend, undefined).data?.regime).toBe(want);
  });

  it.each<[TrendState, RegimeLabel]>([
    ["uptrend", "transition"],
    ["downtrend", "transition"],
    ["range", "ranging"],
    ["transition", "transition"],
  ])("%s + features present but atrTrend absent → %s", (trend, want) => {
    const r = classifyRegime({
      structure: mkStructure(trend),
      features: {}, // features exist, atrTrend not yet computed
      config: CFG,
    });
    expect(r.data?.regime).toBe(want);
    expect(r.meta.diagnostics?.atrTrend).toBe("absent");
  });
});

// ---- F. Invalid runtime ATR → absent semantics --------------------------------

describe("spec 27 — non-finite atrTrend treated as absent", () => {
  it.each([NaN, Infinity, -Infinity])("uptrend + atrTrend=%s → transition", (bad) => {
    expect(cls("uptrend", bad).data?.regime).toBe("transition");
  });

  it.each([NaN, Infinity, -Infinity])("range + atrTrend=%s → ranging", (bad) => {
    expect(cls("range", bad).data?.regime).toBe("ranging");
  });
});

// ---- G. Invalid configuration -------------------------------------------------

describe("spec 27 — invalid_config", () => {
  const bad = (over: Partial<RegimeConfig>) => ({ ...CFG, ...over });

  it.each<[string, RegimeConfig]>([
    ["expand == compress", bad({ expandAtrTrend: 0.7 })],
    ["expand < compress", bad({ expandAtrTrend: 0.5 })],
    ["expand <= 0", bad({ expandAtrTrend: -1 })],
    ["compress <= 0", bad({ compressAtrTrend: 0 })],
    ["compress negative", bad({ compressAtrTrend: -0.5 })],
    ["expand NaN", bad({ expandAtrTrend: NaN })],
    ["compress NaN", bad({ compressAtrTrend: NaN })],
    ["expand +Infinity", bad({ expandAtrTrend: Infinity })],
    ["expand -Infinity", bad({ expandAtrTrend: -Infinity })],
    ["compress +Infinity", bad({ compressAtrTrend: Infinity })],
  ])("%s → invalid_config", (_name, cfg) => {
    const r = classifyRegime({
      structure: mkStructure("uptrend"),
      features: feat(1.0),
      config: cfg,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("invalid_config");
    expect(r.meta.stage).toBe("regime");
  });

  it("paramsVersion stamps only the consumed thresholds", () => {
    const r = cls("uptrend", 1.0);
    expect(r.meta.paramsVersion).toBe("e1.5|c0.7");
  });
});

// ---- H. Causality — prefix/full-series equivalence ----------------------------

describe("spec 27 — causal point-in-time equivalence", () => {
  const SWING_CFG: SwingConfig = {
    leftBars: 1,
    rightBars: 1,
    atrLength: 5,
    minSignificanceAtr: 0.1,
    equalToleranceAtr: 0.15,
    mergeEqual: true,
  };
  const STRUCT_CFG: StructureConfig = {
    classifyToleranceAtr: 0.15,
    minBreakAtr: 0.05,
    failedBreakBars: 3,
    minSwingsForTrend: 2,
  };
  const MOM_CFG: MomentumConfig = {
    lookback: 10,
    atrLength: 5,
    trendShift: 5,
    vol: { fast: 3, slow: 8 },
    state: { strengthMoveAtr: 0.5, strengthBodyAtr: 0.5, weakenFactor: 0.6, biasMoveAtr: 0.3 },
    disp: {
      bars: 3,
      threshold: 50,
      weights: { body: 0.25, range: 0.2, close: 0.15, dir: 0.15, move: 0.15, vol: 0.05, struct: 0.05 },
    },
  };

  /** Drift + multiplicatively expanding bar ranges — ATR grows ~1.15×/bar so
   *  `atrTrend` (ATR now ÷ ATR trendShift bars ago ≈ 1.15⁵ ≈ 2.0) lands rule 1
   *  → `high_volatility` regardless of structure trend. Deterministic, no RNG. */
  const mkCandles = (n: number): Candle[] =>
    Array.from({ length: n }, (_, i) => {
      const c = 100 + i * 0.5;
      const w = 0.3 * Math.pow(1.15, i);
      return { time: T0 + i * H, open: c - 0.1, high: c + w, low: c - w, close: c + 0.1 };
    });

  const stateAt = (candles: Candle[], t: number) => {
    const swings = swingStateAt(candles, "T", "1h", SWING_CFG, "v1", t);
    return {
      structure: structureStateAt(candles, swings, "T", "1h", STRUCT_CFG, "v1", t),
      features: momentumStateAt(candles, "T", "1h", MOM_CFG, "v1", t).features,
    };
  };

  it("regimeStateAt(t) identical on prefix vs full series", () => {
    const full = mkCandles(80);
    const t = 55;
    const prefix = full.slice(0, t + 1);

    const p = stateAt(prefix, t);
    const f = stateAt(full, t);

    // upstream providers already expose identical PIT state at t…
    expect(p.structure.trend).toBe(f.structure.trend);
    expect(p.features?.atrTrend).toBe(f.features?.atrTrend);

    // …so the composed regime label is identical — regimeStateAt sees nothing else.
    const rp = regimeStateAt(p.structure, p.features, CFG);
    const rf = regimeStateAt(f.structure, f.features, CFG);
    expect(rp).toBe(rf);
    expect(rf).toBe("high_volatility"); // expanding ATR — rule 1, trend-independent
  });
});

// ---- I. Determinism ------------------------------------------------------------

describe("spec 27 — determinism", () => {
  it("same snapshot + config → identical result (deep)", () => {
    const input = { structure: mkStructure("uptrend"), features: feat(1.0), config: CFG };
    expect(classifyRegime(input)).toEqual(classifyRegime(input));
    expect(classifyRegime(input)).toEqual(classifyRegime(input));
  });
});

// ---- J. Adapter parity ----------------------------------------------------------

describe("spec 27 — engine adapter", () => {
  it("createMarketRegimeEngine().classify === classifyRegime", () => {
    const engine = createMarketRegimeEngine();
    const input = {
      structure: mkStructure("downtrend"),
      features: { atrTrend: 0.9 },
      config: CFG,
    };
    expect(engine.classify(input)).toEqual(classifyRegime(input));
  });

  it("regimeStateAt returns the label, transition on invalid config", () => {
    expect(regimeStateAt(mkStructure("range"), feat(1.0), CFG)).toBe("ranging");
    expect(
      regimeStateAt(mkStructure("uptrend"), feat(1.0), { ...CFG, expandAtrTrend: 0.7 }),
    ).toBe("transition");
  });
});
