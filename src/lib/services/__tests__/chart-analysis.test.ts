/**
 * Chart-triggered analysis tests — the pure seams behind "Analyze chart":
 * request construction from the displayed candle window, symbol/timeframe matching
 * (stale results can never render for a different selection), engine-plan overlay
 * mapping, and abort propagation through runAnalysis.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { toChartPlanOverlays } from "@/components/charts/chart-types";
import type { AnalysisResult, BacktestOpportunity } from "@/lib/types";
import { ServiceUnavailableError } from "@/lib/services/types";
import {
  CHART_ANALYSIS_MAX_LOOKBACK_DAYS,
  chartAnalysisRequest,
  pickCell,
  pickOpportunities,
  runAnalysis,
} from "../analysis-runner";

const DAY_MS = 86_400_000;
const END = Date.UTC(2026, 9, 15, 12, 0, 0);

const CELL = {
  symbol: "AAPL",
  timeframe: "4h" as const,
  barCount: 300,
  evaluatedIndex: 299,
  evaluatedAt: END - 4 * 3_600_000,
  asset: { symbol: "AAPL" },
  quality: {
    symbol: "AAPL",
    timeframe: "4h" as const,
    barCount: 300,
    missingBarCount: 0,
    duplicateCount: 0,
    invalidBarCount: 0,
    outOfOrderCount: 0,
    gaps: [],
    warnings: [],
    errors: [],
    info: [],
    status: "valid" as const,
  },
};

const RECORD: BacktestOpportunity = {
  setupId: "s1",
  symbol: "AAPL",
  timeframe: "4h",
  setupType: "continuation",
  direction: "bullish",
  status: "confirmed",
  evaluatedAt: CELL.evaluatedAt,
  evaluatedIndex: 299,
  rank: 1,
  score: 72,
  plan: {
    entry: 250,
    stopLoss: 240,
    targets: [{ label: "T1", price: 270 }],
    riskReward: 2,
  },
};

const RESULT: AnalysisResult = {
  asOf: new Date(END).toISOString(),
  cells: [CELL],
  opportunities: [RECORD],
  developing: [],
  skipped: [],
  dataSource: { id: "fake", kind: "rest", label: "Fake" },
  versions: { methodVersion: "m1", paramsVersion: "p1", configVersion: "c1" },
};

describe("chartAnalysisRequest — window and anchor", () => {
  it("asOf equals the candle window's exclusive end; lookback covers the span", () => {
    // 300 × 4h = 50 days of chart window.
    const start = END - 300 * 4 * 3_600_000;
    const built = chartAnalysisRequest({ symbol: "AAPL", timeframe: "4h", windowEnd: END, windowStart: start });
    expect(built.request.symbols).toEqual(["AAPL"]);
    expect(built.request.timeframe).toBe("4h");
    expect(built.request.asOf).toBe(new Date(END).toISOString());
    expect(built.lookbackDays).toBe(50);
    expect(built.request.lookbackDays).toBe(50);
    expect(built.windowClamped).toBe(false);
  });

  it("clamps oversized chart windows and discloses via windowClamped", () => {
    // 300 weekly bars ≈ 5.75 years — far beyond the 180d API bound.
    const start = END - 300 * 7 * DAY_MS;
    const built = chartAnalysisRequest({ symbol: "BTCUSDT", timeframe: "1W", windowEnd: END, windowStart: start });
    expect(built.lookbackDays).toBe(CHART_ANALYSIS_MAX_LOOKBACK_DAYS);
    expect(built.request.lookbackDays).toBe(180);
    expect(built.windowClamped).toBe(true);
  });

  it("never emits a sub-day lookback for a tiny window", () => {
    const start = END - 30 * 60_000; // 30 minutes
    const built = chartAnalysisRequest({ symbol: "AAPL", timeframe: "1m", windowEnd: END, windowStart: start });
    expect(built.lookbackDays).toBe(1);
  });
});

describe("matching — only the selected symbol/timeframe renders", () => {
  it("pickCell/pickOpportunities match the exact selection", () => {
    expect(pickCell(RESULT, "AAPL", "4h")?.evaluatedAt).toBe(CELL.evaluatedAt);
    expect(pickOpportunities(RESULT, "AAPL", "4h")).toHaveLength(1);
  });

  it("a stale result cannot match a different selection — overlay guard", () => {
    expect(pickCell(RESULT, "BTCUSDT", "4h")).toBeUndefined();
    expect(pickOpportunities(RESULT, "BTCUSDT", "4h")).toEqual([]);
    expect(pickOpportunities(RESULT, "AAPL", "1h")).toEqual([]); // timeframe must match too
  });

  it("skipped entries stay available for honest display", () => {
    const skipped: AnalysisResult = {
      ...RESULT,
      cells: [],
      opportunities: [],
      skipped: [{ symbol: "NIFTY 50", reason: "not served by provider" }],
    };
    expect(pickCell(skipped, "NIFTY 50", "4h")).toBeUndefined();
    expect(skipped.skipped[0].reason).toContain("not served");
  });
});

describe("toChartPlanOverlays — engine levels, nothing fabricated", () => {
  it("maps entry/stop/targets to labeled level overlays", () => {
    const overlays = toChartPlanOverlays("s1", "bullish", RECORD.plan);
    expect(overlays).toHaveLength(3);
    expect(overlays[0]).toMatchObject({ kind: "level", layer: "structure", price: 250, label: "Engine entry", direction: "bullish" });
    expect(overlays[1]).toMatchObject({ price: 240, label: "Engine stop" });
    expect(overlays[2]).toMatchObject({ price: 270, label: "Engine T1" });
    expect(overlays.every((o) => o.id.startsWith("s1-"))).toBe(true);
  });

  it("missing plan fields produce no lines — never invented", () => {
    expect(toChartPlanOverlays("s1", "bullish", undefined)).toEqual([]);
    expect(toChartPlanOverlays("s1", "bullish", { entry: 100 })).toHaveLength(1);
    const targetOnly = toChartPlanOverlays("s1", "bearish", { targets: [{ label: "T1", price: 50 }] });
    expect(targetOnly).toHaveLength(1);
    expect(targetOnly[0]).toMatchObject({ direction: "bearish" });
  });
});

describe("runAnalysis — abort propagation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("forwards AbortSignal and rethrows AbortError unwrapped", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")));
    await expect(
      runAnalysis({ symbols: ["AAPL"], timeframe: "4h" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it("network failure still maps to ServiceUnavailableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("down")));
    await expect(runAnalysis({ symbols: ["AAPL"], timeframe: "4h" })).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });
});
