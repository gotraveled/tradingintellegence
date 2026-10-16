/**
 * Server-boundary tests for POST /api/import/mtf-analysis (Phase P3).
 *
 * The route owns: multi-file intake, per-file canonical CSV validation,
 * one-instrument enforcement, spec-10 role assignment, and the anchor default
 * (the last moment every dataset is fully closed). Causal joining stays inside
 * the engine; these tests verify the route never lets an invalid or ambiguous
 * combination reach it.
 */
import { describe, expect, it } from "vitest";
import { POST } from "../route";
import type { Timeframe } from "@/lib/types";

const EPOCH = Date.UTC(2026, 0, 1);
const TF_MS: Record<string, number> = {
  "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1D": 86_400_000,
};

function csv(tf: Timeframe, n: number, opts: { start?: number; iso?: boolean; gap?: number[] } = {}): string {
  const step = TF_MS[tf];
  const start = opts.start ?? EPOCH;
  const gapSet = new Set(opts.gap ?? []);
  const rows: string[] = [];
  let k = 0;
  for (let i = 0; i < n + gapSet.size; i += 1) {
    if (gapSet.has(i)) continue;
    const t = start + i * step;
    const ts = opts.iso ? new Date(t).toISOString() : String(t);
    const p = 100 + k * 0.5;
    rows.push(`${ts},${p},${p + 0.4},${p - 0.6},${p + 0.2},1000`);
    k += 1;
  }
  return ["time,open,high,low,close,volume", ...rows].join("\n");
}

interface MtfFile {
  name: string;
  text: string;
  meta?: { symbol?: string; timeframe?: string; is24x7?: boolean };
}

async function post(opts: {
  files: MtfFile[];
  symbol?: string;
  anchor?: string;
  asOf?: string;
  htf?: string;
  etf?: string;
}): Promise<Response> {
  const form = new FormData();
  for (const f of opts.files) {
    form.append("files", new File([f.text], f.name, { type: "text/csv" }));
  }
  form.set("meta", JSON.stringify(opts.files.map((f) => f.meta ?? {})));
  if (opts.symbol !== undefined) form.set("symbol", opts.symbol);
  if (opts.anchor !== undefined) form.set("anchor", opts.anchor);
  if (opts.asOf !== undefined) form.set("asOf", opts.asOf);
  if (opts.htf !== undefined) form.set("htf", opts.htf);
  if (opts.etf !== undefined) form.set("etf", opts.etf);
  return POST(new Request("http://localhost/api/import/mtf-analysis", {
    method: "POST",
    body: form,
  }));
}

const HAPPY: MtfFile[] = [
  { name: "d4h.csv", text: csv("4h", 40), meta: { timeframe: "4h" } },
  { name: "d1h.csv", text: csv("1h", 100), meta: { timeframe: "1h" } },
  { name: "d15m.csv", text: csv("15m", 300), meta: { timeframe: "15m" } },
];

