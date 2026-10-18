/**
 * Local Input Archive (V1.1) — deterministic tests.
 *
 * Persistence semantics are tested at the service/store contract: a shared
 * Map-backed store outlives individual service calls, which is exactly what a
 * reload means for this layer. The IndexedDB adapter is a thin pass-through
 * over the same contract and cannot run under a Node test environment, so the
 * contract — not the driver — is what these tests bind.
 */
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 }); // same convention as the route suite

import { POST } from "@/app/api/compare/strategies/route";
import { buildRecord, register, type ExperimentRecord } from "../experiment-registry";
import { sha256BytesHex, sha256Hex } from "../sha256";
import {
  archiveInputs,
  archiveStatus,
  archiveSummary,
  buildArchivedBundle,
  clearArchive,
  deleteArchived,
  memoryArchiveStore,
  restoreInputs,
  type InputArchiveStore,
  type StoredArchiveEntry,
} from "../input-archive";
import { exportBundle, importBundle } from "../replay-bundle";
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

const form = (): FormData => {
  const f = new FormData();
  f.append("files", new File([csv(60)], "a.csv", { type: "text/csv" }));
  f.set("meta", JSON.stringify([{ timeframe: "1m" }]));
  f.set("symbol", "SYN");
  f.set("anchor", "1m");
  f.set("config", JSON.stringify({ horizonBars: 5 }));
  f.set("strategies", JSON.stringify([{ id: "a", preset: "baseline" }, { id: "b", preset: "high-conviction" }]));
  return f;
};

/** One real canonical run → one real er1 record (deterministic createdAt). */
const runOnce = async (): Promise<ExperimentRecord> => {
  const res = await POST(new Request("http://localhost/api/compare/strategies", { method: "POST", body: form() }));
  const body = await res.json() as { result?: StrategyComparisonResult };
  expect(res.status).toBe(200);
  const rec = buildRecord({
    result: body.result!,
    strategies: body.result!.strategies,
    createdAt: "2026-02-01T00:00:00.000Z",
  });
  return register([], rec).record;
};

const FILES = [{ name: "a.csv", text: csv(60), timeframe: "1m" }];
const INPUTS = { symbol: "SYN", anchor: "1m" };

const archived = async (store: InputArchiveStore, record: ExperimentRecord) =>
  archiveInputs(store, { record, inputs: INPUTS, files: FILES, archivedAt: "2026-02-01T00:00:01.000Z" });

describe("archive association and opt-in", () => {
  it("nothing is stored unless archiveInputs is called — persistence is opt-in", async () => {
    const record = await runOnce();
    const store = memoryArchiveStore();
    expect((await archiveStatus(store, record)).state).toBe("none");
    expect((await archiveSummary(store)).experiments).toBe(0);
    // The only write path is the explicit service call — status stays "none".
    expect((await archiveStatus(store, record)).state).toBe("none");
  });

  it("associates files with the correct experiment — keyed and identity-checked", async () => {
    const record = await runOnce();
    const store = memoryArchiveStore();
    expect((await archived(store, record)).ok).toBe(true);
    const entry = await store.get(record.recordId);
    expect(entry?.recordId).toBe(record.recordId);
    expect(entry?.fingerprint).toBe(record.fingerprint);
    expect(entry?.datasetFingerprint).toBe(record.datasetFingerprint);
    // ia2 payloads carry a BYTE digest — for a text input it equals the
    // text sha256 because UTF-8 encoding is the byte view.
    expect(entry?.files[0].sha256Bytes).toBe(sha256Hex(csv(60)));
    expect(entry?.files[0].role).toBe("anchor");
    expect(entry?.files[0].name).toBe("a.csv");
    expect(entry?.files[0].timeframe).toBe("1m");
    const status = await archiveStatus(store, record);
    expect(status.state).toBe("archived");
    expect(status.files).toBe(1);
    expect(status.totalBytes).toBe(new TextEncoder().encode(csv(60)).length);
  });

  it("duplicate archive writes are idempotent — same recordId, no growth", async () => {
    const record = await runOnce();
    const store = memoryArchiveStore();
    expect((await archived(store, record)).ok).toBe(true);
    expect((await archived(store, record)).ok).toBe(true); // duplicate
    const summary = await archiveSummary(store);
    expect(summary.experiments).toBe(1);
    expect(summary.totalBytes).toBe(new TextEncoder().encode(csv(60)).length);
  });

  it("rejects wrong-record association — a different record cannot restore it", async () => {
    const recordA = await runOnce();
    const store = memoryArchiveStore();
    await archived(store, recordA);
    // A foreign record id simply has no entry.
    const fake = { ...recordA, recordId: "other" } as ExperimentRecord;
    expect((await restoreInputs(store, fake)).ok).toBe(false);
    // An entry claiming A's key but a different fingerprint is incompatible.
    const tampered = (await store.get(recordA.recordId)) as StoredArchiveEntry;
    await store.put({ ...tampered, fingerprint: "f".repeat(64) });
    const out = await restoreInputs(store, recordA);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("association rejected");
    expect((await archiveStatus(store, recordA)).state).toBe("incompatible");
  });
});

