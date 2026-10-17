/**
 * Portable Research Replay Bundle (rb1) — additive export/import layer over
 * the reproducibility manifest (rm1) and the canonical upload pipeline.
 *
 * A bundle packages, where available:
 *  - the rm1 manifest (recorded inputs, protocol, exposure, digest),
 *  - the ORIGINAL uploaded CSV bytes the user explicitly exports,
 *  - upload inputs (symbol/anchor/htf/etf) needed to rebuild the form,
 *  - verbatim strategy snapshots + shared evaluation settings.
 *
 * Integrity boundaries, stated verbatim:
 *  - Per-file sha256 binds the exported TEXT content — File.text() bytes.
 *    We hash what we actually hold; we never claim byte-identity to a source
 *    the user did not supply.
 *  - A valid bundle is user-provided research data — it may contain
 *    commercially sensitive market data and is never proof a claimed run
 *    occurred.
 *  - Replay uses the canonical /api/compare/strategies contract
 *    (parseUploadForm → runStrategyComparison). Replayed results are compared
 *    alongside recorded values — never merged into the registry.
 */
import { sha256Hex } from "./sha256";
import { stableStringify } from "./strategy-comparison";
import {
  buildManifest,
  verifyManifest,
  type ReproducibilityManifest,
} from "./reproducibility";
import type { ExperimentRecord } from "./experiment-registry";
import { parseUploadForm } from "./csv-upload";
import { datasetFingerprintDigest } from "./strategy-comparison";
import type {
  ComparisonSelection,
  ComparisonSharedConfig,
  StrategyComparisonResult,
} from "./strategy-comparison";
import type { EngineConfig } from "@/lib/types";

export const BUNDLE_VERSION = "rb1";
export const BUNDLE_FORMAT = "ti-replay-bundle";

// Resource limits — consistent with the upload pipeline's 1–4 file contract.
export const BUNDLE_MAX_FILES = 4;
export const BUNDLE_MAX_FILE_BYTES = 5 * 1024 * 1024;      // per CSV text
export const BUNDLE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;    // decoded total

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface BundleFileEntry {
  /** Basename only — no directories; enforced on export AND import. */
  name: string;
  /** Canonical timeframe declared/recorded at upload, if known. */
  timeframe?: string;
  is24x7?: boolean;
  /** Byte length of the text content (UTF-8). */
  bytes: number;
  /** sha256 of the text content — binds exactly what was exported. */
  sha256: string;
  /** Base64 of the text — present only when original bytes were exported. */
  contentBase64?: string;
}

/** Upload inputs required to rebuild the canonical form — recorded at export.
 *  Not derivable from an er1 record alone, which is why record-only exports
 *  are metadata-only by construction. */
export interface BundleInputs {
  symbol: string;
  anchor: string;
  htf?: string;
  etf?: string;
}

export interface BundleStrategySnapshot {
  id: string;
  label?: string;
  engineConfig: EngineConfig;
  selection?: ComparisonSelection;
}

export interface ReplayBundle {
  format: typeof BUNDLE_FORMAT;
  bundleVersion: typeof BUNDLE_VERSION;
  manifest: ReproducibilityManifest;
  inputs: BundleInputs;
  files: BundleFileEntry[];
  strategies: BundleStrategySnapshot[];
  shared: ComparisonSharedConfig;
  /** Components known-missing at export — explicit, never implied. */
  unavailable: string[];
  limitation: string;
}

export const BUNDLE_LIMITATION =
  "This bundle contains user-provided research inputs and may contain " +
  "commercially sensitive market data. File digests verify the exported " +
  "contents; a valid bundle is not proof that the claimed engine run occurred " +
  "or that the market data is authentic.";

// ---------------------------------------------------------------------------
// Export — files included only when original text is still available.
// ---------------------------------------------------------------------------

export interface ExportSourceFile {
  name: string;
  text: string;
  timeframe?: string;
  is24x7?: boolean;
}

const basename = (name: string): string =>
  name.replace(/\\/g, "/").split("/").pop() ?? name;

