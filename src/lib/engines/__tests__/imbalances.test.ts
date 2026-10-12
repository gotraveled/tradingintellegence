import { describe, expect, it } from "vitest";
import type { Candle, FVGConfig } from "@/lib/types";
import { analyzeImbalances, createImbalanceEngine, fvgId, imbalanceStateAt } from "../imbalances";
import { FIXTURE_EPOCH as E } from "@/lib/market-data";

const M5 = 300_000;

const CFG: FVGConfig = {
  atrLength: 5,
  minGapAtr: 0.15,
  minMidBodyAtr: 0.3,
  partialFillPct: 50,
  invalidateAtr: 0.1,
  expiryBars: 200,
};

const c = (o: number, h: number, l: number, cl: number, i: number): Candle => ({
  time: E + i * M5,
  open: o,
  high: h,
  low: l,
  close: cl,
});

const set = (cs: Candle[], i: number, p: Partial<Candle>) => Object.assign(cs[i], p);
const flat = (n: number, from: number, at = 10): Candle[] =>
  Array.from({ length: n }, (_, k) => c(at, at + 0.5, at - 0.5, at, from + k)); // TR = 1.0

/**
 * Canonical bullish FVG (spec 08 triplet at bars 5,6,7 — ATR[6] = 1.12):
 * A(5) H10.5; B(6) bullish body 1.3 (≥0.3×ATR); C(7) low 10.9 > high[A] 10.5 → gap 0.4.
 * upper = 10.9, lower = 10.5, height 0.4. Tail bars stay above the gap.
 */
const bull = (): Candle[] => [
  ...flat(5, 0),
  c(10, 10.5, 9.5, 10, 5),
  c(10.2, 11.6, 10.0, 11.5, 6),
  c(11.3, 11.8, 10.9, 11.4, 7),
  ...Array.from({ length: 13 }, (_, k) => c(11.4, 11.9, 11.0, 11.4, 8 + k)),
];

const run = (candles: Candle[], cfg: FVGConfig = CFG, upTo?: number) =>
  analyzeImbalances(candles, "T", "5m", cfg, "v1", upTo);

describe("fvg formation", () => {
  it("bullish FVG — boundaries, direction, gapAtr, fvg_created event at candle C", () => {
    const cs = bull();
    const { imbalances, events } = run(cs);
    const f = imbalances[0];
    expect(f.direction).toBe("bullish");
    expect(f.upperPrice).toBeCloseTo(10.9); // low[C]
    expect(f.lowerPrice).toBeCloseTo(10.5); // high[A]
    expect(f.gapAtr).toBeCloseTo(0.4 / 1.12, 2);
    expect(f.status).toBe("open");
    expect(f.fillPct).toBe(0);
    expect(f.createdAt).toBe(new Date(cs[7].time).toISOString());
    const ev = events.find((e) => e.kind === "fvg_created");
    expect(ev?.refId).toBe(f.id);
    expect(ev?.atBar).toBe(7);
  });

  it("bearish FVG — mirrored relationship", () => {
    const cs = [
      ...flat(5, 0, 12),
      c(12, 12.5, 11.5, 12, 5),
      c(11.8, 12.0, 10.4, 10.5, 6), // bearish body 1.3
      c(10.7, 11.1, 10.2, 10.6, 7), // high 11.1 < low[A] 11.5 → gap 0.4
      ...Array.from({ length: 13 }, (_, k) => c(10.6, 11.0, 10.1, 10.6, 8 + k)),
    ];
    const { imbalances } = run(cs);
    const f = imbalances[0];
    expect(f.direction).toBe("bearish");
    expect(f.upperPrice).toBeCloseTo(11.5); // low[A] — far boundary
    expect(f.lowerPrice).toBeCloseTo(11.1); // high[C] — entry edge
  });

  it("no FVG — overlapping wicks", () => {
    const { imbalances } = run(flat(15, 0));
    expect(imbalances).toHaveLength(0);
  });

  it("below minGapAtr → no imbalance", () => {
    const cs = bull();
    set(cs, 7, { low: 10.55 }); // gap 0.05 < 0.15×1.12
    expect(run(cs).imbalances).toHaveLength(0);
  });

  it("flat middle candle (< minMidBodyAtr) → no imbalance", () => {
    const cs = bull();
    set(cs, 6, { open: 10.2, close: 10.3 }); // body 0.1
    const { imbalances, diagnostics } = run(cs);
    expect(imbalances).toHaveLength(0);
    expect(diagnostics.rejectedFlatMid).toBeGreaterThan(0);
  });

  it("bearish middle does not qualify a bullish gap", () => {
    const cs = bull();
    set(cs, 6, { open: 11.5, close: 10.2 }); // mid bearish → no bullish FVG
    expect(run(cs).imbalances).toHaveLength(0);
  });

  it("large imbalance — wide gap still one FVG", () => {
    const cs = bull();
    set(cs, 7, { low: 10.9, high: 13.0, close: 12.6, open: 11.4 });
    set(cs, 8, { open: 12.6, high: 12.9, low: 12.0, close: 12.4 });
    const f = run(cs).imbalances[0];
    expect(f.upperPrice).toBeCloseTo(10.9);
    expect(f.lowerPrice).toBeCloseTo(10.5);
  });

  it("multiple independent FVGs on separate triplets", () => {
    const cs = [
      ...bull().slice(0, 11),
      // second bullish triplet at 10,11,12
      c(11.5, 11.7, 11.2, 11.5, 10),
      c(11.6, 12.8, 11.5, 12.6, 11),
      c(12.4, 13.0, 11.9, 12.7, 12), // low 11.9 > high[10] 11.7 → gap 0.2
      ...Array.from({ length: 8 }, (_, k) => c(12.7, 13.2, 12.2, 12.7, 13 + k)),
    ];
    const { imbalances } = run(cs);
    expect(imbalances).toHaveLength(2);
    expect(imbalances.every((f) => f.direction === "bullish")).toBe(true);
    expect(new Set(imbalances.map((f) => f.id)).size).toBe(2);
  });
});

