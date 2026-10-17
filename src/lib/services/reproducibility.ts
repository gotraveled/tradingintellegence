/**
 * Research Reproducibility & Audit Trail (rm1) — additive manifest layer over
 * the experiment registry. A manifest is a *snapshot claim*: it packages the
 * canonical fields already recorded by the registry and binds them to a
 * SHA-256 digest over the same stableStringify canonical serialization used
 * by the comparison fingerprint.
 *
 * Integrity boundaries, stated verbatim in every report:
 *  - A valid digest proves only that the manifest contents have not changed
 *    relative to that digest. It does NOT prove the run occurred, that the
 *    market data is authentic, or that the engine executed correctly.
 *  - Imported manifests remain user-supplied evidence — a valid digest on an
 *    imported manifest proves only that the file is internally consistent.
 *  - No field is invented. Unavailable data is flagged, never reconstructed.
 */
import { sha256Hex } from "./sha256";
import { stableStringify } from "./strategy-comparison";
import {
  diffValue,
  type ConsumedWindow,
  type ExperimentRecord,
  type ExposureReport,
  type PeriodRange,
  type RecordDiff,
} from "./experiment-registry";
import type {
  ComparisonSharedConfig,
  StrategyComparisonResult,
} from "./strategy-comparison";
import type { RecordedStrategy } from "./experiment-registry";

export const MANIFEST_SCHEMA_VERSION = "rm1";
export const MANIFEST_FORMAT = "ti-reproducibility-manifest";

// ---------------------------------------------------------------------------
// Manifest — versioned snapshot of canonical record evidence.
// ---------------------------------------------------------------------------

/** Per-dimension availability — unavailable fields are explicit, not absent. */
export interface ManifestAvailability {
  datasetIdentity: "recorded" | "unavailable";
  evaluationRange: "recorded" | "unavailable";
  testPeriod: "recorded" | "unavailable";
  consumedWindows: "recorded" | "partial" | "unavailable";
  engineConfigSnapshots: "recorded" | "unavailable";
}

/** Canonical manifest contents — everything the digest binds. */
export interface ManifestContents {
  recordId: string;
  fingerprint: string;
  protocolVersion: string;
  contractVersion: string;
  provenance: "local" | "imported";
  createdAt: string;
  datasetFingerprint?: string;
  /** `${symbol}@${timeframe}` identities — the only axis on which bar indices
   *  are comparable. */
  series: string[];
  datasets: StrategyComparisonResult["datasets"];
  evaluationRange?: PeriodRange;
  testPeriod?: PeriodRange;
  shared: ComparisonSharedConfig;
  /** Full engine-config + selection snapshots — enough to reconstruct inputs. */
  strategies: RecordedStrategy[];
  /** Per-strategy hv1 result fingerprints — result-identity references, never
   *  result claims the manifest itself asserts. */
  resultFingerprints: { strategyId: string; fingerprint: string }[];
  consumedWindows?: ConsumedWindow[];
  unverifiableWindows?: number;
  exposure: ExposureReport;
  uncertaintyMethod?: string;
}

export interface ReproducibilityManifest {
  format: typeof MANIFEST_FORMAT;
  manifestVersion: typeof MANIFEST_SCHEMA_VERSION;
  contents: ManifestContents;
  /** sha256(stableStringify(contents)) — binds the canonical snapshot. */
  digest: string;
  availability: ManifestAvailability;
  /** Set by importManifest — marks the file as user-supplied evidence WITHOUT
   *  mutating digested contents (rewriting contents.provenance would break the
   *  recorded digest and hide the file's own provenance claim). */
  imported?: boolean;
  /** Honest capability statement — rendered verbatim, never paraphrased. */
  limitation: string;
}

export const MANIFEST_LIMITATION =
  "A valid digest proves the manifest contents are unchanged relative to that " +
  "digest — it does not prove the run occurred, that market data is authentic, " +
  "or that the engine executed correctly. Imported manifests are user-supplied " +
  "evidence, not engine-verified output.";

/** Build a manifest from a registry record — pure, no wall-clock injected
 *  (createdAt comes from the record itself). */
