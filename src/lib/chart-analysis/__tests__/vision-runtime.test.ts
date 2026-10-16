/**
 * Vision runtime status — every failure mode is a distinct, reportable state.
 * `fetch` is stubbed; no real Ollama is required. The deterministic report is
 * never presented as model output — only `state: "success"` yields a narrative.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeVisionRuntime,
  visionNarrativeDetailed,
  visionNarrative,
} from "../vision-runtime";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("probeVisionRuntime — configured vs reachable are separate facts", () => {
  it("not configured → configured:false, no fetch attempted", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const s = await probeVisionRuntime();
    expect(s.configured).toBe(false);
    expect(s.reachable).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("url without model → still not configured (no half-enabled probe)", async () => {
    vi.stubEnv("VISION_RUNTIME_URL", "http://localhost:11434");
    const s = await probeVisionRuntime();
    expect(s.configured).toBe(false);
  });

  it("reachable + model installed → both true", async () => {
    vi.stubEnv("VISION_RUNTIME_URL", "http://localhost:11434");
    vi.stubEnv("VISION_MODEL", "llava:13b");
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ models: [{ name: "llava:13b" }] })));
    const s = await probeVisionRuntime();
    expect(s.configured).toBe(true);
    expect(s.reachable).toBe(true);
    expect(s.models).toEqual(["llava:13b"]);
  });

  it("reachable but model missing → reachable true with an honest note", async () => {
    vi.stubEnv("VISION_RUNTIME_URL", "http://localhost:11434");
    vi.stubEnv("VISION_MODEL", "llava:13b");
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ models: [{ name: "qwen2:7b" }] })));
    const s = await probeVisionRuntime();
    expect(s.reachable).toBe(true);
    expect(s.note).toMatch(/not found/i);
  });

  it("HTTP error from /api/tags → configured but unreachable", async () => {
    vi.stubEnv("VISION_RUNTIME_URL", "http://localhost:11434");
    vi.stubEnv("VISION_MODEL", "m");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const s = await probeVisionRuntime();
    expect(s.configured).toBe(true);
    expect(s.reachable).toBe(false);
    expect(s.note).toMatch(/503/);
  });

  it("connection refused → unreachable with guidance, never an exception", async () => {
    vi.stubEnv("VISION_RUNTIME_URL", "http://localhost:11434");
    vi.stubEnv("VISION_MODEL", "m");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const s = await probeVisionRuntime();
    expect(s.reachable).toBe(false);
    expect(s.note).toMatch(/unreachable/i);
  });
});

describe("visionNarrativeDetailed — failure modes are visible", () => {
  const input = { imageBase64: "aGk=", factsSummary: "candles: 10" };
  const configure = () => {
    vi.stubEnv("VISION_RUNTIME_URL", "http://localhost:11434");
    vi.stubEnv("VISION_MODEL", "llava:13b");
  };

  it("not configured → not-configured (no attempt)", async () => {
    expect((await visionNarrativeDetailed(input)).state).toBe("not-configured");
  });

  it("success → text + runtime provenance", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ response: "  Trend looks intact.  " })));
    const out = await visionNarrativeDetailed(input);
    expect(out.state).toBe("success");
    if (out.state === "success") {
      expect(out.text).toBe("Trend looks intact.");
      expect(out.runtime).toContain("llava:13b");
    }
  });

  it("HTTP error → http-error with the status", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 500 })));
    const out = await visionNarrativeDetailed(input);
    expect(out).toEqual({ state: "http-error", status: 500 });
  });

  it("non-JSON body → invalid-response", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    expect((await visionNarrativeDetailed(input)).state).toBe("invalid-response");
  });

  it("JSON without response text → invalid-response", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ done: true })));
    expect((await visionNarrativeDetailed(input)).state).toBe("invalid-response");
  });

  it("timeout/abort → timeout state, not a generic failure", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn(async () => {
      const e = new Error("The operation timed out.");
      e.name = "TimeoutError";
      throw e;
    }));
    expect((await visionNarrativeDetailed(input)).state).toBe("timeout");
  });

  it("connection failure → not-reached with the reason", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const out = await visionNarrativeDetailed(input);
    expect(out.state).toBe("not-reached");
  });

  it("legacy wrapper returns undefined on failure — success only", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 500 })));
    expect(await visionNarrative(input)).toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ response: "ok" })));
    expect((await visionNarrative(input))?.text).toBe("ok");
  });
});
