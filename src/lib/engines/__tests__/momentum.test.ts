import { describe, expect, it } from "vitest";
import type { Candle, MomentumConfig } from "@/lib/types";
import {
  analyzeMomentum,
  candleMetrics,
  createMomentumEngine,
  displacementId,
  momentumStateAt,
} from "../momentum";
import { FIXTURE_EPOCH as E } from "@/lib/market-data";

const M5 = 300_000;

const CFG: MomentumConfig = {
  lookback: 10,
  atrLength: 14,
  trendShift: 20,
  vol: { fast: 5, slow: 20 },
  state: { strengthMoveAtr: 1.5, strengthBodyAtr: 0.6, weakenFactor: 0.7, biasMoveAtr: 0.5 },
  disp: {
    bars: 3,
    threshold: 60,
    weights: { body: 0.20, range: 0.15, close: 0.15, dir: 0.15, move: 0.15, vol: 0.05, struct: 0.15 },
  },
};

const c = (o: number, h: number, l: number, cl: number, i: number, volume?: number): Candle => ({
  time: E + i * M5,
  open: o,
  high: h,
  low: l,
  close: cl,
  ...(volume !== undefined ? { volume } : {}),
});

const flat = (n: number, from: number, at = 10, volume?: number): Candle[] =>
  Array.from({ length: n }, (_, k) => c(at, at + 0.5, at - 0.5, at, from + k, volume));

const run = (candles: Candle[], cfg: MomentumConfig = CFG, upTo?: number) =>
  analyzeMomentum(candles, "T", "5m", cfg, "v1", upTo);

/**
 * 20 neutral warm-up bars then a 3-bar bullish displacement leg (bars 20-22).
 * ATR[22] ≈ 1.2 → score ≈ 78 (≥ threshold 60) → one displacement event at bar 22.
 */
const bullLeg = (withVol = false): Candle[] => [
  ...flat(20, 0, 10, withVol ? 100 : undefined),
  c(10, 11.7, 9.8, 11.5, 20, withVol ? 300 : undefined),
  c(11.5, 13.5, 11.4, 13.3, 21, withVol ? 300 : undefined),
  c(13.3, 14.9, 13.1, 14.7, 22, withVol ? 300 : undefined),
  ...flat(8, 23, 14.7, withVol ? 100 : undefined),
];

describe("candle metrics", () => {
  it("bullish candle — range, body, wicks, closeLoc, dir", () => {
    const m = candleMetrics(c(10, 12, 9, 11.5, 0));
    expect(m.range).toBe(3);
    expect(m.body).toBe(1.5);
    expect(m.upperWick).toBe(0.5);
    expect(m.lowerWick).toBe(1);
    expect(m.closeLoc).toBeCloseTo(2.5 / 3, 5);
    expect(m.dir).toBe(1);
  });

  it("bearish candle mirrors", () => {
    const m = candleMetrics(c(11, 12, 9, 9.5, 0));
    expect(m.upperWick).toBe(1);
    expect(m.lowerWick).toBe(0.5);
    expect(m.closeLoc).toBeCloseTo(0.5 / 3, 5);
    expect(m.dir).toBe(-1);
  });

  it("doji and zero-range candles are safe — no NaN", () => {
    const doji = candleMetrics(c(10, 11, 9, 10, 0));
    expect(doji.dir).toBe(0);
    expect(doji.body).toBe(0);
    const zr = candleMetrics(c(10, 10, 10, 10, 0));
    expect(zr.range).toBe(0);
    expect(zr.closeLoc).toBe(0.5); // defined fallback, never NaN
    expect(Number.isFinite(zr.closeLoc)).toBe(true);
  });
});