export function buildManifest(record: ExperimentRecord): ReproducibilityManifest {
  const contents: ManifestContents = {
    recordId: record.recordId,
    fingerprint: record.fingerprint,
    protocolVersion: record.protocolVersion,
    contractVersion: record.contractVersion,
    provenance: record.provenance,
    createdAt: record.createdAt,
    ...(record.datasetFingerprint !== undefined
      ? { datasetFingerprint: record.datasetFingerprint } : {}),
    series: record.datasets.map((d) => `${d.symbol}@${d.timeframe}`).sort(),
    datasets: record.datasets,
    ...(record.evaluationRange !== undefined
      ? { evaluationRange: record.evaluationRange } : {}),
    ...(record.testPeriod !== undefined ? { testPeriod: record.testPeriod } : {}),
    shared: record.shared,
    strategies: record.strategies,
    resultFingerprints: record.strategies
      .map((s) => ({ strategyId: s.id, fingerprint: s.resultFingerprint }))
      .sort((a, b) => a.strategyId.localeCompare(b.strategyId)),
    ...(record.consumedWindows !== undefined
      ? { consumedWindows: record.consumedWindows } : {}),
    ...(record.unverifiableWindows !== undefined
      ? { unverifiableWindows: record.unverifiableWindows } : {}),
    exposure: record.exposure,
    ...(record.uncertaintyMethod !== undefined
      ? { uncertaintyMethod: record.uncertaintyMethod } : {}),
  };
  return {
    format: MANIFEST_FORMAT,
    manifestVersion: MANIFEST_SCHEMA_VERSION,
    contents,
    digest: sha256Hex(stableStringify(contents)),
    availability: {
      datasetIdentity: record.datasetFingerprint !== undefined ? "recorded" : "unavailable",
      evaluationRange: record.evaluationRange !== undefined ? "recorded" : "unavailable",
      testPeriod: record.testPeriod !== undefined ? "recorded" : "unavailable",
      consumedWindows:
        record.consumedWindows !== undefined
          ? (record.unverifiableWindows ?? 0) > 0 ? "partial" : "recorded"
          : "unavailable",
      engineConfigSnapshots:
        record.strategies.every((s) => s.engineConfig !== undefined &&
          Object.keys(s.engineConfig as object).length > 0)
          ? "recorded" : "unavailable",
    },
    limitation: MANIFEST_LIMITATION,
  };
}

/** Deterministic export — identical manifest ⇒ identical bytes. */
export function exportManifest(manifest: ReproducibilityManifest): string {
  return stableStringify(manifest);
}

export interface ManifestImportOutcome {
  ok: boolean;
  error?: string;
  manifest?: ReproducibilityManifest;
  notices: string[];
}

const isManifestShape = (m: unknown): m is ReproducibilityManifest => {
  const o = m as Record<string, unknown>;
  const c = o?.contents as Record<string, unknown> | undefined;
  return o !== null && typeof o === "object" &&
    o.format === MANIFEST_FORMAT &&
    typeof o.manifestVersion === "string" &&
    typeof o.digest === "string" &&
    c !== null && typeof c === "object" &&
    typeof c.recordId === "string" && typeof c.fingerprint === "string" &&
    Array.isArray(c.strategies);
};

/**
 * Parse a manifest import. Rules mirror registry import:
 *  - Malformed JSON / wrong format → actionable error, never throws.
 *  - Unsupported manifestVersion → imported flagged via notice; the manifest
 *    is still returned for inspection but marked unverifiable-version.
 *  - Every imported manifest is user-supplied evidence — a valid digest says
 *    only that the file is internally consistent.
 */
export function importManifest(json: string): ManifestImportOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "file is not valid JSON.", notices: [] };
  }
  if (!isManifestShape(parsed)) {
    return {
      ok: false,
      error: `unrecognized file — expected format "${MANIFEST_FORMAT}" with contents, digest and version fields.`,
      notices: [],
    };
  }
  const manifest: ReproducibilityManifest = JSON.parse(JSON.stringify(parsed));
  const notices: string[] = [
    "imported manifest is user-supplied evidence — a matching digest proves the " +
    "file is internally consistent, not that any run was executed by this engine.",
  ];
  if (manifest.manifestVersion !== MANIFEST_SCHEMA_VERSION) {
    notices.push(
      `manifestVersion "${manifest.manifestVersion}" is not supported by manifest ` +
      `schema ${MANIFEST_SCHEMA_VERSION} — displayed as unsupported, not reinterpreted.`,
    );
  }
  // Marked outside the digested contents — the file's own provenance claim is
  // preserved verbatim, while the flag records that it arrived as user input.
  manifest.imported = true;
  return { ok: true, manifest, notices };
}

// ---------------------------------------------------------------------------
// Verification — separate dimensions, never conflated.
// ---------------------------------------------------------------------------

export type VerificationOutcome =
  | "integrity-verified"      // canonical contents match recorded digest
  | "input-identity-matched"  // recorded identities match supplied source inputs
  | "partially-verifiable"    // some required evidence is unavailable
  | "mismatch"                // evidence contradicts recorded identity/digest
  | "unverifiable";           // insufficient evidence for the requested check

