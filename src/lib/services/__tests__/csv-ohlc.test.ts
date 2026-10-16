/**
 * parseOhlcCsv — deterministic CSV import tests (Phase P2).
 * Every assertion is about honest parsing: what is detected, what is rejected,
 * and what is NEVER silently repaired or fabricated.
 */
import { describe, expect, it } from "vitest";
import {
  detectColumnMapping,
  inferIntervalHint,
  parseOhlcCsv,
} from "../csv-ohlc";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

const isoCsv = (rows: { t: number; o: number; h: number; l: number; c: number; v?: number }[]) =>
  "time,open,high,low,close,volume\n" +
  rows.map((r) => `${new Date(r.t).toISOString()},${r.o},${r.h},${r.l},${r.c},${r.v ?? ""}`).join("\n");

const bars = (n: number, step = DAY) =>
  Array.from({ length: n }, (_, i) => ({
    t: T0 + i * step,
    o: 100 + i,
    h: 102 + i,
    l: 99 + i,
    c: 101 + i,
    v: 1000,
  }));

describe("parseOhlcCsv — happy paths", () => {
  it("parses a standard ISO OHLCV export", () => {
    const out = parseOhlcCsv(isoCsv(bars(5)), { timeframe: "1D" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.dataset.candles).toHaveLength(5);
    expect(out.dataset.candles[0]).toMatchObject({ open: 100, high: 102, low: 99, close: 101 });
    expect(out.stats.duplicates).toBe(0);
    expect(out.stats.gaps).toBe(0);
  });

  it("accepts epoch seconds and milliseconds timestamps", () => {
    const secs = `timestamp,open,high,low,close\n${Math.floor(T0 / 1000)},1,2,0.5,1.5\n${Math.floor(T0 / 1000) + 86400},1,2,0.5,1.5`;
    const out = parseOhlcCsv(secs, { timeframe: "1D" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.dataset.candles[0].time).toBe(T0);
  });

  it("detects semicolon and tab delimiters", () => {
    const semi = "time;open;high;low;close\n2024-01-01T00:00:00Z;1;2;0.5;1.5\n2024-01-02T00:00:00Z;1;2;0.5;1.5";
    const out = parseOhlcCsv(semi, { timeframe: "1D" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.dataset.delimiter).toBe(";");
      expect(out.dataset.candles).toHaveLength(2);
    }
  });

  it("handles headerless positional layouts (time,O,H,L,C,V)", () => {
    const raw = `2024-01-01T00:00:00Z,1,2,0.5,1.5,100\n2024-01-02T00:00:00Z,1,2,0.5,1.5,100`;
    const out = parseOhlcCsv(raw, { timeframe: "1D" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.dataset.candles).toHaveLength(2);
  });

  it("honors an explicit column mapping over detection", () => {
    const csv = "symbol,close,time,open,high,low\nX,101,2024-01-01T00:00:00Z,100,102,99\nX,102,2024-01-02T00:00:00Z,101,103,100";
    const out = parseOhlcCsv(csv, {
      timeframe: "1D",
      mapping: { time: 2, open: 3, high: 4, low: 5, close: 1 },
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.dataset.candles[0].close).toBe(101);
  });
});

describe("parseOhlcCsv — honest rejection", () => {
  it("rejects an empty file", () => {
    const out = parseOhlcCsv("   \n  \n");
    expect(out.ok).toBe(false);
  });

  it("rejects files whose columns cannot be identified, with the header names listed", () => {
    const out = parseOhlcCsv("foo,bar,baz\n1,2,3");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("foo");
  });

  it("rejects when every data row is malformed", () => {
    const out = parseOhlcCsv("time,open,high,low,close\nx,y,z,w,v\na,b,c,d,e");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("malformed");
  });

  it("flags malformed rows with line numbers — never silently dropped", () => {
    const csv = isoCsv(bars(3)) + `\nnot-a-date,1,2,0.5,1.5,100`;
    const out = parseOhlcCsv(csv, { timeframe: "1D" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.dataset.candles).toHaveLength(3);
    expect(out.issues.some((i) => i.row === 5)).toBe(true);
  });

  it("surfaces duplicate timestamps via canonical validation", () => {
    const rows = bars(3);
    rows.push({ ...rows[1] });
    const out = parseOhlcCsv(isoCsv(rows), { timeframe: "1D" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.stats.duplicates).toBe(1);
      expect(out.validationIssues.some((i) => i.code === "duplicate_timestamp")).toBe(true);
    }
  });

  it("surfaces out-of-order bars", () => {
    const rows = bars(4);
    [rows[1], rows[2]] = [rows[2], rows[1]];
    const out = parseOhlcCsv(isoCsv(rows), { timeframe: "1D" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.stats.outOfOrder).toBeGreaterThan(0);
  });

  it("surfaces invalid OHLC envelopes (high < low)", () => {
    const csv = isoCsv([
      { t: T0, o: 100, h: 90, l: 95, c: 99 }, // high below open/close — impossible
      { t: T0 + DAY, o: 100, h: 102, l: 99, c: 101 },
    ]);
    const out = parseOhlcCsv(csv, { timeframe: "1D" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.stats.invalidBars).toBe(1);
      expect(out.validationIssues.some((i) => i.code === "invalid_ohlc_relationship")).toBe(true);
    }
  });

  it("counts missing intervals as gaps — weekend gaps are expected on weekday calendars", () => {
    // Friday → Monday skip: expected closure on a weekday calendar.
    const fri = Date.UTC(2024, 0, 5); // Friday
    const mon = Date.UTC(2024, 0, 8); // Monday
    const csv = isoCsv([
      { t: fri, o: 1, h: 2, l: 0.5, c: 1.5 },
      { t: mon, o: 1, h: 2, l: 0.5, c: 1.5 },
    ]);
    const out = parseOhlcCsv(csv, { timeframe: "1D", is24x7: false });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.stats.gaps).toBe(1);
      expect(out.validationIssues.some((i) => i.code === "gap_expected")).toBe(true);
    }
  });
});

describe("detectColumnMapping + inferIntervalHint", () => {
  it("maps common header variants", () => {
    expect(detectColumnMapping(["Date", "Open", "High", "Low", "Close", "Volume"]))
      .toMatchObject({ time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 });
    expect(detectColumnMapping(["timestamp", "o", "h", "l", "c"]))
      .toMatchObject({ time: 0, open: 1, high: 2, low: 3, close: 4 });
  });

  it("returns undefined when required columns are absent", () => {
    expect(detectColumnMapping(["time", "open", "high"])).toBeUndefined();
  });

  it("infers the dominant inter-bar interval", () => {
    const out = parseOhlcCsv(isoCsv(bars(6, 3_600_000)), {});
    expect(out.ok).toBe(true);
    if (out.ok) expect(inferIntervalHint(out.dataset.candles)).toBe(3_600_000);
  });
});