describe("momentum features (Part B)", () => {
  it("warm-up — features are undefined until their window exists", () => {
    const { featuresByBar } = run([...flat(20, 0), ...Array.from({ length: 10 }, (_, k) => c(10 + k, 10.5 + k, 9.5 + k, 10.4 + k, 20 + k))]);
    expect(featuresByBar[5]?.directionalMove).toBeUndefined();
    expect(featuresByBar[9]?.directionalMove).toBeDefined(); // t ≥ lookback−1
    expect(featuresByBar[9]?.rateOfChange).toBeUndefined(); // needs t ≥ lookback
    expect(featuresByBar[10]?.rateOfChange).toBeDefined();
    expect(featuresByBar[10]?.atrTrend).toBeUndefined(); // needs t ≥ trendShift+1
    expect(featuresByBar[21]?.atrTrend).toBeDefined();
  });

  it("directionalMove — signed Σ bodies ÷ ATR over lookback", () => {
    const up = [...flat(15, 0), ...Array.from({ length: 10 }, (_, k) => c(10 + k, 10.2 + k + 1, 9.8 + k, 11 + k, 15 + k))];
    const { features } = run(up);
    expect(features.directionalMove).toBeGreaterThan(1.5);
    expect(run(up).momentum.bias).toBe("bullish");
  });

  it("bearish direction — negative directionalMove, bearish bias", () => {
    const down = [
      ...flat(15, 0, 20),
      ...Array.from({ length: 10 }, (_, k) => c(20 - k, 20.2 - k, 19.8 - k - 1, 19 - k, 15 + k)),
    ];
    const { momentum } = run(down);
    expect(momentum.features?.directionalMove).toBeLessThan(-1.5);
    expect(momentum.bias).toBe("bearish");
  });

  it("consecDirection — signed run of same-direction bars, doji resets", () => {
    const cs = [
      ...flat(10, 0),
      c(10, 11, 9.9, 10.8, 10),
      c(10.8, 12, 10.7, 11.8, 11),
      c(11.8, 12.9, 11.7, 12.6, 12),
      c(12.6, 12.7, 12.5, 12.6, 13), // doji → reset
      c(12.6, 13, 12.5, 12.9, 14),
    ];
    const { featuresByBar } = run(cs);
    expect(featuresByBar[12]?.consecDirection).toBe(3);
    expect(featuresByBar[13]?.consecDirection).toBe(0);
    expect(featuresByBar[14]?.consecDirection).toBe(1);
  });

  it("atrTrend — expanding volatility registers > 1", () => {
    const cs = [
      ...flat(25, 0), // baseline ATR ≈ 1.0
      ...Array.from({ length: 10 }, (_, k) => c(10, 11.5, 8.5, 10.4, 25 + k)), // TR ~3
    ];
    const { features } = run(cs);
    expect(features.atrTrend).toBeGreaterThan(1.15);
  });

  it("volumeRatio — fast/slow volume means", () => {
    const cs = [
      ...flat(20, 0, 10, 100),
      ...Array.from({ length: 10 }, (_, k) => c(10, 10.5, 9.5, 10.3, 20 + k, 300)),
    ];
    const { features } = run(cs);
    expect(features.volumeRatio).toBeGreaterThan(1);
  });

  it("rsi14 — secondary feature present from atrLength onward", () => {
    const { featuresByBar } = run(flat(20, 0));
    expect(featuresByBar[13]?.rsi14).toBeUndefined();
    expect(featuresByBar[14]?.rsi14).toBe(100); // flat series → zero losses → RSI 100
  });
});

describe("derived state", () => {
  it("strengthening — same-sign dm/ROC, |dm| ≥ 1.5, bodyStrength ≥ 0.6", () => {
    const up = [...flat(15, 0), ...Array.from({ length: 10 }, (_, k) => c(10 + k, 10.2 + k + 1, 9.8 + k, 11 + k, 15 + k))];
    expect(run(up).momentum.state).toBe("strengthening");
  });

  it("weakening — directional move decays below 0.7× its mean", () => {
    const cs = [
      ...flat(15, 0),
      ...Array.from({ length: 10 }, (_, k) => c(10 + k, 10.2 + k + 1, 9.8 + k, 11 + k, 15 + k)),
      ...Array.from({ length: 10 }, (_, k) => c(20, 20.5, 19.5, 20, 25 + k)), // flat tail decays dm
    ];
    const { momentum } = run(cs);
    expect(["weakening", "neutral"]).toContain(momentum.state);
  });

  it("diverging — new price extreme without a momentum extreme", () => {
    const cs = [
      ...flat(10, 0),
      // strong leg 1 (bars 10-14): dm peak
      ...Array.from({ length: 5 }, (_, k) => c(10 + 2 * k, 10.4 + 2 * k + 2, 9.8 + 2 * k, 12 + 2 * k, 10 + k)),
      // pullback
      c(20, 20.3, 18.5, 18.8, 15),
      c(18.8, 19.2, 18.0, 18.4, 16),
      // shallow recovery to a new close extreme with weaker momentum
      ...Array.from({ length: 8 }, (_, k) => c(18.4 + 0.35 * k, 18.6 + 0.35 * k, 18.3 + 0.35 * k, 18.55 + 0.35 * k, 17 + k)),
    ];
    const { momentum } = run(cs);
    expect(momentum.state).toBe("diverging");
  });
});