export function buildBundle(input: {
  record: ExperimentRecord;
  inputs: BundleInputs;
  /** Original upload text contents — omit for a metadata-only bundle. */
  files?: ExportSourceFile[];
}): ReplayBundle {
  const { record, inputs, files } = input;
  const unavailable: string[] = [];
  const entries: BundleFileEntry[] = (files ?? []).map((f) => ({
    name: basename(f.name),
    ...(f.timeframe !== undefined ? { timeframe: f.timeframe } : {}),
    ...(f.is24x7 !== undefined ? { is24x7: f.is24x7 } : {}),
    bytes: new TextEncoder().encode(f.text).length,
    sha256: sha256Hex(f.text),
    contentBase64: btoa(unescape(encodeURIComponent(f.text))),
  }));
  if (entries.length === 0) {
    unavailable.push(
      "original-upload-bytes: source CSVs were not held by the exporter — " +
      "bundle is metadata-only; replay is not possible from this bundle.",
    );
  }
  return {
    format: BUNDLE_FORMAT,
    bundleVersion: BUNDLE_VERSION,
    manifest: buildManifest(record),
    inputs,
    files: entries,
    strategies: record.strategies.map((s) => ({
      id: s.id,
      ...(s.label !== undefined ? { label: s.label } : {}),
      engineConfig: s.engineConfig,
      ...(s.selection !== undefined ? { selection: s.selection } : {}),
    })),
    shared: record.shared,
    unavailable,
    limitation: BUNDLE_LIMITATION,
  };
}

/** Deterministic export — identical bundle ⇒ identical bytes. */
export function exportBundle(bundle: ReplayBundle): string {
  return stableStringify(bundle);
}

// ---------------------------------------------------------------------------
// Import — validate structure, size, path safety; never trust claims.
// ---------------------------------------------------------------------------

export interface BundleImportOutcome {
  ok: boolean;
  error?: string;
  bundle?: ReplayBundle;
  notices: string[];
}

const SAFE_BASENAME = /^[^/\\:*?"<>|\x00-\x1f]{1,128}$/;

const decodeContent = (b64: string): string | undefined => {
  try {
    return decodeURIComponent(escape(atob(b64)));
  } catch {
    return undefined;
  }
};

export function importBundle(json: string): BundleImportOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "file is not valid JSON.", notices: [] };
  }
  const b = parsed as Partial<ReplayBundle>;
  if (b?.format !== BUNDLE_FORMAT) {
    return { ok: false, error: `unrecognized file — expected format "${BUNDLE_FORMAT}".`, notices: [] };
  }
  if (b.bundleVersion !== BUNDLE_VERSION) {
    return {
      ok: false,
      error: `bundleVersion "${String(b.bundleVersion)}" is not supported by bundle schema ${BUNDLE_VERSION}.`,
      notices: [],
    };
  }
  const m = b.manifest as ReproducibilityManifest | undefined;
  if (m?.format !== "ti-reproducibility-manifest" || typeof m.contents !== "object" ||
      typeof m.digest !== "string") {
    return { ok: false, error: "bundle lacks a valid embedded manifest.", notices: [] };
  }
  const inputs = b.inputs;
  if (inputs === undefined || typeof inputs.symbol !== "string" ||
      typeof inputs.anchor !== "string") {
    return { ok: false, error: "bundle lacks recorded upload inputs (symbol/anchor).", notices: [] };
  }
  if (!Array.isArray(b.files) || b.files.length > BUNDLE_MAX_FILES) {
    return { ok: false, error: `bundle must carry 0–${BUNDLE_MAX_FILES} files.`, notices: [] };
  }
  if (!Array.isArray(b.strategies) || b.strategies.length === 0 ||
      b.shared === undefined || typeof b.shared !== "object") {
    return { ok: false, error: "bundle lacks strategy snapshots or shared settings.", notices: [] };
  }

  const files: BundleFileEntry[] = [];
  let total = 0;
  for (const [i, f] of b.files.entries()) {
    if (f === null || typeof f !== "object" || typeof f.name !== "string" ||
        !SAFE_BASENAME.test(f.name) || f.name === "." || f.name === "..") {
      return {
        ok: false,
        error: `file ${i + 1}: unsafe or missing name "${String(f?.name)}" — basenames only, no paths.`,
        notices: [],
      };
    }
    if (typeof f.bytes !== "number" || typeof f.sha256 !== "string" ||
        f.sha256.length !== 64) {
      return { ok: false, error: `file ${i + 1} (${f.name}): missing bytes/sha256 inventory fields.`, notices: [] };
    }
    if (f.contentBase64 !== undefined) {
      const text = decodeContent(f.contentBase64);
      if (text === undefined) {
        return { ok: false, error: `file ${i + 1} (${f.name}): content is not valid base64.`, notices: [] };
      }
      total += new TextEncoder().encode(text).length;
      if (total > BUNDLE_MAX_TOTAL_BYTES) {
        return { ok: false, error: `bundle exceeds the ${(BUNDLE_MAX_TOTAL_BYTES / 1e6).toFixed(0)}MB decoded limit.`, notices: [] };
      }
      if (new TextEncoder().encode(text).length > BUNDLE_MAX_FILE_BYTES) {
        return { ok: false, error: `file ${i + 1} (${f.name}) exceeds the ${(BUNDLE_MAX_FILE_BYTES / 1e6).toFixed(0)}MB per-file limit.`, notices: [] };
      }
      if (text.length !== f.bytes && new TextEncoder().encode(text).length !== f.bytes) {
        return { ok: false, error: `file ${i + 1} (${f.name}): content length ${text.length} does not match recorded bytes ${f.bytes}.`, notices: [] };
      }
    }
    files.push(f as BundleFileEntry);
  }

  const bundle = JSON.parse(JSON.stringify(parsed)) as ReplayBundle;
  bundle.manifest.imported = true;
  const notices: string[] = [
    "imported bundle is user-supplied evidence — verified digests prove file " +
    "contents match their inventory, not that the claimed run occurred.",
    ...(files.every((f) => f.contentBase64 === undefined)
      ? ["metadata-only bundle — original CSV bytes are absent; replay is not possible."]
      : []),
  ];
  return { ok: true, bundle, notices };
}

