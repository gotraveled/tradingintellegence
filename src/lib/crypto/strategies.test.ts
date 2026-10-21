import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/types";
import { STRATEGIES } from "./strategies";

const M5 = 300_000;

let T0 = 0;
const c = (i: number, o: number, h: number, l: number, cl: number, v = 100): Candle => ({
  time: T0 + i * M5,
  open: o,
  high: h,
  low: l,
  close: cl,
  volume: v,
});

const flat = (i: number, mid = 100): Candle => c(i, mid, mid + 0.4, mid - 0.4, mid);

const strat = (id: string) => STRATEGIES.find((s) => s.id === id)!;

describe("strategy registry", () => {
  it("has unique ids and emits factory functions", () => {
    const ids = STRATEGIES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of STRATEGIES) {
      expect(typeof s.create()).toBe("function");
      expect(s.blurb.length).toBeGreaterThan(10);
    }
  });

  it("every strategy stays quiet on insufficient history", () => {
    T0 = 1_700_000_000_000;
    const tiny = Array.from({ length: 20 }, (_, i) => flat(i));
    for (const s of STRATEGIES) {
      expect(s.create()(tiny)).toBeUndefined();
    }
  });
});

describe("opening range breakout", () => {
  function orbTape(): Candle[] {
    // 26 quiet bars on the prior UTC day, then the first-15-min range
    // (hi 101.2 / lo 100 = 1.2% width), then a strong-volume break.
    const DAY = 86_400_000;
    const day0 = Math.floor(1_750_000_000_000 / DAY) * DAY;
    T0 = day0 - 26 * M5;
    const out: Candle[] = Array.from({ length: 26 }, (_, i) => flat(i, 98));
    out.push(
      c(26, 100, 101.2, 100, 100.8),
      c(27, 100.8, 101.2, 100.2, 100.6),
      c(28, 100.6, 101.2, 100.3, 100.7),
      c(29, 100.7, 102.1, 100.7, 101.9, 1000), // breakout close with volume
    );
    return out;
  }

  it("fires long on a volume-backed break above the range", () => {
    const sig = strat("orb").create()(orbTape());
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe("bullish");
    expect(sig!.stopLoss!).toBeGreaterThan(100); // tucked inside the range
    expect(sig!.stopLoss!).toBeLessThan(sig!.entry!);
    expect(sig!.riskReward!).toBeGreaterThanOrEqual(1);
  });

  it("refuses a second entry the same day", () => {
    const f = strat("orb").create();
    const tape = orbTape();
    expect(f(tape)).toBeDefined();
    const later = [...tape, c(30, 101.9, 103, 101.5, 102.5, 900)];
    expect(f(later)).toBeUndefined();
  });

  it("skips a too-wide opening range", () => {
    const tape = orbTape();
    // Rebuild the range 6% wide — the move already happened.
    tape[26] = c(26, 100, 105, 99, 104);
    tape[27] = c(27, 104, 105, 102, 104.5);
    tape[28] = c(28, 104.5, 105, 103, 104.8);
    tape[29] = c(29, 104.8, 106, 104.5, 105.5, 1000);
    expect(strat("orb").create()(tape)).toBeUndefined();
  });
});

describe("liquidity sweep reversal", () => {
  it("goes long after a wick runs the prior low and reclaims it", () => {
    T0 = 1_700_000_000_000;
    const out: Candle[] = Array.from({ length: 57 }, (_, i) =>
      c(i, 100, 101, 99, 100 + ((i % 3) - 1) * 0.3),
    );
    out[30] = c(30, 100, 101, 95, 99); // prior extreme low at 95
    out.push(
      c(57, 99, 100, 98, 99.5),
      c(58, 99.5, 99.8, 94, 97.5), // sweep: low under 95
      c(59, 97.5, 99.9, 97.2, 99.2), // reclaim: close back above 95
    );
    const sig = strat("sweep-reverse").create()(out);
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe("bullish");
    expect(sig!.stopLoss!).toBeLessThan(94.5);
    expect(sig!.targets[0].price).toBeGreaterThan(sig!.entry!);
  });
});

describe("range fade", () => {
  it("buys a pin at the bottom of a consolidating box", () => {
    T0 = 1_700_000_000_000;
    // Tight box oscillating 99.5–100.5 — low efficiency ratio.
    const out: Candle[] = Array.from({ length: 59 }, (_, i) => {
      const up = i % 2 === 0;
      return c(i, up ? 99.8 : 100.2, 100.5, 99.5, up ? 100.2 : 99.8);
    });
    // Bullish pin rejecting the lower edge.
    out.push(c(59, 99.7, 100.0, 99.2, 99.9));
    const sig = strat("range-fade").create()(out);
    expect(sig).toBeDefined();
    expect(sig!.direction).toBe("bullish");
    expect(sig!.stopLoss!).toBeLessThan(99.2);
  });

  it("stays out of a trending tape", () => {
    T0 = 1_700_000_000_000;
    const out = Array.from({ length: 60 }, (_, i) => c(i, 100 + i, 101 + i, 99.5 + i, 100.8 + i));
    expect(strat("range-fade").create()(out)).toBeUndefined();
  });
});
