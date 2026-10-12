import { describe, expect, it } from "vitest";
import type {
  Candle,
  LiquidityPool,
  MarketStructure,
  StructureBreak,
  SwingPoint,
  Zone,
  ZoneConfig,
} from "@/lib/types";
import { analyzeZones, createZoneEngine, zoneId, zoneStateAt } from "../zones";
import { swingId } from "../swing";
import { FIXTURE_EPOCH as E } from "@/lib/market-data";

const M5 = 300_000;

const CFG: ZoneConfig = {
  leg: { lookbackBars: 5, minMoveAtr: 1.0 },
  base: { minBars: 2, maxBars: 10, maxRangeAtr: 1.0, maxBodyAtr: 0.5 },
  departure: { minMoveAtr: 1.5, maxBars: 5, displacementBodyAtr: 0.6, displacementRangeAtr: 1.2 },
  retest: { depthMitigatedPct: 80, invalidateCloseAtr: 0.1, maxRetests: 3, retestDecay: 0.15, depthDecay: 0.7 },
  freshnessMaxBars: 500,
  boundaryMode: "extremes",
  gapInvalidates: false,
  weights: {
    departureStrength: 0.25,
    structureBreak: 0.15,
    liquidityInteraction: 0.15,
    freshness: 0.15,
    fvgAssociation: 0.10,
    htfConfluence: 0.10,
    volumeExpansion: 0.05,
    zoneWidth: 0.05,
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

const set = (cs: Candle[], i: number, p: Partial<Candle>) => Object.assign(cs[i], p);

/**
 * Canonical DBR fixture (leg-ATR = 1.5):
 * bars 0–4 decline TR 1.5 (legMove −3.7 ≈ −2.5×ATR), bars 5–8 compressed base
 * (span 0.7, bodies ≤0.3), bar 10 is the displacement + confirm close (10.8 ≥ 8.2+2.25),
 * tail flat at 10.8 — well above the zone, never retests.
 * Overlapping qualifying bases at i=5,6,7 all confirm at d=10 → 3 demand zones.
 */
const dbr = (): Candle[] => [
  c(12, 12.5, 11.5, 11.5, 0),
  c(11.5, 12, 10.5, 10.5, 1),
  c(10.5, 11, 9.5, 9.5, 2),
  c(9.5, 10, 8.5, 8.5, 3),
  c(8.5, 9, 7.5, 7.8, 4),
  c(7.8, 8.1, 7.6, 7.9, 5),
  c(7.9, 8.2, 7.7, 8.0, 6),
  c(8.0, 8.2, 7.6, 7.7, 7),
  c(7.7, 8.1, 7.5, 7.9, 8),
  c(7.9, 9.2, 7.7, 9.0, 9),
  c(9.0, 11.0, 8.9, 10.8, 10),
  ...Array.from({ length: 10 }, (_, k) => c(10.8, 11.3, 10.3, 10.8, 11 + k)),
];

/** Price-mirror — every price inverted around m (turns DBR into RBD). */
const invert = (cs: Candle[], m: number): Candle[] =>
  cs.map((k) => ({ ...k, open: m - k.open, high: m - k.low, low: m - k.high, close: m - k.close }));

const ms = (swings: SwingPoint[] = [], extra: Partial<MarketStructure> = {}): MarketStructure => ({
  symbol: "T",
  timeframe: "5m",
  trend: "transition",
  bias: "neutral",
  swings,
  updatedAt: new Date(E).toISOString(),
  ...extra,
});

const sw = (kind: "high" | "low", price: number, pivot: number, confirmed: number, atr = 1): SwingPoint => ({
  id: swingId("T", "5m", kind, E + pivot * M5),
  symbol: "T",
  timeframe: "5m",
  kind,
  price,
  pivotIndex: pivot,
  pivotAt: new Date(E + pivot * M5).toISOString(),
  confirmedIndex: confirmed,
  confirmedAt: new Date(E + confirmed * M5).toISOString(),
  status: "confirmed",
  metadata: { atrAtPivot: atr, paramsVersion: "v1" },
});

const brk = (dir: "bullish" | "bearish", atBar: number): StructureBreak => ({
  id: `brk:${dir}:${atBar}`,
  type: "BOS",
  direction: dir,
  price: 9,
  time: new Date(E + atBar * M5).toISOString(),
  confirmed: true,
  breakIndex: atBar,
});

const pool = (over: Partial<LiquidityPool>): LiquidityPool => ({
  id: "p1",
  symbol: "T",
  timeframe: "5m",
  side: "sell_side",
  sources: ["swing_low"],
  price: 10,
  touches: 1,
  strength: 50,
  status: "resting",
  formedAt: new Date(E).toISOString(),
  lastTouchedAt: new Date(E).toISOString(),
  ...over,
});

const run = (candles: Candle[], structure = ms(), pools: LiquidityPool[] = [], cfg: ZoneConfig = CFG) =>
  analyzeZones(candles, structure, pools, "T", "5m", cfg, "v1");

/** The primary zone — the maximal base starting at bar 5. */
const primary = (zones: Zone[]) => zones.find((z) => z.metadata?.baseStart === 5);

describe("zone formation", () => {
  it("DBR — compressed base + displacement rally creates a demand zone at the confirm bar", () => {
    const candles = dbr();
    const { zones, events } = run(candles);
    const z = primary(zones)!;
    expect(z.type).toBe("demand");
    expect(z.pattern).toBe("DBR");
    expect(z.upperPrice).toBeCloseTo(8.2); // proximal (extremes)
    expect(z.lowerPrice).toBeCloseTo(7.5); // distal
    expect(z.originAt).toBe(new Date(candles[5].time).toISOString());
    expect(z.createdAt).toBe(new Date(candles[10].time).toISOString());
    expect(z.status).toBe("active");
    expect(z.freshness).toBe("fresh");
    expect(z.retestCount).toBe(0);
    expect(z.strength).toBeGreaterThan(0);
    expect(z.strength).toBeLessThanOrEqual(100);
    const ev = events.find((e) => e.kind === "zone_created" && e.refId === z.id);
    expect(ev?.atBar).toBe(10);
    expect(ev?.at).toBe(z.createdAt);
  });

  it("RBD — mirrored fixture creates a supply zone", () => {
    const candles = invert(dbr(), 20);
    const { zones } = run(candles);
    const supply = zones.filter((z) => z.type === "supply");
    expect(supply.length).toBeGreaterThan(0);
    const z = supply.find((x) => x.metadata?.baseStart === 5)!;
    expect(z.pattern).toBe("RBD");
    expect(z.upperPrice).toBeCloseTo(12.5); // distal for supply (extremes)
    expect(z.lowerPrice).toBeCloseTo(11.8); // proximal
  });

  it("RBR — rally leg + stronger rally departure creates a continuation demand zone", () => {
    const cs = [
      // rally leg-in (TR 1.5, move +4)
      c(6, 6.5, 5.5, 6.5, 0),
      c(6.5, 7.5, 6, 7.5, 1),
      c(7.5, 8.5, 7, 8.5, 2),
      c(8.5, 9.5, 8, 9.5, 3),
      c(9.5, 10.5, 9, 10, 4),
      // base (compressed)
      c(10, 10.3, 9.8, 10.1, 5),
      c(10.1, 10.4, 9.9, 10.0, 6),
      c(10.0, 10.3, 9.8, 10.1, 7),
      // departure stronger than the leg (depMove > 4 → close > baseTop+4 = 14.4)
      c(10.1, 12, 10, 11.5, 8),
      c(11.5, 15.2, 11.4, 14.8, 9), // displacement + confirm (14.8 ≥ 10.4+2.25=12.65)
      ...Array.from({ length: 8 }, (_, k) => c(14.8, 15.3, 14.3, 14.8, 10 + k)),
    ];
    const { zones } = run(cs);
    const z = primary(zones)!;
    expect(z.type).toBe("demand");
    expect(z.pattern).toBe("RBR");
    expect(z.createdAt).toBe(new Date(cs[9].time).toISOString());
  });

  it("RBR rejected when the departure is weaker than the leg in", () => {
    const cs = [
      c(6, 6.5, 5.5, 6.5, 0),
      c(6.5, 7.5, 6, 7.5, 1),
      c(7.5, 8.5, 7, 8.5, 2),
      c(8.5, 9.5, 8, 9.5, 3),
      c(9.5, 10.5, 9, 10, 4),
      c(10, 10.3, 9.8, 10.1, 5),
      c(10.1, 10.4, 9.9, 10.0, 6),
      c(10.0, 10.3, 9.8, 10.1, 7),
      // departure crosses minMoveAtr (10.4+2.25=12.65) but depMove (13.0−10.4=2.6) ≤ legMove (4)
      c(10.1, 13.5, 10, 13.0, 8),
      ...Array.from({ length: 9 }, (_, k) => c(13, 13.5, 12.5, 13, 9 + k)),
    ];
    const { zones } = run(cs);
    expect(zones.filter((z) => z.metadata?.baseStart === 5)).toHaveLength(0);
  });

  it("overlapping bases produce distinct zone identities — none merged, none deleted", () => {
    const { zones } = run(dbr());
    expect(zones.length).toBe(3); // bases at i = 5, 6, 7 all qualify and confirm at bar 10
    expect(new Set(zones.map((z) => z.id)).size).toBe(zones.length);
    expect(zones.every((z) => z.status === "active")).toBe(true);
  });

  it("insufficient formation data → empty result, still ok", () => {
    const res = run([]);
    expect(res.zones).toHaveLength(0);
    const res2 = run(dbr().slice(0, 3));
    expect(res2.zones).toHaveLength(0);
  });

  it("base failing maxRangeAtr produces no zone at that origin", () => {
    const cs = dbr();
    set(cs, 6, { high: 10.5, low: 6.5 }); // range 4.0 ≥ 1.8 → wide bar, not basing
    const { zones } = run(cs);
    expect(zones.every((z) => z.metadata?.baseStart !== 5 && z.metadata?.baseStart !== 6)).toBe(true);
  });

  it("base failing maxBodyAtr produces no zone", () => {
    const cs = dbr();
    for (const i of [5, 6, 7, 8]) set(cs, i, { open: 7.4, high: 8.4, low: 7.4, close: 8.2 }); // body 0.8 mean > 0.75
    const { zones } = run(cs);
    expect(zones).toHaveLength(0);
  });

  it("departure that times out produces no zone", () => {
    const cs = dbr();
    set(cs, 9, { open: 7.9, high: 8.5, low: 7.7, close: 8.2 });
    set(cs, 10, { open: 8.2, high: 8.6, low: 8.0, close: 8.4 });
    // bars 11-13 already inside the departure window (j+5=13): keep them below 10.45
    for (const i of [11, 12, 13]) set(cs, i, { open: 8.4, high: 9.0, low: 8.0, close: 8.5 });
    const { zones } = run(cs);
    expect(zones).toHaveLength(0);
  });

  it("a base whose departure window is truncated by the horizon is 'forming' (diagnostic)", () => {
    const { zones, diagnostics } = run(dbr().slice(0, 9)); // end = bar 8, no departure visible
    expect(zones).toHaveLength(0);
    expect(diagnostics.forming).toBeGreaterThan(0);
  });
});

describe("zone boundaries", () => {
  it("extremes mode — upper/lower from base highs/lows", () => {
    const z = primary(run(dbr()).zones)!;
    expect(z.upperPrice).toBeCloseTo(8.2);
    expect(z.lowerPrice).toBeCloseTo(7.5);
  });

  it("bodies mode — upper/lower from open/close extremes", () => {
    const z = primary(run(dbr(), ms(), [], { ...CFG, boundaryMode: "bodies" }).zones)!;
    expect(z.upperPrice).toBeCloseTo(8.0);
    expect(z.lowerPrice).toBeCloseTo(7.7);
  });

  it("width never blocks creation — only feeds the strength width feature", () => {
    const { zones } = run(dbr());
    expect(zones.length).toBeGreaterThan(0);
    expect(zones.every((z) => z.upperPrice - z.lowerPrice > 0)).toBe(true);
  });
});

describe("zone lifecycle (07)", () => {
  it("first shallow retest — tested on exit, one count per contiguous block", () => {
    const cs = dbr();
    set(cs, 11, { open: 10.8, high: 11, low: 8.0, close: 8.4 }); // inside (low ≤ 8.2)
    set(cs, 12, { open: 8.4, high: 9.0, low: 8.4, close: 9.0 }); // exit (low > 8.2)
    const { zones, events } = run(cs);
    const z = primary(zones)!;
    expect(z.retestCount).toBe(1);
    expect(z.freshness).toBe("tested");
    expect(z.status).toBe("active");
    expect(z.lastRetestAt).toBe(new Date(cs[12].time).toISOString());
    expect(z.penetrationDepthPct).toBeCloseTo(28.57, 1); // (8.2−8.0)/0.7
    expect(events.filter((e) => e.kind === "zone_retested")).toHaveLength(3); // one per zone
  });

  it("multi-bar in-zone stretch counts as a single retest", () => {
    const cs = dbr();
    for (const i of [11, 12, 13]) set(cs, i, { open: 8.4, high: 8.6, low: 8.0, close: 8.3 });
    set(cs, 14, { open: 8.5, high: 9.2, low: 8.4, close: 9.0 }); // exit
    const z = primary(run(cs).zones)!;
    expect(z.retestCount).toBe(1);
    expect(z.freshness).toBe("tested");
  });

  it("deep retest ≥ depthMitigatedPct → consumed (mitigated)", () => {
    const cs = dbr();
    set(cs, 11, { open: 10.8, high: 11, low: 7.6, close: 8.0 }); // pen (8.2−7.6)/0.7 ≈ 85.7%
    const { zones, events } = run(cs);
    const z = primary(zones)!;
    expect(z.status).toBe("mitigated");
    expect(z.freshness).toBe("mitigated");
    expect(events.some((e) => e.kind === "zone_consumed")).toBe(true);
  });

  it("close inside below the midline → consumed", () => {
    const cs = dbr();
    set(cs, 11, { open: 10.8, high: 11, low: 7.8, close: 7.8 }); // mid = 7.85, close 7.8 inside [7.5,7.85]
    const z = primary(run(cs).zones)!;
    expect(z.status).toBe("mitigated");
  });

  it("close beyond distal edge → invalidated (wins over consumption same bar)", () => {
    const cs = dbr();
    set(cs, 11, { open: 10.8, high: 11, low: 7.0, close: 7.2 }); // close < 7.5 − 0.15
    const { zones, events } = run(cs);
    const z = primary(zones)!;
    expect(z.status).toBe("invalidated");
    expect(z.metadata?.via).toBe("close");
    expect(events.some((e) => e.kind === "zone_invalidated")).toBe(true);
  });

  it("maxRetests completed retests → consumed by count", () => {
    const cs = dbr();
    // three shallow in/out cycles
    set(cs, 11, { low: 8.0, close: 8.4 });
    set(cs, 12, { low: 8.4, close: 9.0 });
    set(cs, 13, { low: 8.0, close: 8.4 });
    set(cs, 14, { low: 8.4, close: 9.0 });
    set(cs, 15, { low: 8.0, close: 8.4 });
    set(cs, 16, { low: 8.4, close: 9.0 });
    const z = primary(run(cs).zones)!;
    expect(z.retestCount).toBe(3);
    expect(z.status).toBe("mitigated");
    expect(z.metadata?.via).toBe("retest_count");
  });

  it("zone expires after freshnessMaxBars with zero re-entry", () => {
    const { zones } = run(dbr(), ms(), [], { ...CFG, freshnessMaxBars: 4 });
    const z = primary(zones)!;
    expect(z.status).toBe("expired"); // t − createdBar > 4 → bar 15
    expect(z.metadata?.expiredAt).toBeDefined();
  });

  it("gapInvalidates — an open beyond the distal edge invalidates without a close", () => {
    const cs = dbr();
    set(cs, 11, { open: 7.0, high: 7.4, low: 6.8, close: 7.2 }); // open 7.0 < 7.5
    const { zones, events } = run(cs, ms(), [], { ...CFG, gapInvalidates: true });
    expect(primary(zones)!.status).toBe("invalidated");
    expect(events.find((e) => e.kind === "zone_invalidated")?.metadata?.via).toBe("gap");
  });

  it("a bar inside the zone BEFORE confirmation never counts as a retest", () => {
    // bar 9 (departure) wicks to 7.7 ≤ 8.2 — inside the zone but before createdBar.
    const z = primary(run(dbr()).zones)!;
    expect(z.retestCount).toBe(0);
    expect(z.penetrationDepthPct).toBe(0);
  });

  it("penetrationDepthPct is monotonic; remainingStrength ≤ strength", () => {
    const cs = dbr();
    set(cs, 11, { low: 8.0, close: 8.4 });
    set(cs, 12, { low: 8.4, close: 9.0 });
    set(cs, 13, { low: 7.9, close: 8.4 });
    set(cs, 14, { low: 8.4, close: 9.0 });
    const z = primary(run(cs).zones)!;
    expect(z.penetrationDepthPct).toBeCloseTo(42.86, 1); // deepest of the two taps
    expect(z.remainingStrength).toBeLessThanOrEqual(z.strength);
    expect(z.remainingStrength).toBeGreaterThan(0);
  });
});

describe("structure + liquidity + FVG context", () => {
  it("strong — a matching-direction break inside the departure window", () => {
    const { zones } = run(dbr(), ms([], { breaks: [brk("bullish", 10)] }));
    expect(primary(zones)!.structureImpact).toBe("strong");
  });

  it("minor — departure crosses a confirmed unprotected swing with no break event", () => {
    const { zones } = run(dbr(), ms([sw("high", 9.5, 3, 9)]));
    expect(primary(zones)!.structureImpact).toBe("minor");
  });

  it("none — no break and no crossed swing", () => {
    expect(primary(run(dbr()).zones)!.structureImpact).toBe("none");
  });

  it("formed_on_sweep — base at/just after a confirmed opposite-side sweep", () => {
    const pools = [pool({ side: "sell_side", metadata: { sweepConfirmedBar: 4 } })];
    expect(primary(run(dbr(), ms(), pools).zones)!.liquidityContext).toBe("formed_on_sweep");
  });

  it("departure_through_pool — rally clears a still-resting opposing pool", () => {
    const pools = [pool({ side: "buy_side", price: 9.5, formedAt: new Date(E + 8 * M5).toISOString() })];
    expect(primary(run(dbr(), ms(), pools).zones)!.liquidityContext).toBe("departure_through_pool");
  });

  it("a pool broken before the departure bar does not count as resting", () => {
    const pools = [
      pool({
        side: "buy_side",
        price: 9.5,
        formedAt: new Date(E + 8 * M5).toISOString(),
        status: "broken",
        metadata: { brokenAt: new Date(E + 9 * M5).toISOString(), brokenBar: 9 },
      }),
    ];
    expect(primary(run(dbr(), ms(), pools).zones)!.liquidityContext).toBe("none");
  });

  it("fvgId links a 3-bar gap on the departure leg", () => {
    const cs = dbr();
    set(cs, 9, { open: 7.9, high: 9.4, low: 7.8, close: 8.6 }); // outside base span — can't join the base
    set(cs, 10, { open: 8.6, high: 10.3, low: 8.5, close: 10.0 }); // displacement, no confirm
    set(cs, 11, { open: 10.0, high: 11.2, low: 9.5, close: 10.8 }); // low 9.5 > high[9] 9.4 → FVG; confirms d=11
    const z = primary(run(cs).zones)!;
    expect(z.fvgId).toBe(`fvg:T:5m:bullish:${cs[9].time}`);
  });

  it("strength uses volume when present; redistributes when absent", () => {
    const withVol = dbr().map((k, idx) => ({ ...k, volume: idx >= 5 && idx <= 8 ? 100 : 300 }));
    const zv = primary(run(withVol).zones)!;
    const zn = primary(run(dbr()).zones)!;
    expect(zv.strength).toBeGreaterThanOrEqual(0);
    expect(zn.strength).toBeGreaterThanOrEqual(0);
    expect(zv.strength).not.toBe(zn.strength); // volume feature actually applies
  });
});

describe("look-ahead, replay, determinism", () => {
  it("no zone before its confirmation bar", () => {
    const cs = dbr();
    expect(zoneStateAt(cs, ms(), [], "T", "5m", CFG, "v1", 9)).toHaveLength(0);
    expect(zoneStateAt(cs, ms(), [], "T", "5m", CFG, "v1", 10).length).toBeGreaterThan(0);
  });

  it("replay truncation — prefix run equals snapshot at the same index", () => {
    const cs = dbr();
    const full = zoneStateAt(cs, ms(), [], "T", "5m", CFG, "v1", 12);
    const prefix = run(cs.slice(0, 13)).zones;
    expect(JSON.stringify(full)).toBe(JSON.stringify(prefix));
  });

  it("future candles do not alter historical zone state", () => {
    const cs = dbr();
    const short = run(cs.slice(0, 15)).zones;
    // append a violent retest far in the future — earlier snapshot must be unchanged
    const long = cs.slice(0, 15).concat([
      c(10.8, 11, 7.0, 7.2, 15),
      c(7.2, 7.4, 6.5, 7.0, 16),
    ]);
    const longer = run(long, ms(), [], CFG).zones;
    const at14 = zoneStateAt(long, ms(), [], "T", "5m", CFG, "v1", 14);
    expect(JSON.stringify(short)).toBe(JSON.stringify(at14));
    // and the violent bar DID invalidate in the full run
    expect(longer.some((z) => z.status === "invalidated")).toBe(true);
  });

  it("deterministic — identical inputs give identical zones, events and ids", () => {
    const a = run(dbr());
    const b = run(dbr());
    expect(JSON.stringify(a.zones)).toBe(JSON.stringify(b.zones));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(zoneId("T", "5m", "demand", 1, 2)).toBe(zoneId("T", "5m", "demand", 1, 2));
  });

  it("duplicate prevention — one zone per identity, one created event per id", () => {
    const { zones, events } = run(dbr());
    const ids = zones.map((z) => z.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(events.filter((e) => e.kind === "zone_created" && e.refId === id)).toHaveLength(1);
    }
  });
});

describe("multi-asset + contract", () => {
  it("BTC scale — ATR-relative thresholds scale with price", () => {
    const scaled = dbr().map((k) => ({
      ...k,
      open: k.open * 6000,
      high: k.high * 6000,
      low: k.low * 6000,
      close: k.close * 6000,
    }));
    const { zones } = run(scaled);
    expect(primary(zones)?.type).toBe("demand");
    expect(zones.length).toBe(3);
  });

  it("engine contract — ok, data, meta.events, diagnostics", () => {
    const res = createZoneEngine().analyze({
      series: { symbol: "T", timeframe: "5m", candles: dbr() },
      structure: ms(),
      pools: [],
      config: CFG,
    });
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.meta.stage).toBe("zones");
    expect(res.meta.events.some((e) => e.kind === "zone_created")).toBe(true);
    expect(typeof res.meta.diagnostics?.zones).toBe("number");
  });

  it("invalid config — weights not summing to 1", () => {
    const res = createZoneEngine().analyze({
      series: { symbol: "T", timeframe: "5m", candles: dbr() },
      structure: ms(),
      pools: [],
      config: { ...CFG, weights: { ...CFG.weights, zoneWidth: 0.9 } },
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0].code).toBe("invalid_config");
  });

  it("invalid config — base.minBars > base.maxBars", () => {
    const res = createZoneEngine().analyze({
      series: { symbol: "T", timeframe: "5m", candles: dbr() },
      structure: ms(),
      pools: [],
      config: { ...CFG, base: { ...CFG.base, minBars: 12 } },
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0].code).toBe("invalid_config");
  });
});