// ---------------------------------------------------------------------------
// Verification — file integrity, dataset identity, manifest integrity,
// provenance: kept as separate dimensions.
// ---------------------------------------------------------------------------

export type BundleCheckStatus =
  | "verified" | "matched" | "mismatch" | "partial" | "unverifiable";

export interface BundleCheck {
  name: string;
  status: BundleCheckStatus;
  detail: string;
}

export interface BundleVerification {
  fileIntegrity: BundleCheckStatus;
  datasetIdentity: BundleCheckStatus;
  manifestIntegrity: BundleCheckStatus;
  overall: BundleCheckStatus;
  checks: BundleCheck[];
  /** Reasons replay is NOT possible — empty list ⇒ eligible. */
  ineligible: string[];
  imported: boolean;
}

const bundleText = (f: BundleFileEntry): string | undefined =>
  f.contentBase64 === undefined ? undefined : decodeContent(f.contentBase64);

/**
 * Rebuild the canonical upload form from verified bundle contents. Callers
 * feed this to parseUploadForm or POST it to /api/compare/strategies — the
 * replay path is the canonical pipeline, never a reimplementation.
 */
export function reconstructForm(bundle: ReplayBundle): FormData {
  const form = new FormData();
  for (const f of bundle.files) {
    const text = bundleText(f);
    if (text === undefined) continue;
    form.append("files", new File([text], f.name, { type: "text/csv" }));
  }
  form.set("meta", JSON.stringify(bundle.files.map((f) => ({
    ...(f.timeframe !== undefined ? { timeframe: f.timeframe } : {}),
    ...(f.is24x7 !== undefined ? { is24x7: f.is24x7 } : {}),
  }))));
  form.set("symbol", bundle.inputs.symbol);
  form.set("anchor", bundle.inputs.anchor);
  if (bundle.inputs.htf !== undefined) form.set("htf", bundle.inputs.htf);
  if (bundle.inputs.etf !== undefined) form.set("etf", bundle.inputs.etf);
  form.set("config", JSON.stringify(bundle.shared));
  form.set("strategies", JSON.stringify(bundle.strategies.map((s) => ({
    id: s.id,
    ...(s.label !== undefined ? { label: s.label } : {}),
    engineConfig: s.engineConfig,
    ...(s.selection !== undefined ? { selection: s.selection } : {}),
  }))));
  return form;
}

/**
 * Verify a bundle end-to-end. Dimensions stay separate:
 *  - fileIntegrity: every included file's content matches its recorded digest.
 *  - datasetIdentity: files re-parsed through the CANONICAL upload pipeline
 *    reproduce the manifest's datasetFingerprint — same code as the original
 *    fingerprint, never a parallel hash.
 *  - manifestIntegrity: rm1 digest re-verified.
 */
