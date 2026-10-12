import { describe, expect, it } from "vitest";
import type { Candle, CandleSeries } from "@/lib/types";
import type { EngineResult } from "@/lib/services/engine";
import { assertDeterministic, assertNoLookAhead } from "@/lib/testing";
import { aggregateCandles } from "../aggregation";
import { buildQualityReport } from "../quality";
import { HistoricalReplay } from "../replay";
import { alwaysOpen } from "../sessions";
import { normalizeCandles } from "../normalize";
import { FIXTURE_EPOCH as E, FIXTURES } from "../fixtures";

const clean = () =>
  normalizeCandles(FIXTURES.find((f) => f.name === "clean-continuous")!.rows).candles;

describe("determinism (spec 15)", () => {
  it("quality report is byte-identical across runs", () => {
    const candles = clean();
    const r = assertDeterministic(
      () =>
        buildQualityReport({
          symbol: "FIX-CLEAN",
          timeframe: "5m",
          candles,
          calendar: alwaysOpen(),
        }),
      undefined,
    );
    expect(r.ok).toBe(true);
  });

  it("aggregation is byte-identical across runs", () => {
    const source = normalizeCandles(FIXTURES.find((f) => f.name === "agg-5m-12")!.rows).candles;
    expect(assertDeterministic(() => aggregateCandles(source, "5m", "15m"), undefined).ok).toBe(
      true,
    );
  });

  it("replay emits the same context sequence twice", () => {
    const series = { symbol: "T", timeframe: "5m" as const, candles: clean() };
    const run = () =>
      [...new HistoricalReplay(series).iterate()].map((c) => ({
        i: c.currentIndex,
        t: c.timestamp,
        n: c.visibleBars.length,
      }));
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  it("assertNoLookAhead passes for causal per-bar features", () => {
    const series: CandleSeries = { symbol: "T", timeframe: "5m", candles: clean() };
    type Emission = { close: number; time: number };
    const causal = (input: { series: CandleSeries }): EngineResult<Emission[]> => ({
      ok: true,
      errors: [],
      meta: {
        stage: "test",
        paramsVersion: "t",
        barsConsumed: { from: 0, to: input.series.candles.length - 1 },
        events: [],
      },
      data: input.series.candles.map((c: Candle) => ({ close: c.close, time: c.time })),
    });
    const res = assertNoLookAhead(causal, { series }, (out: Emission[], atBar: number) =>
      out.filter((e: Emission) => e.time <= series.candles[atBar].time),
    );
    expect(res.ok).toBe(true);
  });

  it("replay context timestamps are strictly non-decreasing across steps", () => {
    const series = { symbol: "T", timeframe: "5m" as const, candles: clean() };
    const times = [...new HistoricalReplay(series).iterate()].map((c) => c.timestamp);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]).toBe(times[i - 1] + 300_000);
    }
    expect(times[0]).toBe(E);
  });
});
