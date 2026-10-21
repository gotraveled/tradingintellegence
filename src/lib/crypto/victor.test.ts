import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { markStrong, pinBar, swingZones, victorSignal } from "./victor";

function candle(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c, volume: 100 };
}

const BAR = 300_000; // 5m

/** Flat body — constant extremes never form pivots (ties fail the strict check). */
const flat = (t: number) => candle(t, 100, 100.4, 99.6, 100.1);

/**
 * LTF tape with a demand zone at 94–96.5 (pivot low @idx10) and a supply
 * zone at 109.5–112 (pivot high @idx15), then a bullish pin whose tail tags
 * demand at idx33 and a confirming green candle at idx34.
 */
function ltfTape(): Candle[] {
  const cs: Candle[] = [];
  for (let i = 0; i < 35; i += 1) cs.push(flat(i * BAR));
  cs[10] = candle(10 * BAR, 96.5, 97, 94, 96); // pivot low → demand 94–96.5
  cs[15] = candle(15 * BAR, 109.5, 112, 109, 110); // pivot high → supply 109.5–112
  cs[33] = candle(33 * BAR, 100.2, 100.6, 95.5, 100.3); // bullish pin, tail in zone
  cs[34] = candle(34 * BAR, 100.3, 101.5, 100, 101.2); // follow-up confirms
  return cs;
}

/** HTF tape with a demand zone 93–97.5 overlapping the LTF demand zone. */
function htfTape(shift = 0): Candle[] {
  const cs: Candle[] = [];
  for (let i = 0; i < 35; i += 1) cs.push(flat(i * 3_600_000));
  cs[10] = candle(10 * 3_600_000, 97 + shift, 98 + shift, 93 + shift, 97.5 + shift);
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
    const zones = swingZones(ltfTape());
    const demand = zones.find((z) => z.kind === "demand");
    const supply = zones.find((z) => z.kind === "supply");
    expect(demand).toMatchObject({ lower: 94, upper: 96.5 });
    expect(supply).toMatchObject({ lower: 109.5, upper: 112 });
  });
  it("drops zones price has closed through", () => {
    const cs = ltfTape();
    cs[20] = candle(20 * BAR, 96, 96.5, 92, 93); // close below 94 → demand dead
    expect(swingZones(cs).some((z) => z.kind === "demand" && z.lower === 94)).toBe(false);
  });
});

describe("markStrong", () => {
  it("flags zones that overlap a same-kind HTF zone", () => {
    const ltf = swingZones(ltfTape());
    markStrong(ltf, swingZones(htfTape()));
    expect(ltf.find((z) => z.kind === "demand")?.strong).toBe(true);
    expect(ltf.find((z) => z.kind === "supply")?.strong).toBe(false); // no HTF supply
  });
});

describe("victorSignal", () => {
  it("emits a long: pin at MTF-aligned demand, SL at pin low, TP at next supply", () => {
    const s = victorSignal(ltfTape(), htfTape());
    expect(s).toBeDefined();
    expect(s!.signal.direction).toBe("bullish");
    expect(s!.signal.entry).toBe(101.2); // follow-up close
    expect(s!.signal.stopLoss).toBe(95.5); // pin low — per spec
    expect(s!.signal.targets[0].price).toBe(109.5); // supply zone edge
    expect(s!.signal.confidence).toBeGreaterThanOrEqual(80);
    expect(s!.zone.kind).toBe("demand");
    expect(s!.zone.strong).toBe(true);
  });

  it("refuses when the zone lacks MTF alignment — weak levels don't trade", () => {
    expect(victorSignal(ltfTape(), htfTape(-20))).toBeUndefined(); // HTF zone at ~73–77
  });

  it("refuses without higher-timeframe data at all", () => {
    expect(victorSignal(ltfTape(), undefined)).toBeUndefined();
  });

  it("refuses when the follow-up candle doesn't confirm", () => {
    const cs = ltfTape();
    cs[34] = candle(34 * BAR, 100.4, 100.5, 99.8, 100.0); // red, closes below pin close
    expect(victorSignal(cs, htfTape())).toBeUndefined();
  });

  it("refuses when the pin's tail misses every zone", () => {
    const cs = ltfTape();
    cs[33] = candle(33 * BAR, 100.2, 100.6, 97.5, 100.3); // tail at 97.5 — above zone edge 96.5
    expect(victorSignal(cs, htfTape())).toBeUndefined();
  });
});
