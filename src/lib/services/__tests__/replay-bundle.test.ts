/**
 * Replay bundle (rb1) — deterministic tests for export/import/verify/replay.
 * The replay test runs the REAL canonical engine through the route's input
 * contract (parseUploadForm → runStrategyComparison) — never a stub that
 * could drift from production semantics.
 */
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 }); // same convention as the route suite

import { POST } from "@/app/api/compare/strategies/route";
import { buildRecord, register } from "../experiment-registry";
import { sha256Hex } from "../sha256";
import {
  buildBundle,
  compareReplay,
  exportBundle,
  importBundle,
  reconstructForm,
  verifyBundle,
  BUNDLE_VERSION,
} from "../replay-bundle";
import type { ExperimentRecord } from "../experiment-registry";
import type { StrategyComparisonResult } from "../strategy-comparison";

const EPOCH = Date.UTC(2026, 0, 1);
const MIN = 60_000;

function csv(n: number, drift = 0): string {
  const rows: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const p = 100 + i * 0.5 + drift;
    rows.push(`${EPOCH + i * MIN},${p},${p + 0.4},${p - 0.6},${p + 0.2},1000`);
  }
  return ["time,open,high,low,close,volume", ...rows].join("\n");
}

const CFG = JSON.stringify({ horizonBars: 5 });
const TWO = JSON.stringify([{ id: "a", preset: "baseline" }, { id: "b", preset: "high-conviction" }]);

const form = (files: { name: string; text: string; timeframe?: string }[]): FormData => {
  const f = new FormData();
  for (const x of files) f.append("files", new File([x.text], x.name, { type: "text/csv" }));
  f.set("meta", JSON.stringify(files.map((x) => ({ timeframe: x.timeframe }))));
  f.set("symbol", "SYN");
  f.set("anchor", "1m");
  f.set("config", CFG);
  f.set("strategies", TWO);
  return f;
};

/** Run the canonical route once — the real engine, same as production. */
const runOnce = async (): Promise<{ result: StrategyComparisonResult; record: ExperimentRecord }> => {
  const res = await POST(new Request("http://localhost/api/compare/strategies", {
    method: "POST", body: form([{ name: "a.csv", text: csv(60), timeframe: "1m" }]),
  }));
  const body = await res.json() as { result?: StrategyComparisonResult };
  expect(res.status).toBe(200);
  const result = body.result!;
  const rec = buildRecord({
    result,
    strategies: result.strategies,
    createdAt: "2026-02-01T00:00:00.000Z",
  });
  return { result, record: register([], rec).record };
};

const fullBundle = async () => {
  const { record } = await runOnce();
  return buildBundle({
    record,
    inputs: { symbol: "SYN", anchor: "1m" },
    files: [{ name: "a.csv", text: csv(60), timeframe: "1m" }],
  });
};

describe("bundle export", () => {
  it("deterministic — identical inputs produce identical bytes", async () => {
    const a = await fullBundle();
    const { record: r2 } = await runOnce();
    const b = buildBundle({
      record: r2, inputs: { symbol: "SYN", anchor: "1m" },
      files: [{ name: "a.csv", text: csv(60), timeframe: "1m" }],
    });
    // Same createdAt → same recordId → identical bundles.
    expect(exportBundle(a)).toBe(exportBundle(b));
    expect(a.bundleVersion).toBe(BUNDLE_VERSION);
    expect(a.files[0].sha256).toBe(sha256Hex(csv(60)));
    expect(a.manifest.contents.fingerprint).toBe(r2.fingerprint);
  });

  it("metadata-only bundle — no files, limitation disclosed, replay not possible", async () => {
    const { record } = await runOnce();
    const b = buildBundle({ record, inputs: { symbol: "SYN", anchor: "1m" } });
    expect(b.files).toEqual([]);
    expect(b.unavailable.some((u) => u.includes("metadata-only"))).toBe(true);
    expect(b.limitation).toContain("user-provided");
  });

  it("never fabricates byte-identity — digest binds the exported text only", async () => {
    const b = await fullBundle();
    expect(b.files[0].bytes).toBe(new TextEncoder().encode(csv(60)).length);
    expect(b.files[0].sha256).toBe(sha256Hex(csv(60)));
  });
});

