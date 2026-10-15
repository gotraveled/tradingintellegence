/**
 * Product-layer tests for the Strategy Lab backtest consumer
 * (services/backtest-service.ts + backtest-runner.ts).
 *
 * Coverage: input composition, PIT boundary on provider fetches, engine invocation
 * (the real spec-26 engine — no duplicated logic), the SystemBacktestResult→BacktestResult
 * adapter, provider failure honesty, and request validation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoricalDataProvider, ProviderResponse } from "@/lib/market-data/provider";
import { providerError } from "@/lib/market-data/provider";
import type { runBacktest as engineRunBacktest } from "@/lib/engines/backtest";
import type {
  BacktestRequest,
  Candle,
  MarketDataRequest,
  SetupOutcome,
  SystemBacktestResult,
} from "@/lib/types";
import type { EngineResult } from "../engine";
import { defaultConfig } from "../engine-defaults";
import {
  defaultUniverse,
  executeSystemBacktest,
  toBacktestResult,
} from "../backtest-service";
import { runBacktest } from "../backtest-runner";
import { ServiceUnavailableError } from "../types";

// ---------------------------------------------------------------------------
// Deterministic provider — a real HistoricalDataProvider, not a mock of internals.
// Returns candles filtered by the request's [start, end) bounds like any vendor would.

const H1 = 3_600_000;
const EPOCH = Date.UTC(2024, 0, 1); // Monday 2024-01-01T00:00:00Z
const bar = (i: number): Candle => ({
  time: EPOCH + i * H1,
  open: 100 + i * 0.05,
  high: 100.6 + i * 0.05,
  low: 99.4 + i * 0.05,
  close: 100.2 + i * 0.05,
  volume: 1000,
});

class MapProvider implements HistoricalDataProvider {
  readonly source = { id: "test-map", kind: "database" as const, label: "Test map provider" };
  constructor(private readonly series: Map<string, Candle[]>) {}
  supports(request: MarketDataRequest): boolean {
    return this.series.has(request.asset.symbol);
  }
  async getCandles(request: MarketDataRequest): Promise<ProviderResponse> {
    const rows = this.series.get(request.asset.symbol);
    if (!rows) {
      return providerError("unsupported_symbol", `symbol '${request.asset.symbol}' not registered`);
    }
    if (!this.supportsTimeframe(request.timeframe)) {
      return providerError("unsupported_timeframe", `timeframe '${request.timeframe}' unsupported`);
    }
    const candles = rows.filter((c) => c.time >= request.start && c.time < request.end);
    return {
      ok: true,
      result: {
        candles,
        quality: {
          symbol: request.asset.symbol,
          timeframe: request.timeframe,
          barCount: candles.length,
          missingBarCount: 0,
          duplicateCount: 0,
          invalidBarCount: 0,
          outOfOrderCount: 0,
          gaps: [],
          warnings: [],
          errors: [],
          info: [],
          status: "valid",
        },
        source: this.source,
      },
    };
  }
  private supportsTimeframe(tf: string): boolean {
    return tf === "1h";
  }
}

const REQUEST: BacktestRequest = {
  strategyId: "strat-htf-reversal",
  timeframe: "1h",
  period: { from: "2024-01-01T00:00:00Z", to: "2024-01-15T00:00:00Z" },
  setupType: "reversal",
  minScore: 60,
  riskPerTradePct: 1,
};

type EngineInput = Parameters<typeof engineRunBacktest>[0];

function engineSpy(
  result: EngineResult<SystemBacktestResult>,
  captured: { input?: EngineInput } = {},
): { run: typeof engineRunBacktest; captured: { input?: EngineInput } } {
  return {
    run: (input) => {
      captured.input = input;
      return result;
    },
    captured,
  };
}

function emptySystemResult(): SystemBacktestResult {
  return {
    cells: [{ symbol: "AAA", timeframe: "1h" }],
    opportunities: [],
    developing: [],
    outcomes: [],
    aggregate: {
      observationCount: 0,
      developingObservationCount: 0,
      uniqueSetupCount: 0,
      selectedObservationCount: 0,
      resolvedOutcomeCount: 0,
      outcomeCounts: { target: 0, stop: 0, expired: 0, cancelled: 0, unresolved: 0 },
    },
    versions: { methodVersion: "v1-bt", paramsVersion: "self|tk*", configVersion: "v1-engine" },
  };
}

function engineResult(data: SystemBacktestResult): EngineResult<SystemBacktestResult> {
  return {
    ok: true,
    data,
    errors: [],
    meta: {
      stage: "system-backtest",
      paramsVersion: "self|tk*",
      barsConsumed: { from: 0, to: 0 },
      events: [],
    },
  };
}

// ---------------------------------------------------------------------------

describe("universe resolution", () => {
  it("maps request symbols to AssetIdentifier (catalog metadata when known)", () => {
    const universe = defaultUniverse({ ...REQUEST, symbols: ["BTCUSDT", "ZZZ-UNKNOWN"] });
    expect(universe.map((a) => a.symbol)).toEqual(["BTCUSDT", "ZZZ-UNKNOWN"]);
    expect(universe[0].assetClass).toBe("crypto");
    expect(universe[1]).toEqual({ symbol: "ZZZ-UNKNOWN" });
  });

  it("uses the catalog filtered by market when no symbols are given", () => {
    const universe = defaultUniverse({ ...REQUEST, market: "crypto" });
    expect(universe.map((a) => a.symbol)).toEqual(["BTCUSDT", "ETHUSDT"]);
  });
});

describe("input composition + PIT boundary", () => {
  it("fetches each universe symbol and builds spec-26 cells without frames", async () => {
    const provider = new MapProvider(new Map([["AAA", Array.from({ length: 30 }, (_, i) => bar(i))]]));
    const captured: { input?: EngineInput } = {};
    const { run } = engineSpy(engineResult(emptySystemResult()), captured);
    const request = { ...REQUEST, symbols: ["AAA"], period: { from: "2024-01-01T00:00:00Z", to: "2024-01-02T00:00:00Z" } };

    await executeSystemBacktest(request, { provider, run, config: defaultConfig() });

    const input = captured.input;
    expect(input).toBeDefined();
    expect(input!.cells).toHaveLength(1);
    expect(input!.cells[0].symbol).toBe("AAA");
    expect(input!.cells[0].timeframe).toBe("1h");
    expect(input!.cells[0].frames).toBeUndefined();
    expect(input!.cells[0].series.symbol).toBe("AAA");
    expect(input!.selection).toEqual({ filters: { setupTypes: ["reversal"], minScore: 60 } });
    expect(input!.runId).toBe("sl-strat-htf-reversal");
    expect(input!.config.version).toBe("v1-engine");
  });

  it("excludes candles outside the request window — to at midnight includes that day (exclusive bound)", async () => {
    // 48 hourly bars across 2024-01-01..02; window to=2024-01-02 (midnight → +1d).
    const provider = new MapProvider(new Map([["AAA", Array.from({ length: 72 }, (_, i) => bar(i))]]));
    const captured: { input?: EngineInput } = {};
    const { run } = engineSpy(engineResult(emptySystemResult()), captured);

    await executeSystemBacktest(
      { ...REQUEST, symbols: ["AAA"], period: { from: "2024-01-01T00:00:00Z", to: "2024-01-02T00:00:00Z" } },
      { provider, run },
    );

    const candles = captured.input!.cells[0].series.candles;
    const endExclusive = Date.parse("2024-01-02T00:00:00Z") + 86_400_000;
    expect(candles).toHaveLength(48);
    expect(candles.every((c) => c.time >= EPOCH && c.time < endExclusive)).toBe(true);
    // No candle at/after the exclusive bound leaks into the engine input.
    expect(candles.at(-1)!.time).toBe(endExclusive - H1);
  });
});

describe("engine invocation", () => {
  it("calls the spec-26 engine path rather than duplicating logic", async () => {
    const provider = new MapProvider(new Map([["AAA", Array.from({ length: 40 }, (_, i) => bar(i))]]));
    const captured: { input?: EngineInput } = {};
    const { run } = engineSpy(engineResult(emptySystemResult()), captured);

    const exec = await executeSystemBacktest(
      { ...REQUEST, symbols: ["AAA"] },
      { provider, run },
    );

    expect(captured.input).toBeDefined();
    expect(exec.evaluatedSymbols).toEqual(["AAA"]);
    expect(exec.skipped).toEqual([]);
  });

  it("surfaces engine failure honestly — never a fabricated result", async () => {
    const provider = new MapProvider(new Map([["AAA", Array.from({ length: 40 }, (_, i) => bar(i))]]));
    const failing = (): EngineResult<SystemBacktestResult> => ({
      ok: false,
      errors: [{ code: "invalid_config", message: "config.backtest.methodVersion required" }],
      meta: { stage: "system-backtest", paramsVersion: "self|tk*", barsConsumed: { from: -1, to: -1 }, events: [] },
    });
    await expect(
      executeSystemBacktest({ ...REQUEST, symbols: ["AAA"] }, { provider, run: failing }),
    ).rejects.toThrow("Backtest engine failed: invalid_config");
  });
});

describe("SystemBacktestResult → BacktestResult adapter", () => {
  const outcome = (over: Partial<SetupOutcome>): SetupOutcome => ({
    setupId: "s1",
    symbol: "AAA",
    timeframe: "1h",
    setupType: "reversal",
    direction: "bullish",
    scoreAtConfirmation: 70,
    paramsVersion: "v1-engine",
    targetsReached: 0,
    stopReached: false,
    expired: false,
    confirmedAt: "2024-01-02T00:00:00Z",
    resolvedAt: "2024-01-05T00:00:00Z",
    entryPrice: 100,
    initialRisk: 2,
    rMultiple: 1.5,
    ...over,
  });

  const baseResult = (outcomes: SetupOutcome[]): SystemBacktestResult => ({
    ...emptySystemResult(),
    runId: "sl-strat-htf-reversal",
    outcomes,
  });

  it("maps resolved activated outcomes to trades deterministically", () => {
    const rows = [
      outcome({ setupId: "s2", rMultiple: -1, targetsReached: 0, stopReached: true, resolvedAt: "2024-01-06T00:00:00Z" }),
      outcome({ setupId: "s1", rMultiple: 2, targetsReached: 2, resolvedAt: "2024-01-04T00:00:00Z" }),
      // never activated → not a trade
      outcome({ setupId: "s3", entryPrice: undefined, initialRisk: undefined, rMultiple: 0, expired: true }),
      // unresolved → excluded entirely
      outcome({ setupId: "s4", rMultiple: undefined, unresolved: true }),
    ];
    const res = toBacktestResult(baseResult(rows), REQUEST, false);

    expect(res.id).toBe("sl-strat-htf-reversal");
    expect(res.strategyId).toBe("strat-htf-reversal");
    expect(res.timeframe).toBe("1h");
    expect(res.period).toEqual(REQUEST.period);
    expect(res.sampleSize).toBe(2);
    // ordered by resolvedAt: s1 (+2R) then s2 (−1R)
    expect(res.trades!.map((t) => t.id)).toEqual(["s1", "s2"]);
    expect(res.hitRate).toBe(1 / 2);
    expect(res.averageR).toBeCloseTo(0.5, 10);
    expect(res.expectancyR).toBeCloseTo(0.5, 10);
    expect(res.profitFactor).toBeCloseTo(2, 10);
    expect(res.maxDrawdownR).toBeCloseTo(1, 10);
    expect(res.assumptions).toBeUndefined();
    expect(res.outOfSample).toBeUndefined();
    // deterministic: same input → identical output (createdAt excluded)
    const res2 = toBacktestResult(baseResult(rows), REQUEST, false);
    expect({ ...res, createdAt: "" }).toEqual({ ...res2, createdAt: "" });
  });

  it("derives exit price and times from stamped fields — entryAt from confirm + barsToActive", () => {
    const res = toBacktestResult(
      baseResult([outcome({ barsToActive: 4, rMultiple: 1.5 })]),
      REQUEST,
      false,
    );
    const trade = res.trades![0];
    expect(trade.entry).toBe(100);
    expect(trade.exit).toBeCloseTo(100 + 1.5 * 2, 10);
    expect(trade.entryAt).toBe(new Date(Date.parse("2024-01-02T00:00:00Z") + 4 * H1).toISOString());
    expect(trade.exitAt).toBe("2024-01-05T00:00:00Z");
    expect(trade.outcome).toBe("target");
  });

  it("maps stop/expired/breakeven outcomes; zero trades → honest zeros", () => {
    const res = toBacktestResult(
      baseResult([
        outcome({ rMultiple: -1, stopReached: true }),
        outcome({ setupId: "s2", rMultiple: 0, expired: true, targetsReached: 0 }),
      ]),
      REQUEST,
      false,
    );
    expect(res.trades!.map((t) => t.outcome)).toEqual(["stop", "timeout"]);
    const empty = toBacktestResult(emptySystemResult(), REQUEST, false);
    expect(empty.sampleSize).toBe(0);
    expect(empty.hitRate).toBe(0);
    expect(empty.expectancyR).toBe(0);
    expect(empty.trades).toEqual([]);
  });

  it("selection applies spec-25 marking — only selected setups count", () => {
    const result = baseResult([outcome({ setupId: "s1" }), outcome({ setupId: "s2", rMultiple: -1, stopReached: true })]);
    result.opportunities = [
      {
        setupId: "s2", symbol: "AAA", timeframe: "1h", setupType: "reversal", direction: "bullish",
        status: "confirmed", evaluatedAt: 0, evaluatedIndex: 0, rank: 1, selected: true, score: 80,
      },
    ];
    const res = toBacktestResult(result, REQUEST, true);
    expect(res.sampleSize).toBe(1);
    expect(res.trades![0].id).toBe("s2");
  });
});

describe("provider failure + request validation", () => {
  it("all-symbols provider failure → ServiceUnavailableError, never a fabricated run", async () => {
    const provider = new MapProvider(new Map());
    await expect(
      executeSystemBacktest({ ...REQUEST, symbols: ["AAA", "BBB"] }, { provider }),
    ).rejects.toThrow(ServiceUnavailableError);
  });

  it("partial provider failure → cell skipped, run proceeds on the rest", async () => {
    const provider = new MapProvider(new Map([["AAA", Array.from({ length: 30 }, (_, i) => bar(i))]]));
    const captured: { input?: EngineInput } = {};
    const { run } = engineSpy(engineResult(emptySystemResult()), captured);
    const exec = await executeSystemBacktest(
      { ...REQUEST, symbols: ["AAA", "BBB"] },
      { provider, run },
    );
    expect(exec.skipped).toEqual([
      { symbol: "BBB", reason: "symbol 'BBB' not registered" },
    ]);
    expect(captured.input!.cells.map((c) => c.symbol)).toEqual(["AAA"]);
  });

  it("empty candle set from provider → unavailable, not a fake backtest", async () => {
    const provider = new MapProvider(new Map([["AAA", []]]));
    await expect(
      executeSystemBacktest({ ...REQUEST, symbols: ["AAA"] }, { provider }),
    ).rejects.toThrow(ServiceUnavailableError);
  });

  it("rejects invalid input before any provider call", async () => {
    const calls: MarketDataRequest[] = [];
    class SpyProvider extends MapProvider {
      async getCandles(r: MarketDataRequest) {
        calls.push(r);
        return super.getCandles(r);
      }
    }
    const provider = new SpyProvider(new Map([["AAA", [bar(0)]]]));

    await expect(
      executeSystemBacktest(
        { ...REQUEST, symbols: ["AAA"], period: { from: "2024-01-02T00:00:00Z", to: "2024-01-01T00:00:00Z" } },
        { provider },
      ),
    ).rejects.toThrow("'from' must be before 'to'");
    await expect(
      executeSystemBacktest({ ...REQUEST, market: "crypto" }, { provider, universe: () => [] }),
    ).rejects.toThrow("No instruments known");
    await expect(
      executeSystemBacktest({ ...REQUEST, minScore: 120, symbols: ["AAA"] }, { provider }),
    ).rejects.toThrow("minScore");
    expect(calls).toHaveLength(0);
  });
});

describe("service seam — backtest-runner (client side of /api/backtest)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the request to /api/backtest and returns the result", async () => {
    const result = { id: "r1", strategyId: "s", sampleSize: 0, hitRate: 0, averageR: 0, expectancyR: 0, createdAt: "2024-01-01T00:00:00Z" };
    const spy = vi.fn().mockResolvedValue(Response.json({ result }, { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const out = await runBacktest(REQUEST);
    expect(out).toEqual(result);
    expect(spy).toHaveBeenCalledWith("/api/backtest", expect.objectContaining({ method: "POST" }));
  });

  it("503 → ServiceUnavailableError — provider unavailable is honest, never demo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ error: { service: "Market data provider", message: "Not configured." } }, { status: 503 }),
      ),
    );
    await expect(runBacktest(REQUEST)).rejects.toThrow(ServiceUnavailableError);
  });

  it("4xx/5xx surface as plain errors; transport failure → ServiceUnavailableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: { message: "minScore must be between 0 and 100." } }, { status: 400 })),
    );
    await expect(runBacktest(REQUEST)).rejects.toThrow("minScore");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket closed")));
    await expect(runBacktest(REQUEST)).rejects.toThrow(ServiceUnavailableError);
  });
});
