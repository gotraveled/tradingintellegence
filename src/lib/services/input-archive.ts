/**
 * Local Input Archive (V1.1) — opt-in, browser-local persistence of the
 * ORIGINAL uploaded CSV text so a full rb1 replay bundle can be exported
 * after a page reload.
 *
 * Design, stated verbatim:
 *  - Writes happen ONLY on explicit user opt-in; nothing is silently stored.
 *  - Files are associated with a completed experiment by recordId, and the
 *    association is verified against the experiment fingerprint and dataset
 *    identity on restore — a stored entry that does not match its record is
 *    "incompatible", never silently trusted.
 *  - IndexedDB is the browser store; localStorage is never used for file
 *    payloads. An in-memory fallback reports persistent=false honestly —
 *    storage failures are surfaced, not hidden.
 *  - V1.2 (schema ia2): files are stored as the ORIGINAL uploaded bytes
 *    (ArrayBuffer) with a byte-level sha256 — not File.text() output.
 *    Legacy ia1 text records remain readable; each file is verified
 *    against whichever digest binds it, and version presence is explicit.
 *  - Per-file MTF roles are recorded when derivable from declared
 *    timeframes — informational only: the canonical parser re-derives
 *    roles on replay and dataset identity is the proof.
 *  - Restore re-verifies every file's digest and the canonical dataset
 *    identity (via verifyBundle) before a rebuilt bundle is considered
 *    replay-eligible.
 *  - Archiving never changes the record, the fingerprint, or historical
 *    results; deleting archived inputs leaves all metadata intact.
 *  - Nothing is uploaded anywhere — all data stays in this browser.
 */
import { sha256BytesHex, sha256Hex } from "./sha256";
import { assignMtfRoles, isCanonicalTimeframe } from "./mtf-upload";
import type { Timeframe } from "@/lib/types";
import type { ExperimentRecord } from "./experiment-registry";
import {
  buildBundle,
  verifyBundle,
  BUNDLE_MAX_FILES,
  BUNDLE_MAX_FILE_BYTES,
  BUNDLE_MAX_TOTAL_BYTES,
  type BundleInputs,
  type BundleVerification,
  type ExportSourceFile,
  type ReplayBundle,
} from "./replay-bundle";

// ---------------------------------------------------------------------------
// Limits — consistent with the rb1 upload contract; a whole-archive ceiling
// keeps the store from growing without bound.
// ---------------------------------------------------------------------------

export const ARCHIVE_MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64 MiB across all entries

export const INPUT_ARCHIVE_LIMITATION =
  "Archived inputs are stored in this browser only (IndexedDB). They are not " +
  "shared across browsers, devices, or users, and are lost if site data is " +
  "cleared. Export a replay bundle to preserve inputs independently.";

// ---------------------------------------------------------------------------
// Stored shape
// ---------------------------------------------------------------------------

/** Archive record schema — absent means ia1 (V1.1 text records). */
export const ARCHIVE_SCHEMA_VERSION = "ia2";

export type ArchivedFileRole = "anchor" | "htf" | "etf" | "unused";

export interface ArchivedFilePayload {
  /** Basename only — enforced on write. */
  name: string;
  timeframe?: string;
  is24x7?: boolean;
  /** MTF role derived at archive time — informational; canonical re-parse
   *  is the authority and dataset identity is the proof of equivalence. */
  role?: ArchivedFileRole;
  /** ia2: original upload bytes, byte length, and byte-level sha256. */
  byteLength?: number;
  sha256Bytes?: string;
  content?: ArrayBuffer;
  /** ia1 (legacy): normalized UTF-8 text, its byte length, and text sha256. */
  bytes?: number;
  sha256?: string;
  text?: string;
}