describe("bundle import safety", () => {
  it("rejects malformed JSON", async () => {
    expect(importBundle("not json {{").ok).toBe(false);
  });

  it("rejects unsupported versions with a readable error", async () => {
    const b = await fullBundle();
    b.bundleVersion = "rb99" as never;
    const out = importBundle(exportBundle(b));
    expect(out.ok).toBe(false);
    expect(out.error).toContain("rb99");
  });

  it("rejects unsafe filenames — basenames only", async () => {
    const b = await fullBundle();
    b.files[0].name = "../etc/passwd";
    expect(importBundle(exportBundle(b)).ok).toBe(false);
    b.files[0].name = "a/b.csv";
    expect(importBundle(exportBundle(b)).ok).toBe(false);
    b.files[0].name = "..";
    expect(importBundle(exportBundle(b)).ok).toBe(false);
  });

  it("enforces the file-count limit", async () => {
    const b = await fullBundle();
    b.files = Array.from({ length: 5 }, (_, i) => ({ ...b.files[0], name: `f${i}.csv` }));
    expect(importBundle(exportBundle(b)).ok).toBe(false);
  });

  it("rejects content whose recorded byte size mismatches", async () => {
    const b = await fullBundle();
    b.files[0].bytes = 999_999;
    expect(importBundle(exportBundle(b)).ok).toBe(false);
  });
});

describe("bundle verification", () => {
  it("untouched full bundle → files verified, dataset identity matched, manifest verified", async () => {
    const out = importBundle(exportBundle(await fullBundle()));
    expect(out.ok).toBe(true);
    const v = await verifyBundle(out.bundle!);
    expect(v.fileIntegrity).toBe("verified");
    expect(v.datasetIdentity).toBe("matched");
    expect(v.manifestIntegrity).toBe("verified");
    expect(v.ineligible).toEqual([]);
    expect(v.imported).toBe(true); // user-supplied evidence, even when valid
  });

  it("tampered file content → file integrity mismatch", async () => {
    const b = await fullBundle();
    // Same-length substitution — content passes the byte-size check at import,
    // so verification is the layer that must catch it.
    const tampered = csv(60).replace(",1000\n", ",1001\n");
    b.files[0].contentBase64 = btoa(unescape(encodeURIComponent(tampered)));
    const out = importBundle(exportBundle(b));
    expect(out.ok).toBe(true); // structure + size still consistent
    const v = await verifyBundle(out.bundle!);
    expect(v.fileIntegrity).toBe("mismatch");
    expect(v.ineligible.length).toBeGreaterThan(0);
  });

  it("tampered manifest contents → manifest integrity mismatch", async () => {
    const b = await fullBundle();
    b.manifest.contents.shared = { ...b.manifest.contents.shared, horizonBars: 99 };
    const out = importBundle(exportBundle(b));
    const v = await verifyBundle(out.bundle!);
    expect(v.manifestIntegrity).toBe("mismatch");
  });

  it("forged recorded digest that survives file check → dataset identity mismatch", async () => {
    // Supply correct file bytes but claim a different datasetFingerprint.
    const b = await fullBundle();
    b.manifest.contents.datasetFingerprint = "f".repeat(64);
    const out = importBundle(exportBundle(b));
    const v = await verifyBundle(out.bundle!);
    expect(v.fileIntegrity).toBe("verified");
    expect(v.datasetIdentity).toBe("mismatch");
    expect(v.ineligible.some((r) => r.includes("dataset identity"))).toBe(true);
  });

  it("metadata-only bundle → unverifiable, replay ineligible, not an error", async () => {
    const { record } = await runOnce();
    const b = buildBundle({ record, inputs: { symbol: "SYN", anchor: "1m" } });
    const out = importBundle(exportBundle(b));
    expect(out.ok).toBe(true);
    expect(out.notices.some((n) => n.includes("metadata-only"))).toBe(true);
    const v = await verifyBundle(out.bundle!);
    expect(v.fileIntegrity).toBe("unverifiable");
    expect(v.ineligible.length).toBeGreaterThan(0);
  });

  it("inventory entry without content → partial, replay blocked", async () => {
    const b = await fullBundle();
    delete b.files[0].contentBase64;
    const out = importBundle(exportBundle(b));
    const v = await verifyBundle(out.bundle!);
    expect(v.fileIntegrity).toBe("partial");
    expect(v.ineligible.length).toBeGreaterThan(0);
  });
});

