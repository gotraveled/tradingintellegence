/**
 * V1.2 service tests — original-byte fidelity, legacy ia1 records, and
 * full anchor+HTF+ETF replay through the canonical route.
 */
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

import { POST } from "@/app/api/compare/strategies/route";
import { buildRecord, register, type ExperimentRecord } from "../experiment-registry";
import { parseUploadForm } from "../csv-upload";
import { sha256BytesHex, sha256Hex } from "../sha256";
import {
  archiveInputs,
  archiveStatus,
  buildArchivedBundle,
  memoryArchiveStore,
  restoreInputs,
  type StoredArchiveEntry,
} from "../input-archive";
import { reconstructForm, exportBundle, importBundle } from "../replay-bundle";
import type { StrategyComparisonResult } from "../strategy-comparison";

const EPOCH = Date.UTC(2026, 0, 1);

const csv = (n: number, stepMs: number, drift = 0): string => {
  const rows: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const p = 100 + i * 0.5 + drift;
    rows.push(`${EPOCH + i * stepMs},${p},${p + 0.4},${p - 0.6},${p + 0.2},1000`);
  }
  return ["time,open,high,low,close,volume", ...rows].join("\n");
};

// ---------------------------------------------------------------------------
// MTF run — anchor 5m, htf 15m, etf 1m: every timeframe file is supplied.
// ---------------------------------------------------------------------------

const MTF_FILES = [
  { name: "anchor.csv", text: csv(60, 5 * 60_000), timeframe: "5m" },
  { name: "htf.csv", text: csv(60, 15 * 60_000), timeframe: "15m" },
  { name: "etf.csv", text: csv(60, 1 * 60_000), timeframe: "1m" },
];
const MTF_INPUTS = { symbol: "SYN", anchor: "5m" };

const mtfForm = (): FormData => {
  const f = new FormData();
  for (const x of MTF_FILES) f.append("files", new File([x.text], x.name, { type: "text/csv" }));
  f.set("meta", JSON.stringify(MTF_FILES.map((x) => ({ timeframe: x.timeframe }))));
  f.set("symbol", "SYN");
  f.set("anchor", "5m");
  f.set("config", JSON.stringify({ horizonBars: 5 }));
  f.set("strategies", JSON.stringify([{ id: "a", preset: "baseline" }, { id: "b", preset: "high-conviction" }]));
  return f;
};

const mtfRecord = async (): Promise<ExperimentRecord> => {
  const res = await POST(new Request("http://localhost/api/compare/strategies", { method: "POST", body: mtfForm() }));
  const body = await res.json() as { result?: StrategyComparisonResult };
  expect(res.status).toBe(200);
  return register([], buildRecord({
    result: body.result!, strategies: body.result!.strategies, createdAt: "2026-02-01T00:00:00.000Z",
  })).record;
};

const archiveMtf = async (store: ReturnType<typeof memoryArchiveStore>, record: ExperimentRecord) =>
  archiveInputs(store, {
    record, inputs: MTF_INPUTS,
    files: MTF_FILES.map((x) => ({
      name: x.name, content: new TextEncoder().encode(x.text), timeframe: x.timeframe,
    })),
    archivedAt: "2026-02-01T00:00:01.000Z",
  });

