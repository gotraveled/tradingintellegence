import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { markStrongAcross, pinBar, swingZones, victorSignal } from "./victor";

function candle(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c, volume: 100 };
}

const BAR = 300_000; // 5m

/** Flat body — constant extremes never form pivots (ties fail the strict check). */
const flat = (t: number) => candle(t, 100, 100.4, 99.6, 100.1);

/**
 * Entry-tf tape (1m semantics): morning star at 30–32, then a bullish pin
 * whose tail dips to 95.5 at idx33, confirmed by a green close at idx34.
 */
function entryTape(): Candle[] {
  const cs: Candle[] = [];
  for (let i = 0; i < 35; i += 1) cs.push(flat(i * BAR));
  cs[30] = candle(30 * BAR, 100.6, 100.8, 99, 99.4); // strong red — star leg 1
  cs[31] = candle(31 * BAR, 99.4, 99.6, 99.1, 99.5); // small star body
  cs[32] = candle(32 * BAR, 99.5, 101, 99.4, 100.4); // green, closes over leg-1 mid
  cs[33] = candle(33 * BAR, 100.2, 100.6, 95.5, 100.3); // bullish pin
  cs[34] = candle(34 * BAR, 100.3, 101.5, 100, 101.2); // follow-up confirms
  return cs;
}

/**
 * Context tape A: drop-base-rally leaves demand 94–96.5, rally-base-drop
 * leaves supply 110.5–113 — legs are ~6–12pt bodies on a 0.8pt flat tape.
 */
function ctxA(): Candle[] {
  const cs: Candle[] = [];
  for (let i = 0; i < 35; i += 1) cs.push(flat(i * BAR));
  // Drop-base-rally → demand zone = the base's 94–96.5 range
  cs[7] = candle(7 * BAR, 100.5, 101, 95, 95.5); // bearish leg-in
  cs[8] = candle(8 * BAR, 95.5, 96.5, 94, 96); // base candle → zone 94–96.5
  cs[9] = candle(9 * BAR, 96, 102, 95.5, 101.5); // bullish leg-out
  // Rally-base-drop → supply zone = the base's 110.5–113 range
  cs[14] = candle(14 * BAR, 100, 112.5, 99.5, 112); // bullish leg-in
  cs[15] = candle(15 * BAR, 111.5, 113, 110.5, 111); // base candle → zone 110.5–113
  cs[16] = candle(16 * BAR, 111, 111.5, 99, 99.5); // bearish leg-out
  return cs;
}

/** Context tape B: drop-base-rally → demand 93–96 overlapping A's demand. */
function ctxB(shift = 0): Candle[] {
  const cs: Candle[] = [];
  for (let i = 0; i < 35; i += 1) cs.push(flat(i * 3_600_000));
  cs[7] = candle(7 * 3_600_000, 100.5, 101, 95, 95.5); // bearish leg-in
  cs[8] = candle(8 * 3_600_000, 95.5 + shift, 96 + shift, 93 + shift, 96 + shift); // base → 93–96
  cs[9] = candle(9 * 3_600_000, 96, 102, 95.5, 101.5); // bullish leg-out
  return cs;
}

describe("pinBar", () => {
  it("reads bullish and bearish rejection wicks", () => {
    expect(pinBar(candle(0, 100, 101, 95, 100.5))).toBe("bullish"); // 5× body tail down
    expect(pinBar(candle(0, 100, 105, 99.5, 99.7))).toBe("bearish"); // tail up
  });
  it("rejects balanced and wickless candles", () => {
    expect(pinBar(candle(0, 100, 102, 98, 100))).toBeUndefined(); // doji-ish, both wicks
    expect(pinBar(candle(0, 100, 103, 99.9, 102.9))).toBeUndefined(); // marubozu-ish
  });
});

describe("swingZones", () => {
  it("marks unbroken pivot extremes as supply/demand zones", () => {
    const zones = swingZones(ctxA());
    const demand = zones.find((z) => z.kind === "demand");
    const supply = zones.find((z) => z.kind === "supply");
    expect(demand).toMatchObject({ lower: 94, upper: 96.5 });
    expect(supply).toMatchObject({ lower: 110.5, upper: 113 });
  });
  it("drops zones price has closed through", () => {
    const cs = ctxA();
    cs[20] = candle(20 * BAR, 96, 96.5, 92, 93); // close below 94 → demand dead
    expect(swingZones(cs).some((z) => z.kind === "demand" && z.lower === 94)).toBe(false);
  });
});

describe("markStrongAcross", () => {
  it("flags zones confirmed by a same-kind zone on another timeframe", () => {
    const zones = markStrongAcross([swingZones(ctxA()), swingZones(ctxB())]);
    expect(zones.find((z) => z.kind === "demand" && z.lower === 94)?.strong).toBe(true);
    expect(zones.find((z) => z.kind === "supply")?.strong).toBe(false); // no B supply
  });
});

describe("victorSignal", () => {
  it("emits a long: 1m pin at cross-TF demand, SL at pin low, TP at next supply", () => {
    const s = victorSignal(entryTape(), [ctxA(), ctxB()]);
    expect(s).toBeDefined();
    expect(s!.signal.direction).toBe("bullish");
    expect(s!.signal.entry).toBe(101.2); // follow-up close
    expect(s!.signal.stopLoss).toBe(95.5); // pin low — per spec
    expect(s!.signal.targets[0].price).toBe(110.5); // supply zone edge
    expect(s!.signal.confidence).toBeGreaterThanOrEqual(80);
    expect(s!.zone.kind).toBe("demand");
    expect(s!.zone.strong).toBe(true);
  });

  it("refuses a single-context zone — only MTF-confirmed strong zones trade", () => {
    const s = victorSignal(entryTape(), [ctxA(), ctxB(-20)]); // B zone shifted away
    expect(s).toBeUndefined(); // no cross-TF overlap → not a strong zone → no trade
  });

  it("refuses with a single context timeframe — MTF proof needs two", () => {
    expect(victorSignal(entryTape(), [ctxA()])).toBeUndefined();
  });

  it("refuses when the follow-up candle doesn't confirm", () => {
    const cs = entryTape();
    cs[34] = candle(34 * BAR, 100.4, 100.5, 99.8, 100.0); // red, closes below pin close
    expect(victorSignal(cs, [ctxA(), ctxB()])).toBeUndefined();
  });

  it("refuses when the pin's tail misses every zone", () => {
    const cs = entryTape();
    cs[33] = candle(33 * BAR, 100.2, 100.6, 97.5, 100.3); // tail at 97.5 — above zone edge 96.5
    expect(victorSignal(cs, [ctxA(), ctxB()])).toBeUndefined();
  });

  it("emits without an independent pattern — pin+follow+zone is the core triple", () => {
    const cs = entryTape();
    // Erase the morning star — flat bars carry no pattern evidence.
    cs[30] = flat(30 * BAR);
    cs[31] = flat(31 * BAR);
    cs[32] = flat(32 * BAR);
    const s = victorSignal(cs, [ctxA(), ctxB()]);
    expect(s).toBeDefined();
    expect(s!.signal.factors.find((f) => f.label === "Pattern")?.agrees).toBe(false);
    // …but the pattern bonus is missing, so the score is lower.
    expect(s!.signal.confidence).toBeLessThan(
      victorSignal(entryTape(), [ctxA(), ctxB()])!.signal.confidence,
    );
  });
});