export interface StoredArchiveEntry {
  /** Schema marker — ia2 for byte-faithful records; absent = legacy ia1. */
  archiveVersion?: string;
  /** Registry key — the completed experiment this input set belongs to. */
  recordId: string;
  /** Association proofs — re-checked against the record on restore.
   *  datasetFingerprint may be absent on legacy records; the check is
   *  strict-equality so undefined-vs-present is flagged incompatible. */
  fingerprint: string;
  datasetFingerprint?: string;
  inputs: BundleInputs;
  files: ArchivedFilePayload[];
  archivedAt: string;
}

// ---------------------------------------------------------------------------
// Store adapters — the service is pure; persistence is injected.
// ---------------------------------------------------------------------------

export interface InputArchiveStore {
  put(entry: StoredArchiveEntry): Promise<void>;
  get(recordId: string): Promise<StoredArchiveEntry | undefined>;
  list(): Promise<StoredArchiveEntry[]>;
  delete(recordId: string): Promise<void>;
  clear(): Promise<void>;
  /** True when writes survive a reload — false for the memory fallback. */
  persistent: boolean;
  /** Why persistence is limited — rendered verbatim in the UI. */
  limitation: string;
}

const MEMORY_ARCHIVE_LIMITATION =
  "input archive is in-memory for this session — files are not persisted.";

export function memoryArchiveStore(): InputArchiveStore {
  const map = new Map<string, StoredArchiveEntry>();
  return {
    persistent: false,
    limitation: MEMORY_ARCHIVE_LIMITATION,
    put: async (e) => { map.set(e.recordId, e); },
    get: async (id) => map.get(id),
    list: async () => [...map.values()],
    delete: async (id) => { map.delete(id); },
    clear: async () => { map.clear(); },
  };
}

// ---------------------------------------------------------------------------
// IndexedDB adapter — thin; structured-cloneable entries, key = recordId.
// ---------------------------------------------------------------------------

const IDB_NAME = "ti-input-archive";
const IDB_VERSION = 1;
const IDB_STORE = "inputs";

const idbRequest = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });

const idbDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });

/** IndexedDB-backed store. Callers get persistent=false (memory) when IDB is
 *  unavailable — SSR, private browsing with blocked storage, or test envs. */
export function idbArchiveStore(): InputArchiveStore {
  if (typeof indexedDB === "undefined") return memoryArchiveStore();
  const open = async (): Promise<IDBDatabase> => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE, { keyPath: "recordId" });
      }
    };
    return idbRequest(req);
  };
  const tx = async <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | undefined): Promise<T | undefined> => {
    const db = await open();
    try {
      const t = db.transaction(IDB_STORE, mode);
      const s = t.objectStore(IDB_STORE);
      const req = run(s);
      const out = req !== undefined ? await idbRequest(req) : undefined;
      await idbDone(t);
      return out;
    } finally {
      db.close();
    }
  };
  return {
    persistent: true,
    limitation: INPUT_ARCHIVE_LIMITATION,
    put: async (e) => {
      await tx("readwrite", (s) => { s.put(e); return undefined; });
    },
    get: async (id) => (await tx("readonly", (s) => s.get(id))) as StoredArchiveEntry | undefined,
    list: async () => (await tx("readonly", (s) => s.getAll() as IDBRequest<StoredArchiveEntry[]>)) ?? [],
    delete: async (id) => {
      await tx("readwrite", (s) => s.delete(id));
    },
    clear: async () => {
      await tx("readwrite", (s) => { s.clear(); return undefined; });
    },
  };
}

/** Browser default — IndexedDB when usable, in-memory otherwise. */
export function browserArchiveStore(): InputArchiveStore {
  return typeof window === "undefined" ? memoryArchiveStore() : idbArchiveStore();
}

// ---------------------------------------------------------------------------
// Service layer — association, verification, restore.
// ---------------------------------------------------------------------------

/** A file supplied for archiving — original bytes preferred. */
export interface ArchiveSourceFile {
  name: string;
  /** Preferred: the upload's original bytes (File.arrayBuffer()). */
  content?: ArrayBuffer | Uint8Array;
  /** Convenience: UTF-8 encoded into bytes on write — the stored digest
   *  still binds the stored bytes, never claims source-byte identity. */
  text?: string;
  timeframe?: string;
  is24x7?: boolean;
}

