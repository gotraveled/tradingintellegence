/**
 * POST /api/import/historical-validation — evaluate canonical engine scenarios
 * against subsequent candles from user-uploaded OHLC datasets.
 *
 * Multipart fields:
 *   files    — repeated File fields (CSV text), 1–4 datasets. A single file is
 *              sufficient: MTF context frames are optional additions.
 *   meta     — optional JSON array parallel to `files`:
 *              { "symbol"?: string, "timeframe"?: string, "is24x7"?: boolean }.
 *              `timeframe` may be omitted only when the median interval maps
 *              unambiguously to a canonical timeframe.
 *   symbol   — required: one instrument label for the whole run; conflicting
 *              per-file symbols are rejected (never merged).
 *   anchor   — required: the evaluation timeframe; must be one of the
 *              uploaded timeframes. Its dataset becomes the cell series.
 *   htf/etf  — optional role overrides; must be uploaded timeframes on the
 *              correct side of the anchor.
 *   config   — required JSON: ValidationRunConfig
 *              { horizonBars, entryDeadlineBars?, costs?, minScore?,
 *                setupTypes?, split? }.
 *
 * Causality: scenario generation and measurement are canonical (specs 11–17,
 * 26); observation opens at anchor+1 and outcomes are re-windowed to the
 * configured horizon by the product layer — never by re-detecting setups.
 * Aux frames join only through closed-bar visibility (`closedIndexAt`).
 *
 * Rights & provenance: uploads are analyzed for the uploader's session only,
 * `source.kind: "file"`, never persisted, never served onward.
 */
import { defaultConfig } from "@/lib/services/engine-defaults";
import { withMtfSet } from "@/lib/services/mtf-upload";
import { parseUploadForm } from "@/lib/services/csv-upload";
import { runHistoricalValidation, type ValidationRunConfig } from "@/lib/services/historical-validation";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function parseConfig(raw: string | undefined): ValidationRunConfig | { error: string } {
  if (raw === undefined) return { error: "config (JSON ValidationRunConfig) is required." };
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    return { error: "config is not valid JSON." };
  }
  const cfg = c as Partial<ValidationRunConfig>;
  if (!Number.isFinite(cfg.horizonBars) || (cfg.horizonBars as number) < 1) {
    return { error: "config.horizonBars must be a finite number ≥ 1." };
  }
  if (cfg.entryDeadlineBars !== undefined &&
      (!Number.isFinite(cfg.entryDeadlineBars) || cfg.entryDeadlineBars < 1)) {
    return { error: "config.entryDeadlineBars must be a finite number ≥ 1 when provided." };
  }
  if (cfg.costs !== undefined) {
    const { feeBps, slippageBps, slippagePoints } = cfg.costs;
    if ([feeBps, slippageBps, slippagePoints].some(
      (v) => v !== undefined && (!Number.isFinite(v) || v < 0),
    )) {
      return { error: "cost fields must be non-negative finite numbers." };
    }
  }
  if (cfg.minScore !== undefined && (!Number.isFinite(cfg.minScore) || cfg.minScore < 0 || cfg.minScore > 100)) {
    return { error: "config.minScore must be between 0 and 100." };
  }
  if (cfg.split !== undefined) {
    const { trainPct, validationPct } = cfg.split;
    if (!Number.isFinite(trainPct) || !Number.isFinite(validationPct) ||
        trainPct < 0 || validationPct < 0 || trainPct + validationPct >= 1) {
      return { error: "split percentages must be in [0,1] and sum to < 1." };
    }
  }
  if (cfg.purgeBoundaries !== undefined && typeof cfg.purgeBoundaries !== "boolean") {
    return { error: "config.purgeBoundaries must be a boolean when provided." };
  }
  if (cfg.purgeBoundaries === true && cfg.split === undefined) {
    return { error: "config.purgeBoundaries requires a chronological split — boundaries do not exist without cohorts." };
  }
  if (cfg.costSensitivity !== undefined) {
    if (!Array.isArray(cfg.costSensitivity) || cfg.costSensitivity.length === 0 ||
        cfg.costSensitivity.length > 4 ||
        !cfg.costSensitivity.every((c) => c !== undefined &&
          [c.feeBps, c.slippageBps, c.slippagePoints].every(
            (v) => v === undefined || (Number.isFinite(v) && v >= 0)))) {
      return { error: "costSensitivity must be 1–4 cost cases with non-negative finite fields." };
    }
  }
  if (cfg.horizonSensitivity !== undefined) {
    const hs = cfg.horizonSensitivity;
    if (!Array.isArray(hs) || hs.length === 0 || hs.length > 5 ||
        !hs.every((h) => Number.isInteger(h) && h >= 1) ||
        new Set(hs).size !== hs.length || hs.includes(cfg.horizonBars as number)) {
      return { error: "horizonSensitivity must be 1–5 distinct integers ≥ 1, all different from horizonBars." };
    }
  }
  return cfg as ValidationRunConfig;
}

export async function POST(req: Request): Promise<Response> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("multipart/form-data")) {
    return json(400, {
      error: { message: "content-type must be multipart/form-data with repeated 'files' fields." },
    });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: { message: "Malformed multipart body." } });
  }

  const cfg = parseConfig(form.get("config")?.toString());
  if ("error" in cfg) return json(400, { error: { message: cfg.error } });

  const parsed = await parseUploadForm(form);
  if (!parsed.ok) return json(parsed.status, parsed.body);
  const { cells, warnings: parseWarnings, set } = parsed.upload;

  const config = withMtfSet(defaultConfig(), set);
  try {
    const result = runHistoricalValidation({
      cells,
      config: cfg,
      deps: { config },
    });
    result.warnings.push(...parseWarnings);
    return json(200, { result });
  } catch (e) {
    return json(500, { error: { message: e instanceof Error ? e.message : "validation failed" } });
  }
}