export interface VerificationCheck {
  name: string;
  outcome: VerificationOutcome;
  detail: string;
}

export interface VerificationReport {
  manifestVersion: string;
  /** Integrity of the manifest file itself. */
  integrity: VerificationOutcome;
  /** Identity of recorded inputs vs supplied sources — evaluated only when
   *  a source is provided. */
  inputIdentity: VerificationOutcome;
  /** Overall = worst of the evaluated dimensions. */
  overall: VerificationOutcome;
  /** True when the manifest was imported — caps the trust claim. */
  imported: boolean;
  checks: VerificationCheck[];
  caveat: string;
}

/** Sources the caller can verify identity against — e.g. the registry record
 *  this manifest claims to describe, or fresh engine output. */
export interface VerificationSources {
  /** Trusted (local, engine-produced) record the manifest claims to describe. */
  record?: ExperimentRecord;
}

/**
 * Verify a manifest. Digest integrity is always evaluated; input identity is
 * evaluated only against supplied sources (otherwise "unverifiable" — never
 * assumed). A manifest with provenance "imported" can reach at most
 * "integrity-verified" overall — never "input-identity-matched".
 */
export function verifyManifest(
  manifest: ReproducibilityManifest,
  sources: VerificationSources = {},
): VerificationReport {
  const checks: VerificationCheck[] = [];
  const imported = manifest.imported === true || manifest.contents.provenance === "imported";

  // ---- Dimension 1: digest integrity ----
  let integrity: VerificationOutcome;
  if (manifest.manifestVersion !== MANIFEST_SCHEMA_VERSION) {
    integrity = "unverifiable";
    checks.push({
      name: "manifest-version",
      outcome: "unverifiable",
      detail: `manifestVersion "${manifest.manifestVersion}" is not schema ${MANIFEST_SCHEMA_VERSION} — digest semantics unknown.`,
    });
  } else {
    const recomputed = sha256Hex(stableStringify(manifest.contents));
    integrity = recomputed === manifest.digest ? "integrity-verified" : "mismatch";
    checks.push({
      name: "manifest-digest",
      outcome: integrity,
      detail: integrity === "integrity-verified"
        ? `digest ${manifest.digest.slice(0, 16)}… matches canonical contents — file is internally consistent.`
        : `digest mismatch — recorded ${manifest.digest.slice(0, 16)}… vs recomputed ${recomputed.slice(0, 16)}… — contents were altered after signing.`,
    });
  }

  // ---- Dimension 2: input identity vs supplied source ----
  let inputIdentity: VerificationOutcome = "unverifiable";
  if (sources.record === undefined) {
    checks.push({
      name: "input-identity",
      outcome: "unverifiable",
      detail: "no source record supplied — recorded input identities cannot be checked.",
    });
  } else {
    const src = sources.record;
    const c = manifest.contents;
    const diffs: string[] = [];
    if (c.fingerprint !== src.fingerprint) diffs.push("experiment fingerprint");
    if ((c.datasetFingerprint ?? null) !== (src.datasetFingerprint ?? null)) diffs.push("dataset fingerprint");
    if (stableStringify(c.datasets) !== stableStringify(src.datasets)) diffs.push("dataset summaries");
    if (stableStringify(c.shared) !== stableStringify(src.shared)) diffs.push("shared evaluation settings");
    if (stableStringify(c.strategies.map((s) => ({ id: s.id, engineConfig: s.engineConfig, selection: s.selection ?? null })))
      !== stableStringify(src.strategies.map((s) => ({ id: s.id, engineConfig: s.engineConfig, selection: s.selection ?? null })))) {
      diffs.push("strategy configuration/selection");
    }
    const requiredMissing =
      (src.datasetFingerprint !== undefined && c.datasetFingerprint === undefined) ||
      (src.testPeriod !== undefined && c.testPeriod === undefined) ||
      (src.consumedWindows !== undefined && c.consumedWindows === undefined);
    if (diffs.length > 0) {
      inputIdentity = "mismatch";
      checks.push({
        name: "input-identity",
        outcome: "mismatch",
        detail: `contradicted identities: ${diffs.join(", ")} — the manifest does not describe this record.`,
      });
    } else if (requiredMissing) {
      inputIdentity = "partially-verifiable";
      checks.push({
        name: "input-identity",
        outcome: "partially-verifiable",
        detail: "recorded identities match where present, but the manifest lacks fields the source record contains.",
      });
    } else {
      inputIdentity = "input-identity-matched";
      checks.push({
        name: "input-identity",
        outcome: "input-identity-matched",
        detail: "recorded dataset and configuration identities match the supplied source record.",
      });
    }
  }

  // Overall = weakest link across both dimensions; the strongest claim
  // "input-identity-matched" requires BOTH checks at their best, and is capped
  // for imported manifests — user-supplied evidence can claim at most
  // "integrity-verified" even when its contents match a local record.
  const overall: VerificationOutcome =
    integrity === "mismatch" || inputIdentity === "mismatch" ? "mismatch" :
    integrity === "unverifiable" || inputIdentity === "unverifiable" ? "unverifiable" :
    inputIdentity === "partially-verifiable" ? "partially-verifiable" :
    inputIdentity === "input-identity-matched" && !imported ? "input-identity-matched" :
    "integrity-verified";

  return {
    manifestVersion: manifest.manifestVersion,
    integrity,
    inputIdentity,
    overall,
    imported,
    checks,
    caveat:
      "Verification checks this manifest's internal consistency and its match to " +
      "supplied inputs. It does not prove the original run occurred, that market " +
      "data is authentic, or that the engine executed correctly." +
      (imported ? " This manifest was imported — it remains user-supplied evidence." : ""),
  };
}