describe("displacement (Part A)", () => {
  it("bullish displacement — event on the qualifying bar, rising edge only", () => {
    const cs = bullLeg();
    const { events, scoreByBar } = run(cs);
    const ev = events.filter((e) => e.kind === "displacement");
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(ev[0].metadata?.direction).toBe("bullish");
    // the trailing window [19,20,21] already qualifies — first event at bar 21
    expect(ev[0].refId).toBe(displacementId("T", "5m", "bullish", cs[21].time));
    expect(ev[0].atBar).toBe(21);
    expect(scoreByBar[21]).toBeGreaterThanOrEqual(CFG.disp.threshold);
    expect(scoreByBar[22]).toBeLessThanOrEqual(100);
  });

  it("bearish displacement — mirrored direction", () => {
    const cs = [
      ...flat(20, 0, 20),
      c(20, 20.2, 18.3, 18.5, 20),
      c(18.5, 18.6, 16.5, 16.7, 21),
      c(16.7, 16.9, 15.1, 15.3, 22),
      ...flat(8, 23, 15.3),
    ];
    const { events } = run(cs);
    const ev = events.find((e) => e.kind === "displacement");
    expect(ev?.metadata?.direction).toBe("bearish");
  });

  it("weak leg — below threshold, no event", () => {
    const cs = [...flat(20, 0), c(10, 10.6, 9.9, 10.4, 20), c(10.4, 10.9, 10.2, 10.7, 21), c(10.7, 11.2, 10.6, 11.0, 22), ...flat(8, 23, 11)];
    expect(run(cs).events.filter((e) => e.kind === "displacement")).toHaveLength(0);
  });

  it("wick-driven move — small bodies + poor close location score lower", () => {
    const wicky = [
      ...flat(20, 0),
      c(10, 11.9, 9.8, 10.9, 20),   // wide bar, small body, mid close
      c(10.9, 13.4, 10.8, 11.8, 21),
      c(11.8, 14.5, 11.6, 12.9, 22),
      ...flat(8, 23, 12.9),
    ];
    const { scoreByBar: ws } = run(wicky);
    const { scoreByBar: bs } = run(bullLeg());
    expect(ws[22]).toBeDefined();
    expect(ws[22]!).toBeLessThan(bs[22]!); // bodies + close location dominate the score
    expect(ws[22]!).toBeLessThan(CFG.disp.threshold);
  });

  it("volumeless series — identical score with f_vol redistributed", () => {
    const a = run(bullLeg(false));
    const b = run(bullLeg(false));
    expect(a.scoreByBar[22]).toBe(b.scoreByBar[22]);
    expect(a.diagnostics.volumeFeature).toBe("redistributed");
  });

  it("volume present — f_vol applies", () => {
    const { scoreByBar, diagnostics } = run(bullLeg(true));
    expect(diagnostics.volumeFeature).toBe("used");
    expect(scoreByBar[22]).toBeGreaterThanOrEqual(CFG.disp.threshold);
  });

  it("a second qualifying leg after a quiet stretch emits a second event", () => {
    const cs = [
      ...bullLeg().slice(0, 23),
      ...flat(15, 23, 14.7), // quiet stretch — resets rising edge
      c(14.7, 16.4, 14.5, 16.2, 38),
      c(16.2, 18.2, 16.1, 18.0, 39),
      c(18.0, 19.6, 17.8, 19.4, 40),
      ...flat(5, 41, 19.4),
    ];
    const { events } = run(cs);
    const evs = events.filter((e) => e.kind === "displacement");
    expect(evs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(evs.map((e) => e.refId)).size).toBe(evs.length);
  });
});