describe("original-byte fidelity", () => {
  it("stores and digests raw bytes — BOM, CRLF and non-UTF8-safe content survive", async () => {
    const record = await mtfRecord();
    const store = memoryArchiveStore();
    // Bytes a text normalization would mangle: BOM + CRLF + a 0x00 tail.
    const raw = new Uint8Array([0xef, 0xbb, 0xbf,
      ...new TextEncoder().encode(csv(20, 5 * 60_000).replace(/\n/g, "\r\n")), 0x00]);
    const out = await archiveInputs(store, {
      record, inputs: { symbol: "SYN", anchor: "5m" },
      files: [{ name: "raw.csv", content: raw, timeframe: "5m" }],
    });
    expect(out.ok).toBe(true);
    const entry = await store.get(record.recordId);
    expect(entry?.files[0].sha256Bytes).toBe(sha256BytesHex(raw));
    // Byte digest deliberately differs from the decoded-text digest.
    expect(entry?.files[0].sha256Bytes).not.toBe(sha256Hex(new TextDecoder().decode(raw)));
    const restored = await restoreInputs(store, record);
    expect(restored.ok).toBe(true);
    expect(new Uint8Array(entry!.files[0].content as ArrayBuffer)).toEqual(raw);
  });

  it("legacy ia1 text records restore through the new path", async () => {
    const record = await mtfRecord();
    const store = memoryArchiveStore();
    const legacy: StoredArchiveEntry = {
      recordId: record.recordId, fingerprint: record.fingerprint,
      datasetFingerprint: record.datasetFingerprint,
      inputs: { symbol: "SYN", anchor: "5m" },
      files: [{ name: "a.csv", timeframe: "5m",
        bytes: new TextEncoder().encode(MTF_FILES[0].text).length,
        sha256: sha256Hex(MTF_FILES[0].text), text: MTF_FILES[0].text }],
      archivedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.put(legacy);
    const restored = await restoreInputs(store, record);
    expect(restored.ok).toBe(true);
    expect(restored.files?.[0].text).toBe(MTF_FILES[0].text);
  });
});

describe("multi-timeframe archive → restore → replay", () => {
  it("captures all three timeframe files with their MTF roles", async () => {
    const record = await mtfRecord();
    const store = memoryArchiveStore();
    expect((await archiveMtf(store, record)).ok).toBe(true);
    const entry = await store.get(record.recordId);
    expect(entry?.files.map((f) => f.role)).toEqual(["anchor", "htf", "etf"]);
    expect(entry?.files.map((f) => f.timeframe)).toEqual(["5m", "15m", "1m"]);
    const status = await archiveStatus(store, record);
    expect(status.state).toBe("archived");
    expect(status.files).toBe(3);
  });

  it("restored bundle reproduces the canonical role set and dataset identity", async () => {
    const record = await mtfRecord();
    const store = memoryArchiveStore();
    await archiveMtf(store, record);
    const out = await buildArchivedBundle(store, record);
    expect(out.ok).toBe(true);
    expect(out.verification?.datasetIdentity).toBe("matched");
    expect(out.verification?.ineligible).toEqual([]);
    // The reconstructed form re-parses to the identical role set the
    // original run derived — same anchor, htf and etf bindings.
    const orig = await parseUploadForm(mtfForm());
    const replay = await parseUploadForm(reconstructForm(out.bundle!));
    expect(orig.ok && replay.ok).toBe(true);
    if (orig.ok && replay.ok) expect(replay.upload.set).toEqual(orig.upload.set);
  });

  it("real replay through the route reproduces the recorded fingerprint", async () => {
    const record = await mtfRecord();
    const store = memoryArchiveStore();
    await archiveMtf(store, record);
    const out = await buildArchivedBundle(store, record);
    const res = await POST(new Request("http://localhost/api/compare/strategies", {
      method: "POST", body: reconstructForm(out.bundle!),
    }));
    const replayed = (await res.json() as { result?: StrategyComparisonResult }).result!;
    expect(replayed.fingerprint).toBe(record.fingerprint);
  });

  it("missing required timeframe file → dataset identity mismatch, replay blocked", async () => {
    const record = await mtfRecord();
    const store = memoryArchiveStore();
    await archiveMtf(store, record);
    // Simulate a deleted/incomplete entry: the etf file is gone.
    const entry = (await store.get(record.recordId)) as StoredArchiveEntry;
    entry.files = entry.files.filter((f) => f.role !== "etf");
    await store.put(entry);
    const out = await buildArchivedBundle(store, record);
    expect(out.ok).toBe(true); // restore passes — remaining files are intact
    expect(out.verification?.fileIntegrity).toBe("verified");
    expect(out.verification?.datasetIdentity).toBe("mismatch"); // canonical check catches the gap
    expect(out.verification?.ineligible.length).toBeGreaterThan(0);
  });

  it("changed input bytes → verified digest but mismatched dataset identity", async () => {
    const record = await mtfRecord();
    const store = memoryArchiveStore();
    await archiveInputs(store, {
      record, inputs: MTF_INPUTS,
      files: MTF_FILES.map((x) => ({
        name: x.name,
        content: new TextEncoder().encode(csv(60, x.timeframe === "5m" ? 300_000 : x.timeframe === "15m" ? 900_000 : 60_000, 1)), // drifted
        timeframe: x.timeframe,
      })),
    });
    const out = await buildArchivedBundle(store, record);
    expect(out.verification?.fileIntegrity).toBe("verified"); // stored bytes match their own digests
    expect(out.verification?.datasetIdentity).toBe("mismatch"); // but not the recorded run
  });

  it("archived bundle round-trips through export/import intact", async () => {
    const record = await mtfRecord();
    const store = memoryArchiveStore();
    await archiveMtf(store, record);
    const out = await buildArchivedBundle(store, record);
    const imported = importBundle(exportBundle(out.bundle!));
    expect(imported.ok).toBe(true);
    expect(imported.bundle?.files).toHaveLength(3);
    expect(imported.bundle?.files.map((f) => f.timeframe)).toEqual(["5m", "15m", "1m"]);
  });
});
