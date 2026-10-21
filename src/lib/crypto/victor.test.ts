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
 * Entry-tf tape (1m semantics): a bullish pin whose tail dips to 95.5 at
 * idx33, confirmed by a green close at idx34.
 */
function entryTape(): Candle[] {
  const cs: Candle[] = [];
  for (let i = 0; i < 35; i += 1) cs.push(flat(i * BAR));
  cs[33] = candle(33 * BAR, 100.2, 100.6, 95.5, 100.3); // bullish pin
  cs[34] = candle(34 * BAR, 100.3, 101.5, 100, 101.2); // follow-up confirms
  return cs;
}

/** Context tape A: demand zone 94–96.5 (@10) + supply zone 109.5–112 (@15). */
function ctxA(): Candle[] {
  const cs: Candle[] = [];
  for (let i = 0; i < 35; i += 1) cs.push(flat(i * BAR));
  cs[10] = candle(10 * BAR, 96.5, 97, 94, 96); // pivot low → demand 94–96.5
  cs[15] = candle(15 * BAR, 109.5, 112, 109, 110); // pivot high → supply 109.5–112
  return cs;
}

/** Context tape B: demand zone 93–96 overlapping A's demand. */
function ctxB(shift = 0): Candle[] {
  const cs: Candle[] = [];
  for (let i = 0; i < 35; i += 1) cs.push(flat(i * 3_600_000));
  cs[10] = candle(10 * 3_600_000, 95.5 + shift, 96 + shift, 93 + shift, 96 + shift);
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
    expect(supply).toMatchObject({ lower: 109.5, upper: 112 });
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
    expect(s!.signal.targets[0].price).toBe(109.5); // supply zone edge
    expect(s!.signal.confidence).toBeGreaterThanOrEqual(80);
    expect(s!.zone.kind).toBe("demand");
    expect(s!.zone.strong).toBe(true);
  });

  it("refuses when context zones don't overlap — weak levels don't trade", () => {
    expect(victorSignal(entryTape(), [ctxA(), ctxB(-20)])).toBeUndefined();
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
});
