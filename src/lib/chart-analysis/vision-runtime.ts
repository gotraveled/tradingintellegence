/**
 * Optional local vision runtime (Phase P1) — Ollama-style probe.
 *
 * Design rule: the deterministic pixel pipeline ALWAYS produces the report;
 * a local model is an optional narrative enrichment, never a requirement.
 * The probe is disabled unless the operator opts in via env:
 *
 *   VISION_RUNTIME_URL   — e.g. http://localhost:11434 (Ollama)
 *   VISION_MODEL         — e.g. llava:13b (must support image input)
 *
 * Detection is a GET /api/tags with a short timeout — "configured" and
 * "reachable" are reported separately so the UI can show honest setup
 * guidance. No images ever leave the machine: the only endpoint called is
 * the operator-configured local URL.
 */
export interface VisionRuntimeStatus {
  configured: boolean;
  reachable: boolean;
  url?: string;
  model?: string;
  models?: string[];
  note?: string;
}

const PROBE_TIMEOUT_MS = 2_000;
const GENERATE_TIMEOUT_MS = 30_000;

export function visionRuntimeConfig(): { url?: string; model?: string } {
  const url = process.env.VISION_RUNTIME_URL?.trim();
  const model = process.env.VISION_MODEL?.trim();
  return {
    ...(url ? { url: url.replace(/\/+$/, "") } : {}),
    ...(model ? { model } : {}),
  };
}

/** Probe the configured local runtime — never throws. */
export async function probeVisionRuntime(): Promise<VisionRuntimeStatus> {
  const { url, model } = visionRuntimeConfig();
  if (!url || !model) {
    return {
      configured: false,
      reachable: false,
      note:
        "No local vision runtime configured. Set VISION_RUNTIME_URL and VISION_MODEL " +
        "(e.g. an Ollama server with llava) to enable model narratives. The deterministic " +
        "pixel analysis does not need it.",
    };
  }
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { configured: true, reachable: false, url, model, note: `runtime answered HTTP ${res.status}` };
    }
    const body = (await res.json()) as { models?: { name: string }[] };
    const models = (body.models ?? []).map((m) => m.name);
    return {
      configured: true,
      reachable: true,
      url,
      model,
      models,
      ...(models.length > 0 && !models.some((m) => m.startsWith(model.split(":")[0]))
        ? { note: `model '${model}' not found in local runtime — installed: ${models.join(", ")}` }
        : {}),
    };
  } catch {
    return {
      configured: true,
      reachable: false,
      url,
      model,
      note: "runtime unreachable — is the local server running?",
    };
  }
}

/**
 * Outcome of a narrative request — failures are REPORTED, never swallowed.
 * `not-configured`/`not-reachable` mean no attempt was made; the rest describe
 * exactly how the attempt failed. A deterministic report is always produced
 * regardless — it is never presented as model output.
 */
export type NarrativeOutcome =
  | { state: "success"; text: string; runtime: string }
  | { state: "not-configured" }
  | { state: "not-reached"; reason: string }
  | { state: "timeout"; afterMs: number }
  | { state: "http-error"; status: number }
  | { state: "invalid-response"; detail: string };

/**
 * Ask the local model for a narrative over the measured facts — the image is
 * included so the model sees what we measured, but the STRUCTURED report is
 * always the deterministic pipeline's. The outcome is surfaced to the caller;
 * nothing here pretends a failure was a success.
 */
export async function visionNarrativeDetailed(input: {
  imageBase64: string;
  factsSummary: string;
}): Promise<NarrativeOutcome> {
  const { url, model } = visionRuntimeConfig();
  if (!url || !model) return { state: "not-configured" };
  try {
    const res = await fetch(`${url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        stream: false,
        images: [input.imageBase64],
        prompt:
          "You are a conservative technical-analysis reviewer. Given these measured chart facts:\n" +
          input.factsSummary +
          "\n\nLook at the attached chart screenshot. In 4-6 sentences: confirm or question the " +
          "measured read, name anything visible the metrics might miss (patterns, wicks, gaps), " +
          "and end with one sentence of honest caveats. No price invention, no trade commands.",
      }),
    });
    if (!res.ok) return { state: "http-error", status: res.status };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { state: "invalid-response", detail: "response body was not JSON" };
    }
    const text =
      typeof body === "object" && body !== null && typeof (body as { response?: unknown }).response === "string"
        ? (body as { response: string }).response.trim()
        : "";
    if (!text) return { state: "invalid-response", detail: "response JSON carried no 'response' text" };
    return { state: "success", text, runtime: `${model} @ ${url}` };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { state: "timeout", afterMs: GENERATE_TIMEOUT_MS };
    }
    return { state: "not-reached", reason: err instanceof Error ? err.message : "fetch failed" };
  }
}

/**
 * Back-compat wrapper — returns the narrative or undefined. Prefer
 * `visionNarrativeDetailed` when the caller must report failure modes.
 */
export async function visionNarrative(input: {
  imageBase64: string;
  factsSummary: string;
}): Promise<{ text: string; runtime: string } | undefined> {
  const out = await visionNarrativeDetailed(input);
  return out.state === "success" ? { text: out.text, runtime: out.runtime } : undefined;
}