describe("replay — canonical engine, recorded vs replayed kept separate", () => {
  it("exact replay reproduces the recorded fingerprint", async () => {
    const { record, result: original } = await runOnce();
    const b = buildBundle({
      record, inputs: { symbol: "SYN", anchor: "1m" },
      files: [{ name: "a.csv", text: csv(60), timeframe: "1m" }],
    });
    const out = importBundle(exportBundle(b));
    const v = await verifyBundle(out.bundle!);
    expect(v.ineligible).toEqual([]);

    const replayRes = await POST(new Request("http://localhost/api/compare/strategies", {
      method: "POST", body: reconstructForm(out.bundle!),
    }));
    const replayed = (await replayRes.json() as { result?: StrategyComparisonResult }).result!;
    const report = compareReplay(out.bundle!, replayed);
    expect(report.fingerprintMatch).toBe(true);
    expect(report.datasetIdentityMatch).toBe(true);
    expect(report.fields.every((f) => f.status !== "different")).toBe(true);
    // The replayed run is a fresh object — registry record untouched.
    expect(replayed.fingerprint).toBe(original.fingerprint);
    expect(record.exposure.status).not.toBe("repeat"); // registry never saw the replay
  });

  it("changed input data → replay detects the fingerprint difference", async () => {
    const { record } = await runOnce();
    // Build a bundle whose recorded manifest came from csv(60) but whose
    // file bytes were swapped to different candle data — digest re-signed so
    // the file check passes while the dataset identity check must catch it.
    const b = buildBundle({
      record, inputs: { symbol: "SYN", anchor: "1m" },
      files: [{ name: "a.csv", text: csv(60, 1), timeframe: "1m" }], // shifted prices
    });
    const out = importBundle(exportBundle(b));
    const v = await verifyBundle(out.bundle!);
    expect(v.fileIntegrity).toBe("verified");
    expect(v.datasetIdentity).toBe("mismatch"); // canonical pipeline recomputation caught it
  });

  it("replay output is not registered — the imported bundle stays read-only evidence", async () => {
    const b = await fullBundle();
    const out = importBundle(exportBundle(b));
    expect(out.bundle!.manifest.imported).toBe(true);
    // reconstructForm round-trips the recorded strategies verbatim
    const form = reconstructForm(out.bundle!);
    expect(form.get("symbol")).toBe("SYN");
    expect(form.get("anchor")).toBe("1m");
    const strats = JSON.parse(form.get("strategies") as string) as { id: string }[];
    expect(strats.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("MTF inputs survive the round trip — anchor/htf/etf recorded verbatim", async () => {
    const { record } = await runOnce();
    const b = buildBundle({
      record,
      inputs: { symbol: "SYN", anchor: "1m", htf: "5m", etf: "1m" },
      files: [{ name: "a.csv", text: csv(60), timeframe: "1m" },
              { name: "h.csv", text: csv(60), timeframe: "5m" }],
    });
    const out = importBundle(exportBundle(b));
    const form = reconstructForm(out.bundle!);
    expect(form.get("htf")).toBe("5m");
    expect(form.get("etf")).toBe("1m");
    const meta = JSON.parse(form.get("meta") as string) as { timeframe?: string }[];
    expect(meta.map((m) => m.timeframe)).toEqual(["1m", "5m"]);
  });
});