describe("POST /api/import/mtf-analysis", () => {
  it("three valid datasets → causal MTF run with role/frame report", async () => {
    const res = await post({ files: HAPPY, symbol: "TEST", anchor: "1h" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mtf.roles).toEqual({ htf: "4h", itf: "1h", etf: "15m" });
    expect(body.mtf.unusedTimeframes).toEqual([]);
    expect(body.mtf.frames).toHaveLength(3);
    const states = Object.fromEntries(body.mtf.frames.map((f: { timeframe: string; state: string }) => [f.timeframe, f.state]));
    expect(states["4h"]).toBe("usable");
    expect(states["1h"]).toBe("serves-cell");
    expect(states["15m"]).toBe("usable");
    expect(body.result.cells).toHaveLength(1);
    expect(body.result.dataSource.kind).toBe("file");
    expect(String(body.result.engineDiagnostics?.mtfFramesSkipped)).toBe("");
    expect(body.provenance).toMatch(/user-uploaded/);
  });

  it("default anchor = last moment every dataset is fully closed — never an unfinished bar", async () => {
    // The 15m dataset's last close (75h) is the binding end of the common
    // window — the anchor is the last 1h bar closed at 75h, so only 4h bars
    // closed ≤75h are visible (bar 17, closing at 72h; bar 18 closes at 76h).
    const res = await post({ files: HAPPY, symbol: "TEST", anchor: "1h" });
    const body = await res.json();
    const anchorClose = Date.parse(body.mtf.anchorCloseIso);
    const h4 = body.mtf.frames.find((f: { timeframe: string }) => f.timeframe === "4h");
    expect(anchorClose).toBe(EPOCH + 75 * TF_MS["1h"]);
    expect(h4.closedIndexAtAnchor).toBe(17);
  });

  it("asOf inside a forming htf bar → that bar contributes nothing", async () => {
    // Anchor at 74h: 1h bar 73 closes exactly at the anchor; the 4h bar that
    // opened at 72h closes at 76h — AFTER the anchor — so it must not be
    // visible. Only 4h bar 17 (closed at 72h) contributes.
    const asOf = new Date(EPOCH + 74 * TF_MS["1h"]).toISOString();
    const res = await post({ files: HAPPY, symbol: "TEST", anchor: "1h", asOf });
    expect(res.status).toBe(200);
    const body = await res.json();
    const h4 = body.mtf.frames.find((f: { timeframe: string }) => f.timeframe === "4h");
    expect(h4.closedIndexAtAnchor).toBe(17);
  });

  it("rejects a per-file symbol that disagrees with the run symbol — never merges instruments", async () => {
    const files = [
      { name: "a.csv", text: csv("4h", 40), meta: { timeframe: "4h", symbol: "OTHER" } },
      { name: "b.csv", text: csv("1h", 100), meta: { timeframe: "1h" } },
    ];
    const res = await post({ files, symbol: "TEST", anchor: "1h" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/different instruments/i);
  });

  it("rejects duplicate timeframe uploads", async () => {
    const files = [
      { name: "a.csv", text: csv("1h", 60), meta: { timeframe: "1h" } },
      { name: "b.csv", text: csv("1h", 80, { start: EPOCH + 10 }), meta: { timeframe: "1h" } },
    ];
    const res = await post({ files, symbol: "TEST", anchor: "1h" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/duplicate timeframe/i);
  });

  it("rejects an anchor that is not an uploaded timeframe", async () => {
    const res = await post({ files: HAPPY.slice(0, 2), symbol: "TEST", anchor: "15m" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/uploaded timeframes/);
  });

  it("rejects non-overlapping datasets — there is no causal anchor moment", async () => {
    const files = [
      { name: "a.csv", text: csv("1h", 40), meta: { timeframe: "1h" } },
      { name: "b.csv", text: csv("4h", 20, { start: EPOCH + 500 * TF_MS["1h"] }), meta: { timeframe: "4h" } },
    ];
    const res = await post({ files, symbol: "TEST", anchor: "1h" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/do not overlap/i);
  });

  it("rejects an anchor timestamp before the anchor dataset's first closed bar", async () => {
    const res = await post({
      files: HAPPY.slice(0, 2),
      symbol: "TEST",
      anchor: "4h",
      asOf: new Date(EPOCH - 1000).toISOString(),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/no 4h bar is fully closed/i);
  });

  it("a frame starting after the anchor reports no-closed-bar — context, not a vote", async () => {
    // Anchor on the 1h dataset mid-history; the 15m dataset begins after it.
    const files = [
      { name: "b.csv", text: csv("15m", 200, { start: EPOCH + 80 * TF_MS["1h"] }), meta: { timeframe: "15m" } },
      { name: "a.csv", text: csv("1h", 100), meta: { timeframe: "1h" } },
    ];
    const res = await post({
      files,
      symbol: "TEST",
      anchor: "1h",
      asOf: new Date(EPOCH + 60 * TF_MS["1h"]).toISOString(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const m15 = body.mtf.frames.find((f: { timeframe: string }) => f.timeframe === "15m");
    expect(m15.state).toBe("no-closed-bar");
    expect(m15.closedIndexAtAnchor).toBe(-1);
    expect(body.mtf.warnings.join(" ")).toMatch(/vote-0/);
  });

  it("ambiguous interval → explicit timeframe required, never guessed", async () => {
    // 45-minute spacing maps to no canonical timeframe.
    const step = 45 * 60_000;
    const rows = Array.from({ length: 40 }, (_, i) => {
      const p = 100 + i;
      return `${EPOCH + i * step},${p},${p + 1},${p - 1},${p},1000`;
    });
    const files = [
      { name: "a.csv", text: csv("1h", 60), meta: { timeframe: "1h" } },
      { name: "odd.csv", text: ["time,open,high,low,close,volume", ...rows].join("\n") },
    ];
    const res = await post({ files, symbol: "TEST", anchor: "1h" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/timeframe is required/i);
  });

  it("naive timestamps surface a timezone assumption warning", async () => {
    const files = [
      { name: "a.csv", text: csv("4h", 40), meta: { timeframe: "4h" } },
      { name: "b.csv", text: csv("1h", 100, { iso: true }), meta: { timeframe: "1h" } },
    ];
    const res = await post({ files, symbol: "TEST", anchor: "1h" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mtf.timeSemantics["b.csv"]).toMatch(/explicit UTC offset/i);
    // CSV cell times are epoch ms — classified, never ambiguous.
    expect(body.mtf.timeSemantics["a.csv"]).toMatch(/epoch milliseconds/i);
  });

  it("dataset gaps are reported per file — never repaired", async () => {
    const files = [
      { name: "a.csv", text: csv("4h", 40, { gap: [10, 11, 12] }), meta: { timeframe: "4h", is24x7: true } },
      { name: "b.csv", text: csv("1h", 100), meta: { timeframe: "1h", is24x7: true } },
    ];
    const res = await post({ files, symbol: "TEST", anchor: "1h" });
    expect(res.status).toBe(200);
    const body = await res.json();
    const a = body.datasets.find((d: { fileName: string }) => d.fileName === "a.csv");
    expect(a.stats.gaps).toBeGreaterThan(0);
    // gap:[10,11,12] produces 40 rows spanning 43 slots — three absent bars
    // reported as one gap stretch, never backfilled.
    expect(a.rowCount).toBe(40);
  });

  it("malformed inputs are rejected before any parsing", async () => {
    expect((await post({ files: [HAPPY[0]], symbol: "T", anchor: "1h" })).status).toBe(400);
    expect((await post({ files: HAPPY, anchor: "1h" })).status).toBe(400); // no symbol
    expect((await post({ files: HAPPY, symbol: "T" })).status).toBe(400); // no anchor
    expect((await post({ files: HAPPY, symbol: "T", anchor: "7h" })).status).toBe(400);
  });

  it("a corrupt file reports its own failure — other files unaffected in the error payload", async () => {
    const files = [
      { name: "bad.csv", text: "time,open,high,low,close\n1,2,3,4,5\n2,3,4,5,6", meta: { timeframe: "4h" } },
      { name: "ok.csv", text: csv("1h", 60), meta: { timeframe: "1h" } },
    ];
    const res = await post({ files, symbol: "TEST", anchor: "1h" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.file).toBe("bad.csv");
  });
});
