/**
 * Real IndexedDB adapter tests — fake-indexeddb runs the actual
 * `idbArchiveStore` implementation: real transactions, real structured
 * clone of ArrayBuffer payloads, real database open/upgrade/close.
 *
 * Scope honesty: fake-indexeddb is a faithful IDB implementation, not a
 * browser. Quota policies are NOT enforced by it — quota/failure paths are
 * covered by injected-failure tests here and in input-archive.test.ts.
 * A manual real-browser smoke procedure is documented in the V1.2 report.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";

import {
  archiveInputs,
  archiveStatus,
  archiveSummary,
  clearArchive,
  deleteArchived,
  idbArchiveStore,
  memoryArchiveStore,
  restoreInputs,
  type StoredArchiveEntry,
} from "../input-archive";
import { sha256BytesHex, sha256Hex } from "../sha256";
import type { ExperimentRecord } from "../experiment-registry";

/** Minimal er1-shaped record — association fields are what the service reads. */
const rec = (recordId: string, fp: string): ExperimentRecord =>
  ({ recordId, fingerprint: fp, datasetFingerprint: `d-${fp}` }) as ExperimentRecord;

const R1 = rec("r1", "a".repeat(64));
const R2 = rec("r2", "b".repeat(64));

const BYTES = new TextEncoder().encode("time,open,high,low,close\n1,2,3,1,2\r\n");
const write = (store: ReturnType<typeof idbArchiveStore>, record = R1) =>
  archiveInputs(store, {
    record,
    inputs: { symbol: "SYN", anchor: "1m" },
    files: [{ name: "a.csv", content: BYTES, timeframe: "1m" }],
    archivedAt: "2026-02-01T00:00:00.000Z",
  });

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory(); // one factory = one browser profile
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = factory;
});
afterEach(() => {
  delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
});

describe("idbArchiveStore — real adapter behavior", () => {
  it("creates the database, writes, and reports persistent:true", async () => {
    const store = idbArchiveStore();
    expect(store.persistent).toBe(true);
    expect((await write(store)).ok).toBe(true);
    const entry = await store.get(R1.recordId);
    expect(entry?.recordId).toBe(R1.recordId);
    expect(entry?.archiveVersion).toBe("ia2");
  });

  it("persists across close/reopen — a new store instance sees the data", async () => {
    const first = idbArchiveStore();
    await write(first);
    // "Reload": a fresh store object over the same IndexedDB factory.
    const reopened = idbArchiveStore();
    const status = await archiveStatus(reopened, R1);
    expect(status.state).toBe("archived");
    const restored = await restoreInputs(reopened, R1);
    expect(restored.ok).toBe(true);
  });

  it("restored bytes are byte-identical — digest verified over ArrayBuffer", async () => {
    await write(idbArchiveStore());
    const entry = await idbArchiveStore().get(R1.recordId);
    const content = entry?.files[0].content as ArrayBuffer;
    expect(new Uint8Array(content)).toEqual(BYTES);
    expect(entry?.files[0].sha256Bytes).toBe(sha256BytesHex(BYTES));
    // Byte digest is NOT the text digest when the content has CRLF — it binds bytes.
    const restored = await restoreInputs(idbArchiveStore(), R1);
    expect(restored.files?.[0].text).toBe(new TextDecoder().decode(BYTES));
  });

  it("delete removes only that experiment's inputs", async () => {
    const store = idbArchiveStore();
    await write(store, R1);
    await write(store, R2);
    expect((await deleteArchived(store, R1.recordId)).ok).toBe(true);
    expect((await archiveStatus(store, R1)).state).toBe("none");
    expect((await archiveStatus(store, R2)).state).toBe("archived"); // untouched
  });

  it("clear removes every entry", async () => {
    const store = idbArchiveStore();
    await write(store, R1);
    await write(store, R2);
    expect((await clearArchive(store)).ok).toBe(true);
    expect((await archiveSummary(store)).experiments).toBe(0);
  });

  it("legacy ia1 text records remain readable through the new schema", async () => {
    const store = idbArchiveStore();
    const legacy: StoredArchiveEntry = {
      // no archiveVersion — the ia1 shape written by V1.1
      recordId: R1.recordId,
      fingerprint: R1.fingerprint,
      datasetFingerprint: R1.datasetFingerprint,
      inputs: { symbol: "SYN", anchor: "1m" },
      files: [{
        name: "a.csv", timeframe: "1m",
        bytes: new TextEncoder().encode("t,o,h,l,c\n1,2,3,1,2\n").length,
        sha256: sha256Hex("t,o,h,l,c\n1,2,3,1,2\n"),
        text: "t,o,h,l,c\n1,2,3,1,2\n",
      }],
      archivedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.put(legacy);
    const restored = await restoreInputs(idbArchiveStore(), R1);
    expect(restored.ok).toBe(true);
    expect(restored.files?.[0].text).toBe("t,o,h,l,c\n1,2,3,1,2\n");
    expect((await archiveStatus(idbArchiveStore(), R1)).state).toBe("archived");
  });

  it("structured-clone proof: mutating the source buffer cannot alter the stored bytes", async () => {
    const buf = BYTES.slice().buffer;
    const store = idbArchiveStore();
    await archiveInputs(store, {
      record: R1, inputs: { symbol: "SYN", anchor: "1m" },
      files: [{ name: "a.csv", content: buf, timeframe: "1m" }],
    });
    new Uint8Array(buf)[0] = 0x00; // corrupt the caller's buffer after write
    const status = await archiveStatus(store, R1);
    expect(status.state).toBe("archived"); // stored clone is unaffected
  });

  it("storage failure → archiveInputs reports it, never claims persistence", async () => {
    factory.open = () => { throw new DOMException("blocked", "SecurityError"); };
    const out = await write(idbArchiveStore());
    expect(out.ok).toBe(false);
    expect(out.error).toContain("write failed");
  });

  it("memory fallback honestly reports persistent:false", () => {
    const store = memoryArchiveStore();
    expect(store.persistent).toBe(false);
    expect(store.limitation).toContain("not persisted");
  });

  it("no indexedDB global → idbArchiveStore degrades to the honest memory store", () => {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    const store = idbArchiveStore();
    expect(store.persistent).toBe(false);
  });
});
