/**
 * Serving-scope + displayBlock — the public-serving licensing boundary (M2).
 * Pure contract tests: no provider traffic, no env mutation beyond the
 * functions' explicit parameters.
 */
import { describe, expect, it } from "vitest";
import {
  displayBlock,
  resolveServingScope,
  type ServingScope,
} from "../providers/serving";
import type { ProviderCapability } from "../providers/capabilities";
import { CANONICAL_TIMEFRAMES } from "../providers/capabilities";

const CAP = (displayRights: ProviderCapability["displayRights"]): ProviderCapability => ({
  providerId: "vendor-x",
  markets: ["us-stocks"],
  technicalTimeframes: CANONICAL_TIMEFRAMES,
  entitledTimeframes: CANONICAL_TIMEFRAMES,
  classification: "delayed",
  confidence: "declared",
  displayRights,
  note: "test row",
});

describe("resolveServingScope — the documented boundary, fail-closed in production", () => {
  it("explicit env wins", () => {
    expect(resolveServingScope("public", "development")).toBe("public");
    expect(resolveServingScope("internal", "production")).toBe("internal");
    expect(resolveServingScope(" PUBLIC ", "development")).toBe("public");
  });

  it("unset → public under production, internal elsewhere", () => {
    expect(resolveServingScope(undefined, "production")).toBe("public");
    expect(resolveServingScope("", "production")).toBe("public");
    expect(resolveServingScope(undefined, "development")).toBe("internal");
    expect(resolveServingScope(undefined, "test")).toBe("internal");
    expect(resolveServingScope(undefined, undefined)).toBe("internal");
  });

  it("unrecognized values resolve by NODE_ENV, never by guessing public", () => {
    expect(resolveServingScope("yes-plz", "production")).toBe("public");
    expect(resolveServingScope("yes-plz", "development")).toBe("internal");
  });
});

describe("displayBlock — rights are enforced, not declared", () => {
  const scopes: ServingScope[] = ["public", "internal"];

  it("public + authorized → serves", () => {
    expect(displayBlock(CAP("authorized"), "public")).toBeUndefined();
  });

  it("public + unknown → fail closed with display_not_authorized", () => {
    const block = displayBlock(CAP("unknown"), "public");
    expect(block).toMatchObject({
      ok: false,
      error: { code: "display_not_authorized" },
    });
    if (block && !block.ok) {
      expect(block.error.message).toMatch(/not been established/i);
      expect(block.error.message).toMatch(/paid plan|API key/i); // why access ≠ authorization
    }
  });

  it("public + not_authorized → fail closed with the terms explanation", () => {
    const block = displayBlock(CAP("not_authorized"), "public");
    expect(block).toMatchObject({
      ok: false,
      error: { code: "display_not_authorized" },
    });
    if (block && !block.ok) {
      expect(block.error.message).toMatch(/terms do not permit/i);
    }
  });

  it("internal scope never blocks on rights — capability gates still apply elsewhere", () => {
    for (const rights of ["authorized", "unknown", "not_authorized"] as const) {
      expect(displayBlock(CAP(rights), "internal")).toBeUndefined();
    }
    // Sanity: the parameter matrix is symmetric — only (public, non-authorized) blocks.
    for (const scope of scopes) {
      for (const rights of ["authorized", "unknown", "not_authorized"] as const) {
        const blocked = displayBlock(CAP(rights), scope) !== undefined;
        expect(blocked).toBe(scope === "public" && rights !== "authorized");
      }
    }
  });
});