describe("fill lifecycle", () => {
  it("untouched FVG stays open, fillPct 0", () => {
    const f = run(bull()).imbalances[0];
    expect(f.status).toBe("open");
    expect(f.fillPct).toBe(0);
  });

  it("partial fill below partialFillPct → still open with recorded depth", () => {
    const cs = bull();
    set(cs, 8, { low: 10.74, close: 11.2 }); // pen (10.9−10.74)/0.4 = 40%
    const f = run(cs).imbalances[0];
    expect(f.status).toBe("open");
    expect(f.fillPct).toBeCloseTo(40, 1);
  });

  it("partial fill ≥ partialFillPct → partially_filled", () => {
    const cs = bull();
    set(cs, 8, { low: 10.66, close: 11.2 }); // 60%
    const f = run(cs).imbalances[0];
    expect(f.status).toBe("partially_filled");
    expect(f.fillPct).toBeCloseTo(60, 1);
  });

  it("wick through the far boundary → filled (bullish)", () => {
    const cs = bull();
    set(cs, 8, { low: 10.4, close: 11.0 }); // low ≤ lowerPrice 10.5
    const { imbalances, events } = run(cs);
    expect(imbalances[0].status).toBe("filled");
    expect(imbalances[0].fillPct).toBe(100);
    expect(events.some((e) => e.kind === "fvg_filled" && e.refId === imbalances[0].id)).toBe(true);
  });

  it("wick through the far boundary → filled (bearish)", () => {
    const cs = [
      ...flat(5, 0, 12),
      c(12, 12.5, 11.5, 12, 5),
      c(11.8, 12.0, 10.4, 10.5, 6),
      c(10.7, 11.1, 10.2, 10.6, 7),
      c(10.6, 11.6, 10.5, 11.0, 8), // high 11.6 ≥ upper 11.5 → filled
    ];
    const f = run(cs).imbalances[0];
    expect(f.status).toBe("filled");
  });

  it("bearish partial fill — penetration from the lower edge upward", () => {
    const cs = [
      ...flat(5, 0, 12),
      c(12, 12.5, 11.5, 12, 5),
      c(11.8, 12.0, 10.4, 10.5, 6),
      c(10.7, 11.1, 10.2, 10.6, 7),
      c(10.6, 11.26, 10.5, 10.9, 8), // pen (11.26−11.1)/0.4 = 40%
    ];
    const f = run(cs).imbalances[0];
    expect(f.status).toBe("open");
    expect(f.fillPct).toBeCloseTo(40, 1);
  });

  it("close through the far boundary → invalidated, wins over fill", () => {
    const cs = bull();
    set(cs, 8, { low: 10.2, close: 10.3 }); // close < 10.5 − 0.1×1.12 = 10.388 → invalidated (wick also filled it)
    const f = run(cs).imbalances[0];
    expect(f.status).toBe("invalidated");
    expect(f.invalidatedAt).toBe(new Date(cs[8].time).toISOString());
    expect(f.fillPct).toBe(100);
  });

  it("partial fill does NOT invalidate — the gap survives", () => {
    const cs = bull();
    set(cs, 8, { low: 10.5, close: 10.9 }); // touches far boundary exactly → filled, not invalidated
    const f = run(cs).imbalances[0];
    expect(f.status).toBe("filled");
  });

  it("fillPct is monotonic — a shallower dip never regresses depth", () => {
    const cs = bull();
    set(cs, 8, { low: 10.7, close: 11.2 }); // 50%
    set(cs, 9, { low: 10.8, close: 11.3 }); // 25% — no update
    const f = run(cs).imbalances[0];
    expect(f.fillPct).toBeCloseTo(50, 1);
    expect(f.status).toBe("partially_filled");
  });

  it("multiple partial dips accumulate the deepest penetration", () => {
    const cs = bull();
    set(cs, 8, { low: 10.8, close: 11.2 });  // 25%
    set(cs, 9, { low: 10.66, close: 11.2 }); // 60%
    const f = run(cs).imbalances[0];
    expect(f.fillPct).toBeCloseTo(60, 1);
    expect(f.status).toBe("partially_filled");
  });

  it("expiry — expiryBars without fill progress", () => {
    const { imbalances } = run(bull(), { ...CFG, expiryBars: 3 });
    const f = imbalances[0];
    expect(f.status).toBe("expired"); // t − 7 > 3 at bar 11
    expect(f.metadata?.expiredAt).toBeDefined();
  });

  it("fill progress resets the expiry clock", () => {
    const cs = bull();
    set(cs, 9, { low: 10.8, close: 11.2 }); // dip at 9 → progress
    const { imbalances } = run(cs, { ...CFG, expiryBars: 3 });
    // last progress at 9 → expires at bar 13
    const f = imbalances[0];
    expect(f.status).toBe("expired");
    expect(f.metadata?.expiredBar).toBe(13);
  });
});