describe("persist and restore across simulated reload", () => {
  it("restored bytes verify against stored digests", async () => {
    const record = await runOnce();
    const store = memoryArchiveStore();
    await archived(store, record);
    // "Reload": every later service call sees the same persisted store.
    const restored = await restoreInputs(store, record);
    expect(restored.ok).toBe(true);
    expect(restored.files?.[0].text).toBe(csv(60));
    expect(restored.inputs).toEqual(INPUTS);
    expect(restored.roles).toEqual(["anchor"]);
    expect(sha256BytesHex(new TextEncoder().encode(restored.files![0].text))).toBe(sha256Hex(csv(60)));
  });

  it("full replay-bundle export after restore — verified and byte-identical", async () => {
    const record = await runOnce();
    const store = memoryArchiveStore();
    await archived(store, record);
    const out = await buildArchivedBundle(store, record);
    expect(out.ok).toBe(true);
    expect(out.verification?.datasetIdentity).toBe("matched");
    expect(out.verification?.fileIntegrity).toBe("verified");
    expect(out.verification?.ineligible).toEqual([]);
    // The exported bundle survives import — a portable, self-verifying artifact.
    const imported = importBundle(exportBundle(out.bundle!));
    expect(imported.ok).toBe(true);
    expect(imported.bundle?.files[0].sha256).toBe(sha256Hex(csv(60)));
  });

  it("restored bundle produces the recorded fingerprint on real replay", async () => {
    const record = await runOnce();
    const store = memoryArchiveStore();
    await archived(store, record);
    const out = await buildArchivedBundle(store, record);
    const { reconstructForm } = await import("../replay-bundle");
    const replayRes = await POST(new Request("http://localhost/api/compare/strategies", {
      method: "POST", body: reconstructForm(out.bundle!),
    }));
    const replayed = (await replayRes.json() as { result?: StrategyComparisonResult }).result!;
    expect(replayed.fingerprint).toBe(record.fingerprint);
  });
});

describe("missing, corrupted and deleted files", () => {
  it("missing entry → restore fails, status none", async () => {
    const record = await runOnce();
    const store = memoryArchiveStore();
    const out = await buildArchivedBundle(store, record);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("no archived inputs");
  });

  it("corrupted stored bytes → integrity check catches it", async () => {
    const record = await runOnce();
    const store = memoryArchiveStore();
    await archived(store, record);
    const entry = (await store.get(record.recordId)) as StoredArchiveEntry;
    const buf = new Uint8Array(entry.files[0].content as ArrayBuffer);
    buf[buf.length - 2] ^= 0x01; // flip a bit — byte digest must catch it
    await store.put(entry);
    const out = await restoreInputs(store, record);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("sha256");
    expect((await archiveStatus(store, record)).state).toBe("corrupt");
  });

  it("missing file contents in a stored entry → flagged", async () => {
    const record = await runOnce();
    const store = memoryArchiveStore();
    await archived(store, record);
    const entry = (await store.get(record.recordId)) as StoredArchiveEntry;
    entry.files[0].content = undefined;
    await store.put(entry);
    const out = await restoreInputs(store, record);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("missing");
  });

  it("delete removes inputs but leaves experiment metadata intact", async () => {
    const record = await runOnce();
    const store = memoryArchiveStore();
    await archived(store, record);
    const fpBefore = record.fingerprint;
    expect((await deleteArchived(store, record.recordId)).ok).toBe(true);
    expect((await archiveStatus(store, record)).state).toBe("none");
    expect(record.fingerprint).toBe(fpBefore); // record untouched
    expect((await buildArchivedBundle(store, record)).ok).toBe(false);
  });

  it("clear empties the archive", async () => {
    const record = await runOnce();
    const store = memoryArchiveStore();
    await archived(store, record);
    expect((await clearArchive(store)).ok).toBe(true);
    expect((await archiveSummary(store)).experiments).toBe(0);
  });
});

describe("storage failures — honest, never claimed", () => {
  const failing = (op: keyof InputArchiveStore): InputArchiveStore => ({
    ...memoryArchiveStore(),
    [op]: async () => { throw new DOMException("quota", "QuotaExceededError"); },
  });

  it("quota/write failure → ok:false, error surfaced, nothing claimed", async () => {
    const record = await runOnce();
    const out = await archived(failing("put"), record);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("write failed");
  });

  it("read failure → restore reports it rather than guessing", async () => {
    const record = await runOnce();
    const out = await restoreInputs(failing("get"), record);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("read failed");
    // status also degrades honestly
    const s = await archiveStatus(failing("get"), record);
    expect(s.detail).toContain("read failed");
  });

  it("delete failure is reported", async () => {
    const out = await deleteArchived(failing("delete"), "x");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("delete failed");
  });
});

describe("limits and legacy compatibility", () => {
  it("rejects more than 4 files and oversized content", async () => {
    const record = await runOnce();
    const store = memoryArchiveStore();
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.csv`, text: "x" }));
    expect((await archiveInputs(store, { record, inputs: INPUTS, files: five })).ok).toBe(false);
    const huge = [{ name: "h.csv", text: "x".repeat(5 * 1024 * 1024 + 1) }];
    const out = await archiveInputs(store, { record, inputs: INPUTS, files: huge });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("per-file limit");
  });

  it("legacy record without datasetFingerprint — association compares like-for-like", async () => {
    const record = await runOnce();
    const legacy = { ...record, datasetFingerprint: undefined } as ExperimentRecord;
    const store = memoryArchiveStore();
    expect((await archiveInputs(store, { record: legacy, inputs: INPUTS, files: FILES })).ok).toBe(true);
    const status = await archiveStatus(store, legacy);
    expect(status.state).toBe("archived"); // both sides undefined → consistent
    // But the same entry vs the full record (fingerprint present) is incompatible.
    expect((await archiveStatus(store, record)).state).toBe("incompatible");
  });

  it("archiving never changes the recorded fingerprint or result", async () => {
    const record = await runOnce();
    const before = JSON.stringify(record);
    const store = memoryArchiveStore();
    await archived(store, record);
    await buildArchivedBundle(store, record);
    await deleteArchived(store, record.recordId);
    expect(JSON.stringify(record)).toBe(before); // record object untouched
  });
});