export interface ArchiveWriteInput {
  record: ExperimentRecord;
  inputs: BundleInputs;
  files: ArchiveSourceFile[];
  archivedAt?: string; // injectable for deterministic tests
}

export interface ArchiveResult {
  ok: boolean;
  error?: string;
}

const basename = (name: string): string =>
  name.replace(/\\/g, "/").split("/").pop() ?? name;

const toArrayBuffer = (u: Uint8Array): ArrayBuffer =>
  u.buffer instanceof ArrayBuffer && u.byteOffset === 0 && u.byteLength === u.buffer.byteLength
    ? u.buffer
    : u.slice().buffer as ArrayBuffer;

/** Bytes held by a payload, whichever schema carries them. */
const payloadBytes = (f: ArchivedFilePayload): number | undefined =>
  f.byteLength ?? f.bytes;

/** Integrity check that respects the schema each payload was written in. */
const payloadIntact = (f: ArchivedFilePayload): boolean => {
  if (f.content !== undefined) { // ia2 — byte digest over the stored buffer
    return f.byteLength !== undefined && f.content.byteLength === f.byteLength &&
      f.sha256Bytes !== undefined &&
      sha256BytesHex(new Uint8Array(f.content)) === f.sha256Bytes;
  }
  if (f.text !== undefined) { // ia1 legacy — text digest
    return f.bytes !== undefined &&
      new TextEncoder().encode(f.text).length === f.bytes &&
      f.sha256 !== undefined && sha256Hex(f.text) === f.sha256;
  }
  return false;
};

/** Explicit opt-in write. Validates the rb1 limits, computes BYTE digests,
 *  stores the original upload bytes — and reports failure honestly. */