describe("identity, timing, determinism", () => {
  it("no FVG before candle C is knowable", () => {
    const cs = bull();
    expect(imbalanceStateAt(cs, "T", "5m", CFG, "v1", 6)).toHaveLength(0);
    expect(imbalanceStateAt(cs, "T", "5m", CFG, "v1", 7)).toHaveLength(1);
  });

  it("replay truncation — prefix run equals snapshot at the same index", () => {
    const cs = bull();
    set(cs, 8, { low: 10.66, close: 11.2 });
    const snap = imbalanceStateAt(cs, "T", "5m", CFG, "v1", 10);
    const prefix = run(cs.slice(0, 11)).imbalances;
    expect(JSON.stringify(snap)).toBe(JSON.stringify(prefix));
  });

  it("future candles do not alter historical FVG state", () => {
    const cs = bull();
    const early = run(cs.slice(0, 10)).imbalances;
    const withFill = cs.slice(0, 10).concat([c(11.4, 11.5, 10.4, 11.0, 10)]);
    const later = imbalanceStateAt(withFill, "T", "5m", CFG, "v1", 9);
    expect(JSON.stringify(early)).toBe(JSON.stringify(later));
  });

  it("deterministic — identical inputs give identical output and ids", () => {
    const a = run(bull());
    const b = run(bull());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.imbalances[0].id).toBe(fvgId("T", "5m", "bullish", E + 5 * M5));
  });

  it("duplicate prevention — one FVG identity, one creation event", () => {
    const { imbalances, events } = run(bull());
    expect(imbalances).toHaveLength(1);
    expect(events.filter((e) => e.kind === "fvg_created")).toHaveLength(1);
  });

  it("nested/overlapping FVGs keep independent identities and lifecycles", () => {
    const cs = [
      ...bull().slice(0, 8), // FVG1 [10.5, 10.9] created at bar 7
      c(11.4, 11.5, 11.0, 11.3, 8),
      c(10.65, 10.7, 10.55, 10.66, 9),  // A2: dips FVG1 to 87.5% (partial), high 10.7
      c(10.66, 11.2, 10.6, 11.1, 10),   // B2: bullish body 0.44
      c(11.1, 11.5, 10.85, 11.3, 11),   // C2: low 10.85 > high[A2] 10.7 → nested gap
      ...flat(8, 12, 11.3),
    ];
    const { imbalances } = run(cs);
    expect(imbalances).toHaveLength(2);
    const f1 = imbalances.find((x) => x.createdAt === new Date(cs[7].time).toISOString())!;
    const f2 = imbalances.find((x) => x.createdAt === new Date(cs[11].time).toISOString())!;
    expect(f2).toBeDefined();
    expect(f2.lowerPrice).toBeCloseTo(10.7); // nested inside FVG1 [10.5, 10.9]
    expect(f2.upperPrice).toBeCloseTo(10.85);
    // independent lifecycles: FVG1 partially filled, FVG2 untouched
    expect(f1.status).toBe("partially_filled");
    expect(f1.fillPct).toBeCloseTo(87.5, 1);
    expect(f2.status).toBe("open");
    expect(new Set(imbalances.map((x) => x.id)).size).toBe(2);
  });
});