export async function verifyBundle(bundle: ReplayBundle): Promise<BundleVerification> {
  const checks: BundleCheck[] = [];
  const ineligible: string[] = [];
  const imported = bundle.manifest.imported === true ||
    bundle.manifest.contents.provenance === "imported";

  // ---- file integrity ----
  const withContent = bundle.files.filter((f) => f.contentBase64 !== undefined);
  let fileIntegrity: BundleCheckStatus = "unverifiable";
  if (bundle.files.length === 0) {
    checks.push({ name: "file-inventory", status: "unverifiable",
      detail: "no files in bundle inventory — metadata-only export." });
    ineligible.push("no original upload bytes — metadata-only bundle.");
  } else if (withContent.length !== bundle.files.length) {
    fileIntegrity = "partial";
    checks.push({ name: "file-inventory", status: "partial",
      detail: `${withContent.length}/${bundle.files.length} inventory entries carry content.` });
    ineligible.push(`${bundle.files.length - withContent.length} file(s) lack content — cannot verify or replay.`);
  } else {
    const bad = bundle.files.filter((f) => sha256Hex(bundleText(f) ?? "") !== f.sha256);
    fileIntegrity = bad.length === 0 ? "verified" : "mismatch";
    checks.push({
      name: "file-inventory",
      status: fileIntegrity,
      detail: bad.length === 0
        ? `all ${bundle.files.length} file(s) match their recorded sha256.`
        : `content tampered: ${bad.map((f) => f.name).join(", ")} — recorded digests do not match contents.`,
    });
    if (bad.length > 0) ineligible.push("file contents do not match recorded digests.");
  }

  // ---- manifest integrity ----
  const mv = verifyManifest(bundle.manifest);
  const manifestIntegrity: BundleCheckStatus =
    mv.integrity === "integrity-verified" ? "verified" :
    mv.integrity === "mismatch" ? "mismatch" : "unverifiable";
  checks.push({
    name: "manifest-digest",
    status: manifestIntegrity,
    detail: mv.checks[0]?.detail ?? "manifest digest check unavailable.",
  });

  // ---- dataset identity — replay the canonical parse path ----
  let datasetIdentity: BundleCheckStatus = "unverifiable";
  const recorded = bundle.manifest.contents.datasetFingerprint;
  if (fileIntegrity !== "verified") {
    checks.push({ name: "dataset-identity", status: "unverifiable",
      detail: "dataset identity cannot be recomputed without verified file contents." });
    ineligible.push("dataset identity unverifiable without intact file contents.");
  } else if (recorded === undefined) {
    datasetIdentity = "unverifiable";
    checks.push({ name: "dataset-identity", status: "unverifiable",
      detail: "manifest records no datasetFingerprint — nothing to compare." });
    ineligible.push("manifest lacks a recorded dataset fingerprint.");
  } else {
    try {
      const form = reconstructForm(bundle);
      const parsed = await parseUploadForm(form);
      if (!parsed.ok) {
        datasetIdentity = "unverifiable";
        checks.push({ name: "dataset-identity", status: "unverifiable",
          detail: `canonical upload pipeline rejected the bundle files: ${(parsed.body as { error?: { message?: string } })?.error?.message ?? "parse failed"}` });
        ineligible.push("bundle files fail the canonical CSV/MTF integrity gate.");
      } else {
        const recomputed = datasetFingerprintDigest(parsed.upload.cells).toString("hex");
        datasetIdentity = recomputed === recorded ? "matched" : "mismatch";
        checks.push({
          name: "dataset-identity",
          status: datasetIdentity,
          detail: datasetIdentity === "matched"
            ? `recomputed datasetFingerprint ${recomputed.slice(0, 16)}… matches the manifest.`
            : `recomputed ${recomputed.slice(0, 16)}… ≠ recorded ${recorded.slice(0, 16)}… — inputs differ from what the manifest describes.`,
        });
        if (datasetIdentity === "mismatch") {
          ineligible.push("recomputed dataset identity contradicts the manifest.");
        }
      }
    } catch (e) {
      checks.push({ name: "dataset-identity", status: "unverifiable",
        detail: `identity recomputation failed: ${e instanceof Error ? e.message : "unknown error"}` });
      ineligible.push("dataset identity recomputation failed.");
    }
  }

  // ---- replay eligibility prerequisites beyond file/data checks ----
  if (bundle.inputs.symbol.trim() === "") ineligible.push("bundle lacks the run symbol.");
  if (bundle.inputs.anchor.trim() === "") ineligible.push("bundle lacks the anchor timeframe.");
  if (bundle.strategies.length < 2) ineligible.push("bundle carries fewer than 2 strategy snapshots.");

  const overall: BundleCheckStatus =
    [fileIntegrity, datasetIdentity, manifestIntegrity].includes("mismatch") ? "mismatch" :
    [fileIntegrity, datasetIdentity, manifestIntegrity].includes("unverifiable") ? "unverifiable" :
    [fileIntegrity, datasetIdentity, manifestIntegrity].includes("partial") ? "partial" :
    "verified";

  return { fileIntegrity, datasetIdentity, manifestIntegrity, overall, checks, ineligible, imported };
}

