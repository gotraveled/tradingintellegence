/**
 * Reproducibility manifest (rm1) — deterministic tests for manifest creation,
 * digest integrity, verification outcomes, classified diffs, and safe imports.
 * Fixtures reuse the registry's hand-made result shapes — the manifest is a
 * snapshot over canonical record fields, never a re-computation of outcomes.
 */
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../engine-defaults";
import { sha256Hex } from "../sha256";
import { stableStringify } from "../strategy-comparison";
import {
  buildRecord,
  register,
  type ExperimentRecord,
} from "../experiment-registry";
import {
  buildManifest,
  classifyDiffPath,
  diffManifests,
  exportManifest,
  exportVerification,
  importManifest,
  MANIFEST_SCHEMA_VERSION,
  verifyManifest,
} from "../reproducibility";
import type { StrategyComparisonResult } from "../strategy-comparison";
import type { ComparisonStrategy } from "../strategy-comparison";

// ---------------------------------------------------------------------------
// Fixtures — mirrors the registry test file's minimal result shape.
// ---------------------------------------------------------------------------

const T0 = "2026-01-01T00:00:00.000Z";

const fakeResult = (over: Partial<StrategyComparisonResult> = {}): StrategyComparisonResult => ({
  protocolVersion: "comp-v1",
  contractVersion: "hv1",
  fingerprint: "f".repeat(64),
  datasetFingerprint: "d".repeat(64),
  datasets: [{ symbol: "AAA", timeframe: "1m", bars: 40, firstBar: T0, lastBar: "2026-01-01T00:39:00.000Z" }],
  shared: { horizonBars: 25, split: { trainPct: 0.5, validationPct: 0.34 } },
  strategies: [
    {
      id: "alpha", label: "alpha", configVersion: "v1-engine",
      engineConfig: { ...defaultConfig(), version: "v-a" },
      row: {
        id: "alpha", label: "alpha", configVersion: "v1-engine", fingerprint: "a".repeat(64),
        scenarioCount: 2, filledCount: 2, counts: {} as never,
        realizedCount: 2, realizedWins: 2, realizedLosses: 0, realizedBreakevens: 0,
        mtmCount: 0, realizedWinRate: 1, realizedExpectancyR: 2.4,
      },
      result: {
        fingerprint: "a".repeat(64),
        splits: [
          { name: "train", anchorFrom: T0, anchorTo: "2026-01-01T00:08:00.000Z", aggregate: { scenarioCount: 1 } },
          { name: "test", anchorFrom: "2026-01-01T00:10:00.000Z", anchorTo: "2026-01-01T00:20:00.000Z", aggregate: { scenarioCount: 1 } },
        ],
        methodology: { uncertaintyMethod: "moving-block bootstrap (2000 resamples, seed 42)" },
      } as never,
    },
    {
      id: "beta", label: "beta", configVersion: "v1-engine",
      engineConfig: { ...defaultConfig(), version: "v-b" },
      row: {
        id: "beta", label: "beta", configVersion: "v1-engine", fingerprint: "b".repeat(64),
        scenarioCount: 2, filledCount: 1, counts: {} as never,
        realizedCount: 1, realizedWins: 0, realizedLosses: 1, realizedBreakevens: 0,
        mtmCount: 0, realizedWinRate: 0, realizedExpectancyR: -1.2,
      },
      result: {
        fingerprint: "b".repeat(64),
        splits: [
          { name: "train", anchorFrom: T0, anchorTo: "2026-01-01T00:08:00.000Z", aggregate: { scenarioCount: 1 } },
          { name: "test", anchorFrom: "2026-01-01T00:10:00.000Z", anchorTo: "2026-01-01T00:20:00.000Z", aggregate: { scenarioCount: 1 } },
        ],
        methodology: { uncertaintyMethod: "moving-block bootstrap (2000 resamples, seed 42)" },
      } as never,
    },
  ],
  perInstrument: [],
  methodology: { comparison: "comp-v1 rules", ranking: "no ranking", uncertainty: "mvb" },
  testCohort: { evaluated: true, enforceable: false, note: "n" },
  warnings: [],
  fairness: [],
  evaluatedAt: T0,
  ...over,
});

const strategies = (): ComparisonStrategy[] => [
  { id: "alpha", label: "alpha", engineConfig: { ...defaultConfig(), version: "v-a" } },
  { id: "beta", label: "beta", engineConfig: { ...defaultConfig(), version: "v-b" } },
];

const rec = (over: {
  fingerprint?: string; datasetFingerprint?: string; createdAt?: string;
  shared?: StrategyComparisonResult["shared"]; strategies?: ComparisonStrategy[];
} = {}): ExperimentRecord =>
  buildRecord({
    result: fakeResult({
      ...(over.fingerprint !== undefined ? { fingerprint: over.fingerprint } : {}),
      ...(over.datasetFingerprint !== undefined ? { datasetFingerprint: over.datasetFingerprint } : {}),
      ...(over.shared !== undefined ? { shared: over.shared } : {}),
    }),
    strategies: over.strategies ?? strategies(),
    createdAt: over.createdAt ?? "2026-02-01T00:00:00.000Z",
  });

