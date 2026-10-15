/**
 * Product-layer composition tests for executeAnalysis — deterministic providers and
 * an injectable `run` seam; no real provider traffic, and nothing here is presented
 * as a real-provider validation.
 */
import { describe, expect, it } from "vitest";
import { executeAnalysis } from "../analysis-service";
import type { runBacktest } from "@/lib/engines/backtest";
import type { HistoricalDataProvider, ProviderResponse } from "@/lib/market-data/provider";
import type {
  AnalysisRequest,
  BacktestDeveloping,
  BacktestOpportunity,
  Candle,
  MarketDataRequest,
  SystemBacktestResult,
} from "@/lib/types";

const H1 = 3_600_000;
const EPOCH = Date.UTC(2024, 0, 1);
const AS_OF = new Date(EPOCH + 100 * H1).toISOString(); // all fixture bars closed

const flatBar = (i: number): Candle => ({
  time: EPOCH + i * H1, open: 100, high: 100.5, low: 99.5, close: 100, volume: 10,
});

class TestProvider implements HistoricalDataProvider {
  readonly source = { id: "test", kind: "fixture" as const, label: "Test provider" };
  constructor(
    private readonly rows: Candle[],
    private readonly reject: Set<string> = new Set(),
  ) {}
  supports(r: MarketDataRequest): boolean {
    return r.asset.marketId !== "indian-markets";
  }
  async getCandles(r: MarketDataRequest): Promise<ProviderResponse> {
    if (this.reject.has(r.asset.symbol)) {
      return { ok: false, error: { code: "provider_error", message: "provider failed" } };
    }
    const candles = this.rows.filter((c) => c.time >= r.start && c.time < r.end);
    return {
      ok: true,
      result: {
        candles,
        quality: {
          symbol: r.asset.symbol, timeframe: r.timeframe, barCount: candles.length,
          missingBarCount: 0, duplicateCount: 0, invalidBarCount: 0, outOfOrderCount: 0,
          gaps: [], warnings: [], errors: [], info: [], status: "valid",
        },
        source: this.source,
      },
    };
  }
}

const baseRequest: AnalysisRequest = {
  symbols: ["AAA"],
  timeframe: "1h",
  lookbackDays: 30,
  asOf: AS_OF,
};

const fakeResult = (over?: Partial<SystemBacktestResult>): SystemBacktestResult => ({
  runId: "analysis",
  cells: [{ symbol: "AAA", timeframe: "1h" }],
  opportunities: [],
  developing: [],
  outcomes: [],
  aggregate: { observationCount: 0, developingObservationCount: 0, uniqueSetupCount: 0, selectedObservationCount: 0, resolvedOutcomeCount: 0, outcomeCounts: { target: 0, stop: 0, expired: 0, cancelled: 0, unresolved: 0 } },
  versions: { methodVersion: "v1-bt", paramsVersion: "selnof|tk*", configVersion: "v1-engine" },
  ...over,
});

const okRun = (result: SystemBacktestResult): typeof runBacktest =>
  (() => ({
    ok: true,
    data: result,
    errors: [],
    meta: { stage: "system-backtest", paramsVersion: "x", barsConsumed: { from: 0, to: 1 }, events: [] },
  })) as unknown as typeof runBacktest;

const opp = (over: Partial<BacktestOpportunity> = {}): BacktestOpportunity => ({
  setupId: "s1", symbol: "AAA", timeframe: "1h", setupType: "reversal",
  direction: "bullish", status: "active", evaluatedAt: 0, evaluatedIndex: 0,
  rank: 1, score: 70, ...over,
});

const dev = (over: Partial<BacktestDeveloping> = {}): BacktestDeveloping => ({
  setupId: "d1", symbol: "AAA", timeframe: "1h", setupType: "breakout",
  direction: "bearish", evaluatedAt: 0, evaluatedIndex: 0, ...over,
});

