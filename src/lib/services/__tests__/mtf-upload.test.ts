/**
 * Phase P3 — multi-timeframe upload composition tests.
 *
 * Scope: this layer owns assignment, transport, and reporting — NOT the join.
 * The causal join itself (`closedIndexAt`, `barCloseTime`, `causalFramesAt`,
 * `causalAlignAt`) is proven by the spec-31 suite; these tests verify that
 * (a) uploaded series reach `BacktestCell.frames` under the correct roles,
 * (b) visibility reports use the same closed-bar boundary the engine joins on,
 * (c) failures (duplicate tf, wrong instrument, misordered roles) are
 *     rejected rather than merged or silently skipped, and
 * (d) the `executeAnalysis` wiring stays bit-identical when frames are absent.
 */
import { describe, expect, it } from "vitest";
import type { BacktestCell, Candle, Timeframe } from "@/lib/types";
import type { UploadedSeries } from "../uploaded-provider";
import { runBacktest } from "@/lib/engines/backtest";
import { closedIndexAt, barCloseTime } from "@/lib/engines/mtf";
import { TIMEFRAME_MS } from "@/lib/market-data/timeframes";
import { executeAnalysis } from "../analysis-service";
import { defaultConfig } from "../engine-defaults";
import { UploadedDatasetProvider } from "../uploaded-provider";
import {
  assignMtfRoles,
  classifyTimeSemantics,
  commonWindow,
  describeFrames,
  isCanonicalTimeframe,
  mtfFrameResolver,
  withMtfSet,
} from "../mtf-upload";

const EPOCH = Date.UTC(2026, 0, 1);
const ms = (tf: Timeframe) => TIMEFRAME_MS[tf as keyof typeof TIMEFRAME_MS];

/** Fixed-interval candles; tests avoid "1M" (variable month length). */
function candles(tf: Timeframe, n: number, opts: { start?: number; step?: number } = {}): Candle[] {
  const start = opts.start ?? EPOCH;
  const step = opts.step ?? 0.5;
  return Array.from({ length: n }, (_, i) => ({
    time: start + i * ms(tf),
    open: 100 + i * step,
    high: 100 + i * step + 0.4,
    low: 100 + i * step - 0.6,
    close: 100 + i * step + 0.2,
    volume: 1_000,
  }));
}

const series = (tf: Timeframe, n: number, opts?: { start?: number; step?: number }): UploadedSeries => ({
  symbol: "TEST",
  timeframe: tf,
  candles: candles(tf, n, opts),
});

// ---------------------------------------------------------------------------
// assignMtfRoles — spec-10 role grammar over the uploaded set
// ---------------------------------------------------------------------------

describe("assignMtfRoles", () => {
  it("three uploads → nearest-above htf, nearest-below etf", () => {
    const r = assignMtfRoles(["4h", "1h", "15m"], "1h");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.assignment.roles).toEqual({ htf: "4h", itf: "1h", etf: "15m" });
    expect(r.assignment.set).toEqual({ htf: "4h", itf: "1h", etf: "15m" });
    expect(r.assignment.unused).toEqual([]);
  });

  it("two uploads above anchor → htf bound, etf placeholder never misbinds", () => {
    const r = assignMtfRoles(["1D", "1h"], "1h");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.assignment.roles.htf).toBe("1D");
    expect(r.assignment.roles.etf).toBeUndefined();
    // Placeholder must be canonical, ≠ anchor, ≠ bound — the cell's own series
    // may never be served as another role.
    expect(r.assignment.set.etf).not.toBe("1h");
    expect(r.assignment.set.etf).not.toBe("1D");
    expect(isCanonicalTimeframe(r.assignment.set.etf)).toBe(true);
  });

  it("extra uploads beyond the three roles are reported unused, never dropped silently", () => {
    const r = assignMtfRoles(["1D", "4h", "1h", "15m", "1m"], "1h");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.assignment.roles).toEqual({ htf: "4h", itf: "1h", etf: "15m" });
    expect(r.assignment.unused).toEqual(expect.arrayContaining(["1D", "1m"]));
    expect(r.assignment.unused).toHaveLength(2);
  });

  it("explicit overrides are honored after validation", () => {
    const r = assignMtfRoles(["1D", "4h", "1h", "15m"], "1h", { htf: "1D", etf: "15m" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.assignment.roles.htf).toBe("1D");
    expect(r.assignment.unused).toEqual(["4h"]);
  });

  it("rejects misordered or unuploaded overrides — never a silent rebind", () => {
    expect(assignMtfRoles(["4h", "1h", "15m"], "1h", { htf: "15m" }).ok).toBe(false);
    expect(assignMtfRoles(["4h", "1h", "15m"], "1h", { etf: "4h" }).ok).toBe(false);
    expect(assignMtfRoles(["4h", "1h", "15m"], "1h", { htf: "1W" }).ok).toBe(false);
  });

  it("anchor must be one of the uploads", () => {
    expect(assignMtfRoles(["4h", "15m"], "1h").ok).toBe(false);
  });

  it("anchor at a boundary (no tf above) → htf placeholder cannot equal the anchor", () => {
    const r = assignMtfRoles(["1M", "1D"], "1M");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.assignment.roles.htf).toBeUndefined();
    expect(r.assignment.roles.etf).toBe("1D");
    expect(r.assignment.set.htf).not.toBe("1M");
    expect(r.assignment.set.htf).not.toBe(r.assignment.set.etf);
  });
});