export async function archiveInputs(
  store: InputArchiveStore,
  w: ArchiveWriteInput,
): Promise<ArchiveResult> {
  if (w.files.length < 1) return { ok: false, error: "no files supplied — nothing to archive" };
  if (w.files.length > BUNDLE_MAX_FILES) {
    return { ok: false, error: `archive is limited to ${BUNDLE_MAX_FILES} files` };
  }
  // Derive MTF roles only when every file declares a canonical timeframe —
  // informational metadata; never guessed from partial data.
  const declared = w.files.map((f) => f.timeframe);
  const roles = (() => {
    if (!isCanonicalTimeframe(w.inputs.anchor) ||
        declared.some((t) => t === undefined || !isCanonicalTimeframe(t))) {
      return undefined;
    }
    const a = assignMtfRoles(declared as Timeframe[], w.inputs.anchor as Timeframe, {
      ...(w.inputs.htf !== undefined && isCanonicalTimeframe(w.inputs.htf)
        ? { htf: w.inputs.htf as Timeframe } : {}),
      ...(w.inputs.etf !== undefined && isCanonicalTimeframe(w.inputs.etf)
        ? { etf: w.inputs.etf as Timeframe } : {}),
    });
    return a.ok ? a.assignment.roles : undefined;
  })();
  const roleOf = (tf?: string): ArchivedFileRole | undefined => {
    if (roles === undefined || tf === undefined) return undefined;
    if (roles.itf === tf) return "anchor";
    if (roles.htf === tf) return "htf";
    if (roles.etf === tf) return "etf";
    return "unused";
  };

  const payloads: ArchivedFilePayload[] = [];
  let total = 0;
  for (const f of w.files) {
    if (f.content === undefined && f.text === undefined) {
      return { ok: false, error: `file ${basename(f.name)} carries no content` };
    }
    const buf: ArrayBuffer = f.content instanceof ArrayBuffer
      ? f.content
      : f.content !== undefined
        ? toArrayBuffer(f.content)
        : new TextEncoder().encode(f.text ?? "").buffer as ArrayBuffer;
    const bytes = buf.byteLength;
    if (bytes > BUNDLE_MAX_FILE_BYTES) {
      return { ok: false, error: `file ${basename(f.name)} exceeds the per-file limit` };
    }
    total += bytes;
    if (total > BUNDLE_MAX_TOTAL_BYTES) {
      return { ok: false, error: "combined inputs exceed the bundle size limit" };
    }
    payloads.push({
      name: basename(f.name),
      ...(f.timeframe !== undefined ? { timeframe: f.timeframe } : {}),
      ...(f.is24x7 === true ? { is24x7: true } : {}),
      ...(roleOf(f.timeframe) !== undefined ? { role: roleOf(f.timeframe) } : {}),
      byteLength: bytes,
      sha256Bytes: sha256BytesHex(new Uint8Array(buf)),
      content: buf,
    });
  }
  try {
    const existing = await store.list();
    const currentTotal = existing
      .filter((e) => e.recordId !== w.record.recordId)
      .reduce((s, e) => s + e.files.reduce((sf, f) => sf + (payloadBytes(f) ?? 0), 0), 0);
    if (currentTotal + total > ARCHIVE_MAX_TOTAL_BYTES) {
      return {
        ok: false,
        error: `input archive is full (limit ${Math.floor(ARCHIVE_MAX_TOTAL_BYTES / 1048576)} MiB) — delete archived inputs first`,
      };
    }
    await store.put({
      archiveVersion: ARCHIVE_SCHEMA_VERSION,
      recordId: w.record.recordId,
      fingerprint: w.record.fingerprint,
      datasetFingerprint: w.record.datasetFingerprint,
      inputs: { ...w.inputs },
      files: payloads,
      archivedAt: w.archivedAt ?? new Date().toISOString(),
    });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? `archive write failed: ${e.message}` : "archive write failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Status — per-record archive state for the UI.
// ---------------------------------------------------------------------------

export type ArchiveState = "none" | "archived" | "corrupt" | "incompatible";

export interface RecordArchiveStatus {
  state: ArchiveState;
  files: number;
  totalBytes: number;
  detail?: string;
}

export async function archiveStatus(
  store: InputArchiveStore,
  record: ExperimentRecord,
): Promise<RecordArchiveStatus> {
  let entry: StoredArchiveEntry | undefined;
  try {
    entry = await store.get(record.recordId);
  } catch (e) {
    return {
      state: "none", files: 0, totalBytes: 0,
      detail: e instanceof Error ? `archive read failed: ${e.message}` : "archive read failed",
    };
  }
  if (entry === undefined) return { state: "none", files: 0, totalBytes: 0 };
  if (entry.fingerprint !== record.fingerprint ||
      entry.datasetFingerprint !== record.datasetFingerprint) {
    return {
      state: "incompatible", files: entry.files.length,
      totalBytes: entry.files.reduce((s, f) => s + (payloadBytes(f) ?? 0), 0),
      detail: "archived inputs no longer match this experiment's identity",
    };
  }
  const bad = entry.files.find((f) => !payloadIntact(f));
  if (bad !== undefined) {
    return {
      state: "corrupt", files: entry.files.length,
      totalBytes: entry.files.reduce((s, f) => s + (payloadBytes(f) ?? 0), 0),
      detail: `stored file ${bad.name} failed its integrity check`,
    };
  }
  return {
    state: "archived", files: entry.files.length,
    totalBytes: entry.files.reduce((s, f) => s + (payloadBytes(f) ?? 0), 0),
  };
}

export interface ArchiveSummary {
  persistent: boolean;
  limitation: string;
  experiments: number;
  totalBytes: number;
  byRecord: Map<string, { files: number; bytes: number }>;
}

export async function archiveSummary(store: InputArchiveStore): Promise<ArchiveSummary> {
  const byRecord = new Map<string, { files: number; bytes: number }>();
  let total = 0;
  try {
    for (const e of await store.list()) {
      const bytes = e.files.reduce((s, f) => s + (payloadBytes(f) ?? 0), 0);
      byRecord.set(e.recordId, { files: e.files.length, bytes });
      total += bytes;
    }
  } catch {
    // Read failure — report whatever accumulated; UI shows the limitation text.
  }
  return {
    persistent: store.persistent,
    limitation: store.limitation,
    experiments: byRecord.size,
    totalBytes: total,
    byRecord,
  };
}

// ---------------------------------------------------------------------------
// Restore + verify — the only path that produces replay-eligible files.
// ---------------------------------------------------------------------------

export interface RestoreOutcome {
  ok: boolean;
  inputs?: BundleInputs;
  files?: ExportSourceFile[];
  /** Per-file MTF roles recorded at archive time, aligned with `files`. */
  roles?: (ArchivedFileRole | undefined)[];
  error?: string;
}

/** Restore and integrity-check the archived inputs for a record. Association
 *  and per-file digests are verified; failures return ok:false with a reason. */
export async function restoreInputs(
  store: InputArchiveStore,
  record: ExperimentRecord,
): Promise<RestoreOutcome> {
  let entry: StoredArchiveEntry | undefined;
  try {
    entry = await store.get(record.recordId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `archive read failed: ${e.message}` : "archive read failed" };
  }
  if (entry === undefined) return { ok: false, error: "no archived inputs for this experiment" };
  if (entry.fingerprint !== record.fingerprint ||
      entry.datasetFingerprint !== record.datasetFingerprint) {
    return { ok: false, error: "archived inputs do not match this experiment — association rejected" };
  }
  if (entry.files.length < 1) return { ok: false, error: "archive entry has no files" };
  const files: ExportSourceFile[] = [];
  for (const f of entry.files) {
    if (f.content === undefined && f.text === undefined) {
      return { ok: false, error: `stored file ${f.name} is missing its contents` };
    }
    if (!payloadIntact(f)) {
      return { ok: false, error: `stored file ${f.name} failed its sha256 integrity check` };
    }
    files.push({
      name: f.name,
      // ia2 → decode stored bytes; ia1 → the stored text verbatim. The
      // decoder matches File.text() semantics (UTF-8, BOM consumed).
      text: f.content !== undefined ? new TextDecoder().decode(f.content) : f.text ?? "",
      ...(f.timeframe !== undefined ? { timeframe: f.timeframe } : {}),
      ...(f.is24x7 === true ? { is24x7: true } : {}),
    });
  }
  return {
    ok: true,
    inputs: { ...entry.inputs },
    files,
    roles: entry.files.map((f) => f.role),
  };
}

export interface ArchivedBundleOutcome {
  ok: boolean;
  bundle?: ReplayBundle;
  verification?: BundleVerification;
  error?: string;
}

/** Rebuild a full rb1 bundle from archived inputs and verify it end-to-end —
 *  file digests, manifest integrity, and canonical dataset identity — before
 *  it is considered replay-eligible. */
export async function buildArchivedBundle(
  store: InputArchiveStore,
  record: ExperimentRecord,
): Promise<ArchivedBundleOutcome> {
  const restored = await restoreInputs(store, record);
  if (!restored.ok || restored.inputs === undefined || restored.files === undefined) {
    return { ok: false, error: restored.error ?? "restore failed" };
  }
  const bundle = buildBundle({
    record,
    inputs: restored.inputs,
    files: restored.files,
  });
  const verification = await verifyBundle(bundle);
  return { ok: true, bundle, verification };
}

// ---------------------------------------------------------------------------
// Deletion — inputs only; experiment metadata is untouched by design.
// ---------------------------------------------------------------------------

export async function deleteArchived(
  store: InputArchiveStore,
  recordId: string,
): Promise<ArchiveResult> {
  try {
    await store.delete(recordId);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? `archive delete failed: ${e.message}` : "archive delete failed",
    };
  }
}

export async function clearArchive(store: InputArchiveStore): Promise<ArchiveResult> {
  try {
    await store.clear();
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? `archive clear failed: ${e.message}` : "archive clear failed",
    };
  }
}
