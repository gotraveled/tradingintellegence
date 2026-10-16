/**
 * UploadedDatasetProvider — provenance + contract tests (Phase P2).
 * The provider must behave exactly like any HistoricalDataProvider while
 * carrying honest provenance: file-kind source, always-historical, no vendor path.
 */
import { describe, expect, it } from "vitest";
import { UploadedDatasetProvider, toUploadedSeries } from "../uploaded-provider";
import type { AssetIdentifier } from "@/lib/types";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

const asset: AssetIdentifier = { symbol: "MYSTOCK" };

const makeCandles = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    time: T0 + i * DAY,
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 101 + i,
    volume: 1000,
  }));

const provider = (candles = makeCandles(10)) =>
  new UploadedDatasetProvider([
    toUploadedSeries({ symbol: "MYSTOCK", timeframe: "1D", candles, is24x7: false }),
  ]);

describe("UploadedDatasetProvider", () => {
  it("declares file-kind source — the upload is never a vendor feed", () => {
    const p = provider();
    expect(p.source.kind).toBe("file");
    expect(p.source.id).toBe("uploaded-csv");
  });

  it("supports only registered symbol+timeframe pairs", () => {
    const p = provider();
    expect(p.supports({ asset, timeframe: "1D", start: T0, end: T0 + DAY })).toBe(true);
    expect(p.supports({ asset, timeframe: "1h", start: T0, end: T0 + DAY })).toBe(false);
    expect(p.supports({ asset: { symbol: "OTHER" }, timeframe: "1D", start: T0, end: T0 + DAY })).toBe(false);
  });

  it("serves in-range candles with historical classification and a real quality report", async () => {
    const p = provider();
    const res = await p.getCandles({ asset, timeframe: "1D", start: T0 + 2 * DAY, end: T0 + 7 * DAY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.candles).toHaveLength(5);
    expect(res.result.classification).toBe("historical");
    expect(res.result.quality.status).toBe("valid");
    expect(res.result.warnings?.some((w) => w.includes("user-uploaded"))).toBe(true);
  });

  it("returns data_not_available — never empty bars — outside the dataset", async () => {
    const p = provider();
    const res = await p.getCandles({ asset, timeframe: "1D", start: T0 + 100 * DAY, end: T0 + 200 * DAY });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("data_not_available");
  });

  it("returns unsupported_symbol for unregistered requests", async () => {
    const p = provider();
    const res = await p.getCandles({ asset: { symbol: "NOPE" }, timeframe: "1D", start: T0, end: T0 + DAY });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unsupported_symbol");
  });

  it("gap classification follows the declared calendar — weekday vs 24/7", async () => {
    // Friday→Monday hole in the middle of the dataset.
    const candles = [
      { time: Date.UTC(2024, 0, 4), open: 1, high: 2, low: 0.5, close: 1.5 }, // Thu
      { time: Date.UTC(2024, 0, 5), open: 1, high: 2, low: 0.5, close: 1.5 }, // Fri
      { time: Date.UTC(2024, 0, 8), open: 1, high: 2, low: 0.5, close: 1.5 }, // Mon
    ];
    const weekday = new UploadedDatasetProvider([
      toUploadedSeries({ symbol: "MYSTOCK", timeframe: "1D", candles, is24x7: false }),
    ]);
    const crypto = new UploadedDatasetProvider([
      toUploadedSeries({ symbol: "MYSTOCK", timeframe: "1D", candles, is24x7: true }),
    ]);
    const req = { asset, timeframe: "1D" as const, start: 0, end: Number.MAX_SAFE_INTEGER };
    const w = await weekday.getCandles(req);
    const c = await crypto.getCandles(req);
    expect(w.ok && c.ok).toBe(true);
    if (w.ok && c.ok) {
      // Weekday calendar: Sat/Sun hole is expected. 24/7: it's a real gap.
      expect(w.result.quality.gaps[0]?.kind).toBe("expected");
      expect(c.result.quality.gaps[0]?.kind).toBe("unexpected");
    }
  });
});
