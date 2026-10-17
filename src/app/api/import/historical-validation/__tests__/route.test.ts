/**
 * Server-boundary integrity tests for POST /api/import/historical-validation.
 *
 * Regression coverage for the sign-off audit: error-severity spec-4 series
 * findings (duplicate/out-of-order/overlapping timestamps, invalid OHLC) must
 * REJECT the file — the engine's closedIndexAt join and bar indexing require
 * ascending unique timestamps, and spec-4 forbids silently repairing or
 * silently using corrupt ordering. Warning-severity findings (gaps, alignment
 * hints) are disclosed but never block.
 */
import { describe, expect, it } from "vitest";
import { POST } from "../route";

const EPOCH = Date.UTC(2026, 0, 1);
const MIN = 60_000;

/** 1m CSV — `reorder` mutates row order, `dup` appends a repeated timestamp. */
function csv(n: number, opts: { reversed?: boolean; dupAt?: number; gapAt?: number } = {}): string {
  const rows: string[] = [];
  for (let i = 0; i < n; i += 1) {
    if (opts.gapAt !== undefined && i === opts.gapAt) continue; // missing bar
    const p = 100 + i * 0.5;
    rows.push(`${EPOCH + i * MIN},${p},${p + 0.4},${p - 0.6},${p + 0.2},1000`);
  }
  if (opts.dupAt !== undefined) rows.push(rows[opts.dupAt]);
  if (opts.reversed) rows.reverse();
  return ["time,open,high,low,close,volume", ...rows].join("\n");
}

async function post(files: { name: string; text: string; timeframe?: string }[]): Promise<Response> {
  const form = new FormData();
  for (const f of files) form.append("files", new File([f.text], f.name, { type: "text/csv" }));
  form.set("meta", JSON.stringify(files.map((f) => ({ timeframe: f.timeframe }))));
  form.set("symbol", "SYN");
  form.set("anchor", "1m");
  form.set("config", JSON.stringify({ horizonBars: 5 }));
  return POST(new Request("http://localhost/api/import/historical-validation", {
    method: "POST",
    body: form, // Request assigns multipart/form-data with the correct boundary
  }));
}

describe("historical-validation route — data integrity gate", () => {
  it("rejects duplicate timestamps (422) — never evaluates ambiguous bars", async () => {
    const res = await post([{ name: "dup.csv", text: csv(30, { dupAt: 5 }), timeframe: "1m" }]);
    expect(res.status).toBe(422);
    const body = await res.json() as { error: { message: string }; issues?: { message: string }[] };
    expect(body.error.message).toMatch(/integrity error/i);
    expect(body.issues?.some((i) => /duplicate/i.test(i.message))).toBe(true);
  });

  it("rejects out-of-order exports (422) — descending files break the sorted-bar precondition", async () => {
    const res = await post([{ name: "desc.csv", text: csv(30, { reversed: true }), timeframe: "1m" }]);
    expect(res.status).toBe(422);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/integrity error/i);
  });

  it("rejects duplicate timeframe uploads — one dataset per timeframe, never merged", async () => {
    const res = await post([
      { name: "a.csv", text: csv(30), timeframe: "1m" },
      { name: "b.csv", text: csv(30, { gapAt: 10 }), timeframe: "1m" },
    ]);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/duplicate/i);
  });

  it("warning-severity findings (gaps) are disclosed but never block the run", async () => {
    const res = await post([{ name: "gapped.csv", text: csv(30, { gapAt: 10 }), timeframe: "1m" }]);
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { warnings: string[] } };
    expect(body.result.warnings.some((w) => /gapped\.csv/i.test(w))).toBe(true);
  });
});
