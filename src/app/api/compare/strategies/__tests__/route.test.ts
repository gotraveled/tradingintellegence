/**
 * Server-boundary tests for POST /api/compare/strategies (comp-v1).
 *
 * The route owns: shared-protocol validation, strategy resolution (preset id
 * or inline engineConfig snapshot), and delegating upload provenance to the
 * shared parseUploadForm pipeline. These tests cover the acceptance criteria
 * the service cannot see — malformed multipart inputs, unsupported strategy
 * types, incompatible selections, and rejection (never approximation) of
 * strategy definitions the engine cannot evaluate fairly.
 */
import { describe, expect, it, vi } from "vitest";

// Route tests run full engine pipelines (canonical detection, not stubs) —
// the 5s default flakes under parallel fork contention. Same convention as
// src/lib/engines/__tests__/mtf-composition.test.ts.
vi.setConfig({ testTimeout: 30_000 });
import { POST } from "../route";

const EPOCH = Date.UTC(2026, 0, 1);
const MIN = 60_000;

function csv(n: number): string {
  const rows: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const p = 100 + i * 0.5;
    rows.push(`${EPOCH + i * MIN},${p},${p + 0.4},${p - 0.6},${p + 0.2},1000`);
  }
  return ["time,open,high,low,close,volume", ...rows].join("\n");
}

async function post(opts: {
  strategies?: string;
  config?: string;
  files?: { name: string; text: string; timeframe?: string }[];
}): Promise<Response> {
  const files = opts.files ?? [{ name: "a.csv", text: csv(60), timeframe: "1m" }];
  const form = new FormData();
  for (const f of files) form.append("files", new File([f.text], f.name, { type: "text/csv" }));
  form.set("meta", JSON.stringify(files.map((f) => ({ timeframe: f.timeframe }))));
  form.set("symbol", "SYN");
  form.set("anchor", "1m");
  if (opts.config !== undefined) form.set("config", opts.config);
  if (opts.strategies !== undefined) form.set("strategies", opts.strategies);
  return POST(new Request("http://localhost/api/compare/strategies", {
    method: "POST",
    body: form,
  }));
}

const CFG = JSON.stringify({ horizonBars: 5 });
const TWO = JSON.stringify([{ id: "a", preset: "baseline" }, { id: "b", preset: "high-conviction" }]);

describe("compare/strategies route — request validation", () => {
  it("rejects shared selection fields — minScore belongs to per-strategy selection", async () => {
    const res = await post({
      config: JSON.stringify({ horizonBars: 5, minScore: 50 }),
      strategies: TWO,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/per-strategy/i);
  });

  it("rejects unsupported preset names with the supported list", async () => {
    const res = await post({
      config: CFG,
      strategies: JSON.stringify([{ id: "a", preset: "baseline" }, { id: "b", preset: "magic" }]),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/magic/);
    expect(body.error.message).toMatch(/baseline/);
  });

  it("rejects strategy entries with neither preset nor engineConfig — unsupported, not approximated", async () => {
    const res = await post({
      config: CFG,
      strategies: JSON.stringify([{ id: "a", preset: "baseline" }, { id: "rulebuilder", rules: [] }]),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/unsupported/i);
  });

  it("rejects identical frozen snapshots — a no-op is not a comparison", async () => {
    const res = await post({
      config: CFG,
      strategies: JSON.stringify([{ id: "a", preset: "baseline" }, { id: "b", preset: "baseline" }]),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/identical/i);
  });

  it("rejects malformed strategy JSON and missing config", async () => {
    expect((await post({ config: CFG, strategies: "{nope" })).status).toBe(400);
    expect((await post({ strategies: TWO })).status).toBe(400);
  });

  it("two presets on one dataset → 200 with rows, fingerprint, and test-cohort honesty", async () => {
    const res = await post({ config: CFG, strategies: TWO });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      result: {
        fingerprint: string;
        strategies: { id: string; row: { scenarioCount: number } }[];
        testCohort: { enforceable: boolean };
        fairness: string[];
      };
    };
    expect(body.result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(body.result.strategies.map((s) => s.id)).toEqual(["a", "b"]);
    expect(body.result.testCohort.enforceable).toBe(false);
    expect(body.result.fairness.length).toBeGreaterThan(0);
  });

  it("upload integrity gate still applies — duplicate timestamps → 422", async () => {
    const bad = csv(30).split("\n");
    bad.push(bad[5]); // duplicate a timestamp row
    const res = await post({
      config: CFG,
      strategies: TWO,
      files: [{ name: "dup.csv", text: bad.join("\n"), timeframe: "1m" }],
    });
    expect(res.status).toBe(422);
  });
});