// ---------------------------------------------------------------------------
// Manifest creation + digest.
// ---------------------------------------------------------------------------

describe("manifest creation", () => {
  it("produces a stable manifest + digest from a record — identical input, identical output", () => {
    const r = rec();
    const a = buildManifest(r);
    const b = buildManifest(r);
    expect(a).toEqual(b);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.manifestVersion).toBe(MANIFEST_SCHEMA_VERSION);
    // Digest binds the canonical contents — same serialization as fingerprints use.
    expect(a.digest).toBe(sha256Hex(stableStringify(a.contents)));
  });

  it("snapshot carries canonical identities, not invented metadata", () => {
    const m = buildManifest(rec());
    expect(m.contents.fingerprint).toBe("f".repeat(64));
    expect(m.contents.datasetFingerprint).toBe("d".repeat(64));
    expect(m.contents.series).toEqual(["AAA@1m"]);
    expect(m.contents.resultFingerprints).toEqual([
      { strategyId: "alpha", fingerprint: "a".repeat(64) },
      { strategyId: "beta", fingerprint: "b".repeat(64) },
    ]);
    expect(m.contents.exposure.status).toBe("unknown"); // placeholder exposure — recorded, not asserted
    expect(m.availability.datasetIdentity).toBe("recorded");
    expect(m.availability.consumedWindows).toBe("unavailable"); // fixture has no scenarios
  });

  it("legacy records without optional fields flag them as unavailable", () => {
    const r = rec();
    r.datasetFingerprint = undefined;
    r.testPeriod = undefined;
    const m = buildManifest(r);
    expect(m.availability.datasetIdentity).toBe("unavailable");
    expect(m.availability.testPeriod).toBe("unavailable");
    expect(m.contents.datasetFingerprint).toBeUndefined();
  });
});

describe("manifest verification", () => {
  it("integrity-verified for an untouched local manifest", () => {
    const r = register([], rec()).record;
    const m = buildManifest(r);
    const v = verifyManifest(m, { record: r });
    expect(v.integrity).toBe("integrity-verified");
    expect(v.inputIdentity).toBe("input-identity-matched");
    expect(v.overall).toBe("input-identity-matched");
    expect(v.caveat).toContain("does not prove");
  });

  it("tampered contents → mismatch", () => {
    const r = rec();
    const m = buildManifest(r);
    m.contents.shared = { ...m.contents.shared, horizonBars: 99 };
    const v = verifyManifest(m, { record: r });
    expect(v.integrity).toBe("mismatch");
    expect(v.overall).toBe("mismatch");
  });

  it("no source supplied → input identity unverifiable, digest still checkable", () => {
    const m = buildManifest(rec());
    const v = verifyManifest(m);
    expect(v.integrity).toBe("integrity-verified");
    expect(v.inputIdentity).toBe("unverifiable");
    expect(v.overall).toBe("unverifiable");
  });

  it("manifest describing a different record → input-identity mismatch", () => {
    const a = register([], rec()).record;
    const b = register([], rec({ fingerprint: "2".repeat(64), createdAt: "2026-02-02T00:00:00.000Z" })).record;
    const m = buildManifest(a);
    const v = verifyManifest(m, { record: b });
    expect(v.inputIdentity).toBe("mismatch");
    expect(v.overall).toBe("mismatch");
  });

  it("imported manifests are capped — a valid digest is never engine-verified", () => {
    const r = register([], rec()).record;
    const out = importManifest(exportManifest(buildManifest(r)));
    expect(out.ok).toBe(true);
    const v = verifyManifest(out.manifest!, { record: r });
    expect(v.imported).toBe(true);
    // Digest is internally consistent, identities match the source — but the
    // file is user-supplied, so overall can claim at most integrity-verified.
    expect(v.integrity).toBe("integrity-verified");
    expect(v.inputIdentity).toBe("input-identity-matched");
    expect(v.overall).toBe("integrity-verified");
    expect(v.caveat).toContain("user-supplied");
  });

  it("unsupported manifestVersion → integrity unverifiable, not reinterpreted", () => {
    const r = register([], rec()).record;
    const out = importManifest(exportManifest(buildManifest(r)));
    out.manifest!.manifestVersion = "rm99" as never;
    const v = verifyManifest(out.manifest!, { record: r });
    expect(v.integrity).toBe("unverifiable");
    expect(v.checks[0].detail).toContain("rm99");
  });

  it("fabricated provenance claims cannot masquerade as local output", () => {
    const r = register([], rec()).record;
    const m = buildManifest(r);
    m.contents.provenance = "local"; // forge a "local" claim on an imported file
    const out = importManifest(exportManifest(m));
    // The claim is preserved verbatim — but the undigested `imported` flag
    // records that the file arrived as user input, capping verification.
    expect(out.manifest!.imported).toBe(true);
    expect(out.manifest!.contents.provenance).toBe("local"); // claim preserved, not sanitized
    const v = verifyManifest(out.manifest!, { record: r });
    expect(v.imported).toBe(true);
    expect(v.overall).not.toBe("input-identity-matched"); // never engine-verified
  });
});

