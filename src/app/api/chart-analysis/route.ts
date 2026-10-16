/**
 * POST /api/chart-analysis — screenshot chart analysis (Phase P1).
 *
 * Multipart fields: `image` (png/jpeg/webp ≤ 8 MB), optional `context` JSON
 * (symbol, market, timeframe, currentPrice, horizon).
 *
 * Pipeline: decode → deterministic pixel metrics (sharp) → structured report.
 * An optional LOCAL vision runtime (VISION_RUNTIME_URL + VISION_MODEL, e.g.
 * Ollama+llava) may add a narrative — it is probed per request and skipped on
 * any failure. Images NEVER leave this process: the only outbound call is the
 * operator-configured local URL. Nothing is stored.
 */
import { analyzeChartImage, type ImageMetrics } from "@/lib/chart-analysis/image-metrics";
import { buildScreenshotReport, type ChartContext } from "@/lib/chart-analysis/report";
import { resolveAxisCalibration, type PriceAxisInput } from "@/lib/chart-analysis/axis-calibration";
import { buildEvidence, sanitizeEvidence } from "@/lib/chart-analysis/evidence";
import {
  probeVisionRuntime,
  visionNarrativeDetailed,
  visionRuntimeConfig,
  type NarrativeOutcome,
} from "@/lib/chart-analysis/vision-runtime";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp"]);

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function parseContext(raw: string | null): ChartContext | { error: string } {
  if (raw === null || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "context must be valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { error: "context must be a JSON object." };
  }
  const c = parsed as Record<string, unknown>;
  const horizon = c.horizon;
  if (horizon !== undefined && horizon !== "intraday" && horizon !== "swing" && horizon !== "position") {
    return { error: "horizon must be intraday | swing | position." };
  }
  if (c.currentPrice !== undefined &&
      (typeof c.currentPrice !== "number" || !Number.isFinite(c.currentPrice) || c.currentPrice <= 0)) {
    return { error: "currentPrice must be a positive number." };
  }
  const out: ChartContext = {};
  if (typeof c.symbol === "string" && c.symbol.trim()) out.symbol = c.symbol.trim();
  if (typeof c.market === "string" && c.market.trim()) out.market = c.market.trim();
  if (typeof c.timeframe === "string" && c.timeframe.trim()) out.timeframe = c.timeframe.trim();
  if (typeof c.currentPrice === "number") out.currentPrice = c.currentPrice;
  if (horizon !== undefined) out.horizon = horizon;

  if (c.priceAxis !== undefined) {
    if (typeof c.priceAxis !== "object" || c.priceAxis === null) {
      return { error: "priceAxis must be an object." };
    }
    const p = c.priceAxis as Record<string, unknown>;
    const axis: PriceAxisInput = {};
    const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
    if (p.topPrice !== undefined) {
      if (!positive(p.topPrice)) return { error: "priceAxis.topPrice must be a positive number." };
      axis.topPrice = p.topPrice as number;
    }
    if (p.bottomPrice !== undefined) {
      if (!positive(p.bottomPrice)) return { error: "priceAxis.bottomPrice must be a positive number." };
      axis.bottomPrice = p.bottomPrice as number;
    }
    if (p.tickPrices !== undefined) {
      if (!Array.isArray(p.tickPrices) || p.tickPrices.length === 0 || p.tickPrices.length > 24 ||
          !p.tickPrices.every(positive)) {
        return { error: "priceAxis.tickPrices must be 1–24 positive numbers." };
      }
      axis.tickPrices = p.tickPrices as number[];
    }
    if (p.scale !== undefined) {
      if (p.scale !== "auto" && p.scale !== "linear" && p.scale !== "log") {
        return { error: "priceAxis.scale must be auto | linear | log." };
      }
      axis.scale = p.scale;
    }
    out.priceAxis = axis;
  }
  return out;
}

function factsSummary(m: ImageMetrics): string {
  return [
    `candles detected: ${m.candles.length} (${m.bullishCount} bullish, ${m.bearishCount} bearish)`,
    `trend slope ${m.trendSlope.toFixed(2)} px/bar, fit R² ${m.trendR2.toFixed(2)}`,
    `last close position: ${(m.lastClosePosition * 100).toFixed(0)}% of visible range`,
    `swings: ${m.swings.higherHighs}HH/${m.swings.higherLows}HL, ${m.swings.lowerHighs}LH/${m.swings.lowerLows}LL`,
    `zones: ${m.zones.map((z) => `${z.kind} x${z.touches}`).join(", ") || "none"}`,
  ].join("\n");
}

export async function POST(req: Request): Promise<Response> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("multipart/form-data")) {
    return json(400, { error: { message: "content-type must be multipart/form-data with an 'image' field." } });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: { message: "Malformed multipart body." } });
  }

  const image = form.get("image");
  if (!(image instanceof File)) {
    return json(400, { error: { message: "multipart body must include an 'image' field." } });
  }
  if (!ACCEPTED.has(image.type)) {
    return json(422, {
      error: { message: `unsupported image type '${image.type}' — upload PNG, JPEG, or WebP.` },
    });
  }
  if (image.size > MAX_IMAGE_BYTES) {
    return json(422, {
      error: { message: `image is ${(image.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB.` },
    });
  }

  const context = parseContext(form.get("context")?.toString() ?? null);
  if ("error" in context) {
    return json(400, { error: { message: context.error } });
  }

  let metrics: ImageMetrics;
  try {
    metrics = await analyzeChartImage(Buffer.from(await image.arrayBuffer()));
  } catch {
    return json(422, {
      error: { message: "the file could not be decoded as an image — re-export as PNG/JPEG/WebP." },
    });
  }

  // Calibration: detected tick positions + user-supplied values only.
  const calibration = resolveAxisCalibration(metrics, metrics.axis, context.priceAxis, context.currentPrice);

  // Optional local model narrative — every failure mode is reported verbatim;
  // the deterministic report below is never presented as model output.
  const runtime = await probeVisionRuntime();
  let narrativeOutcome: NarrativeOutcome;
  if (runtime.configured && runtime.reachable) {
    narrativeOutcome = await visionNarrativeDetailed({
      imageBase64: Buffer.from(await image.arrayBuffer()).toString("base64"),
      factsSummary: factsSummary(metrics),
    });
  } else {
    narrativeOutcome = runtime.configured
      ? { state: "not-reached", reason: runtime.note ?? "runtime unreachable" }
      : { state: "not-configured" };
  }
  const narrative =
    narrativeOutcome.state === "success"
      ? { text: narrativeOutcome.text, runtime: narrativeOutcome.runtime }
      : undefined;

  const report = buildScreenshotReport(metrics, context, narrative, calibration);
  // Evidence regions: measured features only — validated before leaving the server.
  const evidence = sanitizeEvidence(buildEvidence(metrics, report.levels));
  return json(200, {
    result: {
      report: { ...report, evidence },
      runtime: {
        ...runtime,
        configuredUrl: visionRuntimeConfig().url !== undefined,
        narrative: narrativeOutcome,
        note:
          runtime.note ??
          (narrativeOutcome.state === "success"
            ? "local vision runtime produced a narrative — the deterministic report above it stands alone"
            : runtime.reachable
              ? "runtime reachable but no narrative was produced — the deterministic report stands alone"
              : "deterministic pixel analysis only — no model configured or reachable"),
      },
      provenance:
        "analyzed locally from uploaded pixels — image was not sent to any third party and was not stored",
    },
  });
}