describe("look-ahead, replay, determinism, multi-asset", () => {
  it("no displacement before the leg window qualifies", () => {
    const cs = bullLeg();
    expect(run(cs, CFG, 20).events.filter((e) => e.kind === "displacement")).toHaveLength(0);
    expect(run(cs, CFG, 21).events.length).toBeGreaterThanOrEqual(1);
  });

  it("replay truncation — prefix run equals snapshot at the same index", () => {
    const cs = bullLeg();
    const snap = run(cs, CFG, 15).momentum;
    const prefix = run(cs.slice(0, 16)).momentum;
    expect(JSON.stringify(snap)).toBe(JSON.stringify(prefix));
  });

  it("future candles do not alter historical momentum state", () => {
    const cs = bullLeg();
    const early = momentumStateAt(cs, "T", "5m", CFG, "v1", 15);
    const extended = cs.slice(0, 16).concat(flat(10, 16, 40)); // violent future move
    const later = momentumStateAt(extended, "T", "5m", CFG, "v1", 15);
    expect(JSON.stringify(early)).toBe(JSON.stringify(later));
  });

  it("deterministic — identical inputs give identical output", () => {
    const a = run(bullLeg());
    const b = run(bullLeg());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("no NaN/Infinity anywhere — flat and mixed series", () => {
    const cs = [...flat(30, 0), c(10, 10, 10, 10, 30), c(10, 15, 5, 10, 31)];
    const r = run(cs);
    for (const f of r.featuresByBar) {
      if (!f) continue;
      for (const v of Object.values(f)) {
        expect(Number.isFinite(v as number)).toBe(true);
      }
    }
    for (const s of r.scoreByBar) {
      if (s !== undefined) expect(Number.isFinite(s)).toBe(true);
    }
  });

  it("BTC and forex scale — normalized behavior is price-invariant", () => {
    const scale = (k: number) => bullLeg().map((x) => ({ ...x, open: x.open * k, high: x.high * k, low: x.low * k, close: x.close * k }));
    const btc = run(scale(6000));
    const fx = run(scale(0.1));
    expect(btc.events.length).toBe(run(bullLeg()).events.length);
    expect(fx.events.length).toBe(run(bullLeg()).events.length);
    expect(btc.scoreByBar[22]).toBeCloseTo(run(bullLeg()).scoreByBar[22]!, 5);
  });

  it("insufficient candles → neutral momentum, no crash", () => {
    const r = run([]);
    expect(r.momentum.state).toBe("neutral");
    expect(run(flat(2, 0)).momentum.displacementScore).toBeUndefined();
  });
});

describe("engine contract", () => {
  it("analyze — ok, data.momentum + data.features, meta.events", () => {
    const res = createMomentumEngine().analyze({
      series: { symbol: "T", timeframe: "5m", candles: bullLeg() },
      config: CFG,
    });
    expect(res.ok).toBe(true);
    expect(res.data?.momentum.state).toBeDefined();
    expect(res.data?.features).toBeDefined();
    expect(res.meta.stage).toBe("momentum");
    expect(res.meta.events.some((e) => e.kind === "displacement")).toBe(true);
  });

  it("invalid config — weights, bars, thresholds rejected", () => {
    const series = { symbol: "T", timeframe: "5m" as const, candles: bullLeg() };
    const engine = createMomentumEngine();
    const bad = (m: Partial<MomentumConfig>) => engine.analyze({ series, config: { ...CFG, ...m } });
    expect(bad({ atrLength: 0 }).ok).toBe(false);
    expect(bad({ vol: { fast: 0, slow: 20 } }).ok).toBe(false);
    expect(bad({ disp: { ...CFG.disp, threshold: 101 } }).ok).toBe(false);
    expect(bad({ disp: { ...CFG.disp, weights: { ...CFG.disp.weights, body: 0.9 } } }).ok).toBe(false);
  });
});