// ---------------------------------------------------------------------------
// Replay comparison — recorded vs replayed, side by side, never merged.
// ---------------------------------------------------------------------------

export interface ReplayFieldReport {
  field: string;
  recorded: unknown;
  replayed: unknown;
  status: "match" | "different" | "incomparable";
}

export interface ReplayComparisonReport {
  fingerprintMatch: boolean;
  datasetIdentityMatch: boolean;
  fields: ReplayFieldReport[];
  note: string;
}

const field = (name: string, a: unknown, b: unknown): ReplayFieldReport => ({
  field: name,
  recorded: a,
  replayed: b,
  status: a === undefined || b === undefined ? "incomparable"
    : stableStringify(a ?? null) === stableStringify(b ?? null) ? "match" : "different",
});

/**
 * Compare a replayed comparison result against the manifest's recorded
 * claims. Exact matches are reported as matches — never as proof that every
 * intermediate calculation was identical.
 */
export function compareReplay(
  bundle: ReplayBundle,
  replayed: StrategyComparisonResult,
): ReplayComparisonReport {
  const m = bundle.manifest;
  const fields: ReplayFieldReport[] = [
    field("experiment fingerprint", m.contents.fingerprint, replayed.fingerprint),
    field("dataset fingerprint", m.contents.datasetFingerprint, replayed.datasetFingerprint),
    field("protocol", `${m.contents.protocolVersion}/${m.contents.contractVersion}`,
      `${replayed.protocolVersion}/${replayed.contractVersion}`),
    field("shared settings", m.contents.shared, replayed.shared),
    field("datasets", m.contents.datasets, replayed.datasets),
  ];
  const byId = new Map(replayed.strategies.map((s) => [s.id, s]));
  for (const s of m.contents.strategies) {
    const r = byId.get(s.id);
    if (r === undefined) {
      fields.push({ field: `strategy ${s.id}`, recorded: s.resultFingerprint,
        replayed: undefined, status: "incomparable" });
      continue;
    }
    fields.push(field(`strategy ${s.id} result fingerprint`, s.resultFingerprint, r.result.fingerprint));
    fields.push(field(`strategy ${s.id} realized n`, s.row.realizedCount, r.row.realizedCount));
    fields.push(field(`strategy ${s.id} realized WR`, s.row.realizedWinRate, r.row.realizedWinRate));
    fields.push(field(`strategy ${s.id} realized E[R]`, s.row.realizedExpectancyR, r.row.realizedExpectancyR));
    // Same cohort shape buildRecord uses — name/scenarioCount plus purge
    // counts only when a purge record exists; key presence is part of the
    // canonical form, so a different shape would report a false difference.
    fields.push(field(`strategy ${s.id} cohorts`, s.cohorts,
      (r.result.splits ?? []).map((sp) => ({
        name: sp.name,
        scenarioCount: sp.aggregate?.scenarioCount,
        ...(sp.purged !== undefined ? {
          purgedCount: sp.purged.purgedCount,
          retainedCount: sp.purged.retainedCount,
        } : {}),
      }))));
  }
  const fingerprintMatch = replayed.fingerprint === m.contents.fingerprint;
  const datasetIdentityMatch = recordedMatch(m.contents.datasetFingerprint, replayed.datasetFingerprint);
  return {
    fingerprintMatch,
    datasetIdentityMatch,
    fields,
    note:
      "Matching aggregates or fingerprints mean the replayed run reproduced the " +
      "recorded inputs and outputs — not a proof that every intermediate " +
      "calculation or the original execution is identical.",
  };
}

const recordedMatch = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && a === b;