describe("multi-asset + contract", () => {
  it("BTC scale — ATR-relative thresholds scale with price", () => {
    const scaled = bull().map((k) => ({ ...k, open: k.open * 6000, high: k.high * 6000, low: k.low * 6000, close: k.close * 6000 }));
    const { imbalances } = run(scaled);
    expect(imbalances).toHaveLength(1);
    expect(imbalances[0].upperPrice).toBeCloseTo(10.9 * 6000);
  });

  it("forex scale — small prices still detect", () => {
    const scaled = bull().map((k) => ({ ...k, open: k.open * 0.1, high: k.high * 0.1, low: k.low * 0.1, close: k.close * 0.1 }));
    expect(run(scaled).imbalances).toHaveLength(1);
  });

  it("insufficient candles → ok, empty", () => {
    expect(run([]).imbalances).toHaveLength(0);
    expect(run(flat(2, 0)).imbalances).toHaveLength(0);
  });

  it("flat candles — no gap ever forms", () => {
    const cs = Array.from({ length: 20 }, (_, k) => c(10, 10, 10, 10, k));
    expect(run(cs).imbalances).toHaveLength(0);
  });

  it("spansSession metadata — gap across a session boundary", () => {
    const cs = bull();
    cs[5].sessionId = "asia";
    cs[6].sessionId = "london";
    cs[7].sessionId = "london";
    const f = run(cs).imbalances[0];
    expect(f.metadata?.spansSession).toBe(true);
  });

  it("engine contract — ok, data, meta.events, diagnostics", () => {
    const res = createImbalanceEngine().analyze({
      series: { symbol: "T", timeframe: "5m", candles: bull() },
      config: CFG,
    });
    expect(res.ok).toBe(true);
    expect(res.data).toHaveLength(1);
    expect(res.meta.stage).toBe("imbalances");
    expect(res.meta.events.some((e) => e.kind === "fvg_created")).toBe(true);
    expect(typeof res.meta.diagnostics?.imbalances).toBe("number");
  });

  it("invalid config — out-of-range values rejected", () => {
    const series = { symbol: "T", timeframe: "5m" as const, candles: bull() };
    const engine = createImbalanceEngine();
    expect(engine.analyze({ series, config: { ...CFG, atrLength: 0 } }).ok).toBe(false);
    expect(engine.analyze({ series, config: { ...CFG, partialFillPct: 0 } }).ok).toBe(false);
    expect(engine.analyze({ series, config: { ...CFG, partialFillPct: 101 } }).ok).toBe(false);
    expect(engine.analyze({ series, config: { ...CFG, minGapAtr: -1 } }).ok).toBe(false);
    expect(engine.analyze({ series, config: { ...CFG, expiryBars: 0 } }).ok).toBe(false);
  });
});
