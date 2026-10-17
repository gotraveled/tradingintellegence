/**
 * POST /api/compare/strategies — Strategy Comparison Lab (comp-v1).
 *
 * Evaluates 2–6 frozen strategy snapshots through the canonical hv1
 * historical-validation contract on one uploaded dataset under one shared
 * protocol. A strategy is an EngineConfig snapshot (preset id or inline
 * object) plus an optional scenario selection — the only inputs the engine
 * accepts. Unsupported strategy definitions are rejected, never approximated.
 *
 * Multipart fields:
 *   files/meta/symbol/anchor/htf/etf — identical contract to
 *              /api/import/historical-validation (shared parseUploadForm:
 *              same provenance, integrity gate, role assignment).
 *   config   — required JSON ComparisonSharedConfig { horizonBars,
 *              entryDeadlineBars?, costs?, split?, purgeBoundaries?,
 *              costSensitivity?, horizonSensitivity? }.
 *   strategies — required JSON array, 2–6 entries:
 *              { id, label?, preset }  OR
 *              { id, label?, engineConfig, selection? }.
 *              selection: { setupTypes?: SetupType[], minScore?: 0–100 }.
 *
 * Fairness: the shared protocol is applied identically to every strategy;
 * uploads bound to MTF roles are injected into EVERY engineConfig via
 * withMtfSet so frame roles resolve consistently. Identical frozen snapshots,
 * duplicate ids, and malformed selections are rejected with actionable errors.
 */
import { defaultConfig } from "@/lib/services/engine-defaults";
import { withMtfSet } from "@/lib/services/mtf-upload";
import { parseUploadForm } from "@/lib/services/csv-upload";
import {
  COMPARISON_STRATEGY_MAX,
  COMPARISON_STRATEGY_MIN,
  runStrategyComparison,
  strategyPreset,
  STRATEGY_PRESETS,
  type ComparisonSharedConfig,
  type ComparisonStrategy,
} from "@/lib/services/strategy-comparison";
import type { ValidationRunConfig } from "@/lib/services/historical-validation";
import type { EngineConfig } from "@/lib/types";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/** Shared-protocol fields — identical to ValidationRunConfig minus
 *  per-strategy selection, validated with the same rules. */
function parseShared(raw: string | undefined): ComparisonSharedConfig | { error: string } {
  if (raw === undefined) return { error: "config (JSON ComparisonSharedConfig) is required." };
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
  const costsOk = (k: { feeBps?: number; slippageBps?: number; slippagePoints?: number } | undefined) =>
    k === undefined || [k.feeBps, k.slippageBps, k.slippagePoints].every(
      (v) => v === undefined || (Number.isFinite(v) && v >= 0));
  if (!costsOk(cfg.costs)) {
    return { error: "cost fields must be non-negative finite numbers." };
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
        cfg.costSensitivity.length > 4 || !cfg.costSensitivity.every(costsOk)) {
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
  // setupTypes/minScore are per-strategy — a shared selection would be a
  // protocol, not a strategy axis; reject it here so intent stays explicit.
  if (cfg.setupTypes !== undefined || cfg.minScore !== undefined) {
    return { error: "setupTypes/minScore belong to per-strategy `selection`, not the shared protocol." };
  }
  return cfg as ComparisonSharedConfig;
}

function parseStrategies(raw: string | undefined): ComparisonStrategy[] | { error: string } {
  if (raw === undefined) return { error: "strategies (JSON array) is required." };
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return { error: "strategies is not valid JSON." };
  }
  if (!Array.isArray(arr) || arr.length < COMPARISON_STRATEGY_MIN || arr.length > COMPARISON_STRATEGY_MAX) {
    return { error: `strategies must be a JSON array of ${COMPARISON_STRATEGY_MIN}–${COMPARISON_STRATEGY_MAX} entries.` };
  }
  const out: ComparisonStrategy[] = [];
  for (const rawEntry of arr) {
    const e = rawEntry as Partial<ComparisonStrategy> & { preset?: string };
    if (typeof e?.id !== "string" || e.id.trim() === "") {
      return { error: "every strategy needs a non-empty string id." };
    }
    const label = typeof e.label === "string" && e.label.trim() !== "" ? e.label : undefined;
    const selection = e.selection;
    if (e.preset !== undefined) {
      const preset = strategyPreset(e.preset);
      if (preset === undefined) {
        return {
          error: `strategy '${e.id}' names unsupported preset '${e.preset}'. ` +
            `Supported presets: ${STRATEGY_PRESETS.map((p) => p.id).join(", ")} — ` +
            "or supply an explicit engineConfig snapshot.",
        };
      }
      const resolved = preset.resolve();
      out.push({
        id: e.id,
        ...(label !== undefined ? { label } : { label: preset.label }),
        engineConfig: resolved.engineConfig,
        selection: selection ?? resolved.selection,
      });
    } else if (e.engineConfig !== undefined) {
      out.push({
        id: e.id,
        ...(label !== undefined ? { label } : {}),
        engineConfig: e.engineConfig as EngineConfig,
        ...(selection !== undefined ? { selection } : {}),
      });
    } else {
      return {
        error: `strategy '${e.id}' supplies neither a supported preset nor an engineConfig ` +
          "snapshot — this strategy type is unsupported (only EngineConfig snapshots are " +
          "comparable; rule-builder strategies cannot be evaluated fairly).",
      };
    }
  }
  return out;
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

  const cfg = parseShared(form.get("config")?.toString());
  if ("error" in cfg) return json(400, { error: { message: cfg.error } });
  const strategies = parseStrategies(form.get("strategies")?.toString());
  if ("error" in strategies) return json(400, { error: { message: strategies.error } });

  const parsed = await parseUploadForm(form);
  if (!parsed.ok) return json(parsed.status, parsed.body);
  const { cells, warnings: parseWarnings, set } = parsed.upload;

  try {
    // Bind uploaded MTF roles into EVERY snapshot identically — frames resolve
    // to the same role timeframes for every strategy (fairness).
    const bound = strategies.map((s) => ({
      ...s,
      engineConfig: withMtfSet(s.engineConfig ?? defaultConfig(), set),
    }));
    const result = runStrategyComparison({ cells, strategies: bound, shared: cfg });
    result.warnings.push(...parseWarnings);
    return json(200, { result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "comparison failed";
    // Runner validation errors are client-actionable; engine failures are not.
    const status = /must|required|duplicate|identical|unsupported|supply|valid/i.test(message) ? 400 : 500;
    return json(status, { error: { message } });
  }
}