// ---------------------------------------------------------------------------
// mtfFrameResolver — spec-31 transport wiring
// ---------------------------------------------------------------------------

describe("mtfFrameResolver", () => {
  const datasets = [series("4h", 40), series("1h", 120), series("15m", 300)];
  const roles = { htf: "4h" as Timeframe, itf: "1h" as Timeframe, etf: "15m" as Timeframe };
  const resolve = mtfFrameResolver({ symbol: "TEST", anchor: "1h", roles, datasets });

  it("supplies htf+etf CandleSeries only for the anchor cell", () => {
    const frames = resolve({ symbol: "TEST" }, "1h");
    expect(frames).toBeDefined();
    expect(frames?.htf?.timeframe).toBe("4h");
    expect(frames?.htf?.candles).toHaveLength(40);
    expect(frames?.etf?.timeframe).toBe("15m");
    // The itf role is served by the cell's own series — never duplicated.
    expect(frames?.itf).toBeUndefined();
  });

  it("never attaches frames to another symbol or timeframe", () => {
    expect(resolve({ symbol: "OTHER" }, "1h")).toBeUndefined();
    expect(resolve({ symbol: "TEST" }, "4h")).toBeUndefined();
  });

  it("two-role runs supply only what exists", () => {
    const two = mtfFrameResolver({
      symbol: "TEST",
      anchor: "1h",
      roles: { htf: "4h", itf: "1h" },
      datasets: datasets.slice(0, 2),
    });
    const frames = two({ symbol: "TEST" }, "1h");
    expect(frames?.htf).toBeDefined();
    expect(frames?.etf).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// describeFrames + commonWindow — closed-bar visibility reporting
// ---------------------------------------------------------------------------

describe("describeFrames — causal visibility", () => {
  it("a frame bar still forming at the anchor is excluded (close ≤ anchor rule)", () => {
    // 4h frame: last bar opens at T but closes at T+4h. Anchor = T+1h —
    // inside that bar's open→close span. It must NOT be visible.
    const T = EPOCH + 100 * ms("4h");
    const htf = series("4h", 101); // last bar opens at EPOCH+100*4h, closes +4h later
    const anchorClose = T + ms("1h"); // an itf bar close inside the forming 4h bar
    const report = describeFrames({
      roles: { htf: "4h", itf: "1h" },
      datasets: [htf, series("1h", 120)],
      anchorCloseMs: anchorClose,
    });
    const htfRow = report.find((r) => r.timeframe === "4h");
    // closedIndexAt uses the SAME boundary the engine joins on — bar 99 (close T)
    // is visible; bar 100 (close T+4h) is not.
    expect(htfRow?.closedIndexAtAnchor).toBe(99);
    expect(htfRow?.state).toBe("usable");
    expect(closedIndexAt(htf.candles, "4h", anchorClose)).toBe(99);
    // One hour later is still inside the forming bar; at its close it becomes visible.
    expect(closedIndexAt(htf.candles, "4h", T + ms("4h"))).toBe(100);
  });

  it("a frame with no closed bar at the anchor reports no-closed-bar (vote-0, not a vote)", () => {
    // htf ends long before the anchor → every bar is closed → usable.
    // htf STARTS after the anchor → nothing closed yet → no-closed-bar.
    const late = series("4h", 20, { start: EPOCH + 500 * ms("1h") });
    const report = describeFrames({
      roles: { htf: "4h", itf: "1h" },
      datasets: [late, series("1h", 120)],
      anchorCloseMs: EPOCH + 100 * ms("1h"),
    });
    const htfRow = report.find((r) => r.timeframe === "4h");
    expect(htfRow?.closedIndexAtAnchor).toBe(-1);
    expect(htfRow?.state).toBe("no-closed-bar");
  });

  it("itf row reports serves-cell and unused uploads report unused", () => {
    const report = describeFrames({
      roles: { htf: "4h", itf: "1h" },
      datasets: [series("4h", 40), series("1h", 120), series("1D", 10)],
      anchorCloseMs: EPOCH + 100 * ms("1h"),
    });
    expect(report.find((r) => r.timeframe === "1h")?.state).toBe("serves-cell");
    expect(report.find((r) => r.timeframe === "1D")?.state).toBe("unused");
  });
});

describe("commonWindow", () => {
  it("is [max first-open, min last-close] using canonical barCloseTime", () => {
    const a = series("1h", 100);
    const b = series("4h", 40, { start: EPOCH + 10 * ms("1h") });
    const w = commonWindow([a, b]);
    expect(w).not.toBeNull();
    expect(w?.start).toBe(EPOCH + 10 * ms("1h"));
    expect(w?.end).toBe(Math.min(
      barCloseTime(a.candles[99], "1h"),
      barCloseTime(b.candles[39], "4h"),
    ));
  });

  it("non-overlapping datasets → null (no anchor moment exists)", () => {
    const early = series("1h", 50);
    const late = series("4h", 20, { start: EPOCH + 500 * ms("1h") });
    expect(commonWindow([early, late])).toBeNull();
  });

  it("empty dataset → null", () => {
    const empty: UploadedSeries = { symbol: "T", timeframe: "4h", candles: [] };
    expect(commonWindow([series("1h", 50), empty])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyTimeSemantics — timezone ambiguity reporting
// ---------------------------------------------------------------------------

describe("classifyTimeSemantics", () => {
  it("epoch seconds and milliseconds are classified separately", () => {
    expect(classifyTimeSemantics("1767225600").kind).toBe("epoch_seconds");
    expect(classifyTimeSemantics("1767225600000").kind).toBe("epoch_ms");
  });
  it("explicit offsets are detected; naive ISO is flagged ambiguous", () => {
    expect(classifyTimeSemantics("2026-01-01T00:00:00Z").kind).toBe("iso_explicit");
    expect(classifyTimeSemantics("2026-01-01T00:00:00+05:30").kind).toBe("iso_explicit");
    const naive = classifyTimeSemantics("2026-01-01 00:00:00");
    expect(naive.kind).toBe("iso_naive");
    expect(naive.assumption).toMatch(/timezone/i);
  });
  it("empty/unknown input reports an honest unknown", () => {
    expect(classifyTimeSemantics(undefined).kind).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// executeAnalysis wiring — frames reach cells; diagnostics surface
// ---------------------------------------------------------------------------

describe("executeAnalysis + frames resolver", () => {
  const anchorSeries = series("1h", 80);
  const htfSeries = series("4h", 30);
  const etfSeries = series("15m", 240);
  const datasets = [htfSeries, anchorSeries, etfSeries];
  const asOf = barCloseTime(anchorSeries.candles[79], "1h");

  const baseDeps = () => {
    const provider = new UploadedDatasetProvider(datasets);
    const assignment = assignMtfRoles(["4h", "1h", "15m"], "1h");
    if (!assignment.ok) throw new Error("unreachable");
    const config = withMtfSet(defaultConfig(), assignment.assignment.set);
    const frames = mtfFrameResolver({
      symbol: "TEST", anchor: "1h", roles: assignment.assignment.roles, datasets,
    });
    return { provider, config, frames };
  };

  const request = { symbols: ["TEST"], timeframe: "1h" as Timeframe, asOf: new Date(asOf).toISOString(), lookbackDays: 3 };

  it("supplied frames arrive on the anchor cell and the run reports zero skips", async () => {
    const deps = baseDeps();
    let captured: BacktestCell[] | undefined;
    const result = await executeAnalysis(request, {
      ...deps,
      run: (input) => { captured = input.cells; return runBacktest(input); },
    });
    const cell = captured?.find((c) => c.symbol === "TEST");
    expect(cell?.frames?.htf?.candles).toHaveLength(30);
    expect(cell?.frames?.etf?.candles).toHaveLength(240);
    expect(cell?.frames?.itf).toBeUndefined();
    expect(result.engineDiagnostics?.mtfFramesSkipped).toBe("");
    expect(result.cells).toHaveLength(1);
  });

  it("no resolver → no frames — baseline behavior is preserved", async () => {
    const provider = new UploadedDatasetProvider([anchorSeries]);
    let captured: BacktestCell[] | undefined;
    await executeAnalysis(request, {
      provider,
      run: (input) => { captured = input.cells; return runBacktest(input); },
    });
    expect(captured?.[0]?.frames).toBeUndefined();
  });

  it("a frame violating the contract is skipped with a diagnostic, never fabricated", async () => {
    const provider = new UploadedDatasetProvider([anchorSeries]);
    const assignment = assignMtfRoles(["4h", "1h"], "1h");
    if (!assignment.ok) throw new Error("unreachable");
    const config = withMtfSet(defaultConfig(), assignment.assignment.set);
    // Supply a frame whose declared timeframe lies about its contents —
    // the engine's own spec-31 contract check must reject it.
    const frames: NonNullable<Parameters<typeof executeAnalysis>[1]["frames"]> = (asset, tf) =>
      asset.symbol === "TEST" && tf === "1h"
        ? { htf: { symbol: "TEST", timeframe: "15m", candles: etfSeries.candles } }
        : undefined;
    const result = await executeAnalysis(request, { provider, config, frames });
    expect(String(result.engineDiagnostics?.mtfFramesSkipped)).toContain("htf");
  });
});