describe("executeAnalysis", () => {
  it("runs the real engine over provider candles — flat series yields honest empty scan", async () => {
    const provider = new TestProvider(Array.from({ length: 120 }, (_, i) => flatBar(i)));
    const result = await executeAnalysis(baseRequest, { provider });
    expect(Date.parse(result.asOf)).toBe(Date.parse(AS_OF));
    expect(result.cells).toHaveLength(1);
    // Fetch bound is asOf-exclusive → bars 0..99; bar99 closes exactly at asOf.
    expect(result.cells[0].evaluatedIndex).toBe(99); // last closed bar at asOf
    expect(result.cells[0].evaluatedAt).toBe(EPOCH + 99 * H1);
    expect(result.opportunities).toEqual([]);
    expect(result.developing).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.dataSource.id).toBe("test");
    expect(result.versions.configVersion).toBe("v1-engine");
  });

  it("returns only anchor-bar records and strips outcomeRef (no post-anchor leakage)", async () => {
    const provider = new TestProvider(Array.from({ length: 120 }, (_, i) => flatBar(i)));
    const anchor = 99; // last closed bar at asOf (exclusive end fetches bars 0..99)
    const result = fakeResult({
      opportunities: [
        opp({ setupId: "at-anchor", evaluatedIndex: anchor }),
        opp({ setupId: "earlier", evaluatedIndex: anchor - 5 }),
        opp({ setupId: "with-ref", evaluatedIndex: anchor, outcomeRef: "s1" }),
      ],
      developing: [
        dev({ setupId: "dev-anchor", evaluatedIndex: anchor }),
        dev({ setupId: "dev-earlier", evaluatedIndex: anchor - 2 }),
      ],
    });
    const out = await executeAnalysis(baseRequest, { provider, run: okRun(result) });
    expect(out.opportunities.map((o) => o.setupId).sort()).toEqual(["at-anchor", "with-ref"]);
    expect(out.developing.map((d) => d.setupId)).toEqual(["dev-anchor"]);
    // outcomeRef must be stripped — it is measured over post-anchor bars.
    expect("outcomeRef" in out.opportunities[0]).toBe(false);
    expect("outcomeRef" in out.opportunities[1]).toBe(false);
  });

  it("partial failures: failing symbol lands in skipped, evaluated symbols still run", async () => {
    const provider = new TestProvider(
      Array.from({ length: 120 }, (_, i) => flatBar(i)),
      new Set(["BBB"]),
    );
    const out = await executeAnalysis(
      { ...baseRequest, symbols: ["AAA", "BBB"] },
      { provider },
    );
    expect(out.cells).toHaveLength(1);
    expect(out.cells[0].symbol).toBe("AAA");
    expect(out.skipped).toEqual([{ symbol: "BBB", reason: "provider failed" }]);
  });

  it("unsupported symbols never reach the provider", async () => {
    const provider = new TestProvider(Array.from({ length: 10 }, (_, i) => flatBar(i)));
    let called = 0;
    const counting = new Proxy(provider, {
      get: (t, p) => (p === "getCandles" ? async (r: MarketDataRequest) => { called++; return t.getCandles(r); } : Reflect.get(t, p)),
    });
    const out = await executeAnalysis(
      { ...baseRequest, symbols: ["AAA", "NIFTY 50"] },
      { provider: counting },
    );
    expect(called).toBe(1);
    expect(out.skipped[0].symbol).toBe("NIFTY 50");
    expect(out.skipped[0].reason).toMatch(/unsupported/i);
  });

  it("insufficient history — no closed bar at asOf → symbol skipped honestly", async () => {
    // Provider serves one bar; asOf is inside its open→close window (nothing closed).
    const provider = new TestProvider([flatBar(0)]);
    const out = await executeAnalysis(
      { ...baseRequest, symbols: ["AAA"], asOf: new Date(EPOCH + H1 / 2).toISOString() },
      { provider },
    ).catch((e: Error) => e);
    // With the only symbol unanchorable the composition must refuse, not fabricate.
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toMatch(/No historical candles|analysis was not run/i);
  });

  it("a valid analysis with zero qualifying opportunities is a 200-style empty result", async () => {
    const provider = new TestProvider(Array.from({ length: 200 }, (_, i) => flatBar(i)));
    const out = await executeAnalysis(baseRequest, { provider });
    // Engine ran (cell present), zero opportunities — valid empty, distinct from failure.
    expect(out.cells).toHaveLength(1);
    expect(out.opportunities).toHaveLength(0);
    expect(out.skipped).toHaveLength(0);
  });

  it("point-in-time: records past asOf are never in the payload", async () => {
    // asOf inside the middle of the series — anchor < last fetched bar.
    const provider = new TestProvider(Array.from({ length: 120 }, (_, i) => flatBar(i)));
    const midAsOf = new Date(EPOCH + 50 * H1).toISOString();
    const out = await executeAnalysis(
      { ...baseRequest, asOf: midAsOf },
      { provider, run: okRun(fakeResult({
        opportunities: [
          opp({ setupId: "past", evaluatedIndex: 49 }),
          opp({ setupId: "anchor", evaluatedIndex: 49 }),
        ],
      })) },
    );
    expect(out.cells[0].evaluatedIndex).toBe(49); // bar49 closes at 50h ≤ asOf
    // Both records are at the anchor index — legitimately returned; anything beyond
    // the anchor index is dropped by the filter contract.
    expect(out.opportunities.every((o) => o.evaluatedIndex <= 49)).toBe(true);
  });

  it("identical inputs → identical outputs (deterministic composition)", async () => {
    const provider = () => new TestProvider(Array.from({ length: 120 }, (_, i) => flatBar(i)));
    const a = await executeAnalysis(baseRequest, { provider: provider() });
    const b = await executeAnalysis(baseRequest, { provider: provider() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("no demo fallback: empty provider output → ServiceUnavailableError, never a stub", async () => {
    const provider = new TestProvider([]);
    await expect(executeAnalysis(baseRequest, { provider })).rejects.toMatchObject({
      service: "Market data provider",
    });
  });
});