/** Deterministic export of a verification report. */
export function exportVerification(report: VerificationReport): string {
  return stableStringify(report);
}

// ---------------------------------------------------------------------------
// Run-to-run change report — classified diff, no causal claims.
// ---------------------------------------------------------------------------

export type ChangeCategory =
  | "input"                  // dataset identity, series, ranges
  | "protocol"               // shared evaluation settings, versions
  | "strategy"               // engineConfig/selection changes
  | "result"                 // metrics, cohorts, result fingerprints
  | "provenance";            // identity, exposure, verification status

export interface ClassifiedDiff extends RecordDiff {
  category: ChangeCategory;
}

/** Map a diff path to its change category — deterministic, order-independent. */
export function classifyDiffPath(path: string): ChangeCategory {
  const root = path.split(".")[0];
  if (root === "datasets" || root === "datasetFingerprint" || root === "series" ||
      root === "evaluationRange" || root === "testPeriod") return "input";
  if (root === "shared" || root === "protocolVersion" || root === "contractVersion" ||
      root === "uncertaintyMethod" || root === "configVersion") return "protocol";
  if (root === "recordId" || root === "fingerprint" || root === "provenance" ||
      root === "createdAt" || root === "exposure" || root === "consumedWindows" ||
      root === "unverifiableWindows" || root === "unsupported" ||
      root === "identityConflict" || root === "digest") return "provenance";
  if (root === "strategies" || root === "strategy") {
    // <id>.engineConfig|selection → strategy; row|cohorts|resultFingerprint → result.
    const leafPath = path.split(".").slice(2).join(".");
    if (leafPath === "engineConfig" || leafPath.startsWith("engineConfig.") ||
        leafPath === "selection" || leafPath.startsWith("selection.") ||
        leafPath === "" || leafPath === "label" || leafPath === "id") return "strategy";
    return "result";
  }
  if (root === "resultFingerprints") return "result";
  return "result";
}

/**
 * Deterministic classified diff between two manifests — identical manifests
 * ⇒ empty diff. Differences are reported without causal ranking: a changed
 * result is NOT attributed to any particular input change.
 */
export function diffManifests(
  a: ReproducibilityManifest,
  b: ReproducibilityManifest,
): ClassifiedDiff[] {
  const out: RecordDiff[] = [];
  // Diff every canonical content field except strategies (per-id below) and
  // digest (bound separately).
  const fields: (keyof ManifestContents)[] = [
    "fingerprint", "protocolVersion", "contractVersion", "provenance",
    "datasetFingerprint", "series", "datasets", "evaluationRange", "testPeriod",
    "shared", "resultFingerprints", "consumedWindows",
    "unverifiableWindows", "exposure", "uncertaintyMethod",
  ];
  for (const f of fields.sort()) {
    diffValue(f, a.contents[f] ?? null, b.contents[f] ?? null, out);
  }
  // Per-strategy-id diff — diffValue treats arrays as single leaves, so
  // strategies must be matched by id for granular engineConfig/selection paths.
  const aStrat = Object.fromEntries(a.contents.strategies.map((s) => [s.id, s]));
  const bStrat = Object.fromEntries(b.contents.strategies.map((s) => [s.id, s]));
  for (const id of [...new Set([...Object.keys(aStrat), ...Object.keys(bStrat)])].sort()) {
    diffValue(`strategies.${id}`, aStrat[id] ?? null, bStrat[id] ?? null, out);
  }
  return out
    .map((d) => ({ ...d, category: classifyDiffPath(d.path) }))
    .sort((x, y) => x.category.localeCompare(y.category) || x.path.localeCompare(y.path));
}