describe("manifest import safety", () => {
  it("malformed JSON → error, never throws", () => {
    const out = importManifest("not json {{{");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("not valid JSON");
  });

  it("wrong format → error", () => {
    const out = importManifest(JSON.stringify({ format: "something-else", records: [] }));
    expect(out.ok).toBe(false);
    expect(out.error).toContain("unrecognized");
  });

  it("unsupported version → returned for inspection with a notice", () => {
    const m = buildManifest(rec());
    m.manifestVersion = "rm2" as never;
    const out = importManifest(exportManifest(m));
    expect(out.ok).toBe(true);
    expect(out.notices.some((n) => n.includes("rm2"))).toBe(true);
  });
});

describe("run-to-run diff", () => {
  it("identical manifests → empty diff", () => {
    const r = register([], rec()).record;
    expect(diffManifests(buildManifest(r), buildManifest(r))).toEqual([]);
  });

  it("changed strategy settings, unchanged dataset → strategy + result categories", () => {
    const a = register([], rec()).record;
    const tweaked = strategies();
    (tweaked[0].engineConfig as { version?: string }).version = "v-a2";
    const b = register([], rec({ fingerprint: "3".repeat(64), createdAt: "2026-02-03T00:00:00.000Z", strategies: tweaked })).record;
    const diff = diffManifests(buildManifest(a), buildManifest(b));
    const cats = new Set(diff.map((d) => d.category));
    expect(diff.some((d) => d.category === "strategy" && d.path.includes("version"))).toBe(true);
    expect(cats.has("input")).toBe(false);           // dataset identity unchanged
    expect(diff.some((d) => d.path === "datasets")).toBe(false);
  });

  it("changed dataset identity, unchanged strategy → input category", () => {
    const a = register([], rec()).record;
    const b = register([], rec({
      fingerprint: "4".repeat(64), datasetFingerprint: "e".repeat(64),
      createdAt: "2026-02-04T00:00:00.000Z",
    })).record;
    const diff = diffManifests(buildManifest(a), buildManifest(b));
    expect(diff.some((d) => d.category === "input" && d.path === "datasetFingerprint")).toBe(true);
  });

  it("exposure metadata change → provenance category, fingerprint untouched", () => {
    const a = register([], rec()).record;
    const b = JSON.parse(JSON.stringify(a)) as ExperimentRecord;
    b.exposure = { ...b.exposure, status: "exposed", coverage: "full" };
    const diff = diffManifests(buildManifest(a), buildManifest(b));
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.every((d) => d.category === "provenance" || d.path === "exposure.status" || d.path.startsWith("exposure"))).toBe(true);
    expect(a.fingerprint).toBe(b.fingerprint); // canonical fingerprint unchanged
    expect(diff.some((d) => d.path === "exposure.status")).toBe(true);
  });

  it("diff output is deterministic — same inputs, identical report", () => {
    const a = register([], rec()).record;
    const b = register([], rec({ fingerprint: "5".repeat(64), createdAt: "2026-02-05T00:00:00.000Z" })).record;
    expect(diffManifests(buildManifest(a), buildManifest(b)))
      .toEqual(diffManifests(buildManifest(a), buildManifest(b)));
  });
});

describe("diff path classification", () => {
  it("maps registry + manifest paths to the documented categories", () => {
    expect(classifyDiffPath("datasets")).toBe("input");
    expect(classifyDiffPath("datasetFingerprint")).toBe("input");
    expect(classifyDiffPath("shared.horizonBars")).toBe("protocol");
    expect(classifyDiffPath("protocolVersion")).toBe("protocol");
    expect(classifyDiffPath("strategies.alpha.engineConfig.version")).toBe("strategy");
    expect(classifyDiffPath("strategy.alpha.selection")).toBe("strategy");
    expect(classifyDiffPath("strategies.beta.row.realizedWinRate")).toBe("result");
    expect(classifyDiffPath("exposure.status")).toBe("provenance");
    expect(classifyDiffPath("consumedWindows")).toBe("provenance");
    expect(classifyDiffPath("fingerprint")).toBe("provenance");
  });
});

describe("verification report export", () => {
  it("export is deterministic — same report, identical bytes", () => {
    const r = register([], rec()).record;
    const v = verifyManifest(buildManifest(r), { record: r });
    expect(exportVerification(v)).toBe(exportVerification(v));
  });
});
