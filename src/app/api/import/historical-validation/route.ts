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
import { parseOhlcCsv, inferIntervalHint } from "@/lib/services/csv-ohlc";
import { toUploadedSeries, type UploadedSeries } from "@/lib/services/uploaded-provider";
import { defaultConfig } from "@/lib/services/engine-defaults";
import {
  assignMtfRoles,
  isCanonicalTimeframe,
  mtfFrameResolver,
  withMtfSet,
} from "@/lib/services/mtf-upload";
import { runHistoricalValidation, type ValidationRunConfig } from "@/lib/services/historical-validation";
import { TIMEFRAME_MS } from "@/lib/market-data/timeframes";
import type { BacktestCell, Timeframe } from "@/lib/types";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

const HV_MIN_FILES = 1;
const HV_MAX_FILES = 4;

const intervalToTimeframe = (ms: number): Timeframe | undefined =>
  ([...Object.keys(TIMEFRAME_MS), "1M"] as Timeframe[]).find(
    (tf) => tf !== "1M" && TIMEFRAME_MS[tf as keyof typeof TIMEFRAME_MS] === ms,
  );

interface FileMeta {
  symbol?: string;
  timeframe?: string;
  is24x7?: boolean;
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

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length < HV_MIN_FILES || files.length > HV_MAX_FILES) {
    return json(400, {
      error: { message: `supply ${HV_MIN_FILES}–${HV_MAX_FILES} CSV files in repeated 'files' fields (got ${files.length}).` },
    });
  }

  let metas: FileMeta[];
  const metaRaw = form.get("meta")?.toString();
  if (metaRaw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(metaRaw);
      if (!Array.isArray(parsed) || parsed.length !== files.length) {
        return json(400, { error: { message: "meta must be a JSON array with one entry per uploaded file." } });
      }
      metas = parsed as FileMeta[];
    } catch {
      return json(400, { error: { message: "meta is not valid JSON." } });
    }
  } else {
    metas = files.map(() => ({}));
  }

  const symbol = (form.get("symbol") ?? "").toString().trim().toUpperCase();
  if (symbol === "") {
    return json(400, { error: { message: "symbol is required — one instrument label for the whole run." } });
  }
  for (let i = 0; i < metas.length; i += 1) {
    const ms = metas[i].symbol?.trim();
    if (ms !== undefined && ms !== "" && ms.toUpperCase() !== symbol) {
      return json(422, {
        error: {
          message: `file ${i + 1} (${files[i].name}) declares '${ms}' but the run symbol is '${symbol}'. Datasets for different instruments cannot be combined.`,
        },
      });
    }
  }

  const anchor = (form.get("anchor") ?? "").toString().trim();
  if (!isCanonicalTimeframe(anchor)) {
    return json(400, { error: { message: "anchor must be one of the canonical timeframe set." } });
  }
  const htfRaw = form.get("htf")?.toString().trim();
  const etfRaw = form.get("etf")?.toString().trim();
  const overrides = {
    ...(htfRaw !== undefined && htfRaw !== "" ? { htf: htfRaw as Timeframe } : {}),
    ...(etfRaw !== undefined && etfRaw !== "" ? { etf: etfRaw as Timeframe } : {}),
  };

  const cfg = parseConfig(form.get("config")?.toString());
  if ("error" in cfg) return json(400, { error: { message: cfg.error } });

  // ---- Parse every upload through the canonical CSV pipeline. ----
  const seriesList: UploadedSeries[] = [];
  const parseWarnings: string[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const meta = metas[i];
    const text = await file.text();
    const probe = parseOhlcCsv(text, { symbol });
    if (!probe.ok) {
      return json(422, { error: { message: `file ${i + 1} (${file.name}): ${probe.error}` }, file: file.name, issues: probe.issues ?? [] });
    }
    const hint = inferIntervalHint(probe.dataset.candles);
    let timeframe: Timeframe | undefined;
    const declared = meta.timeframe?.trim();
    if (declared !== undefined && declared !== "") {
      if (!isCanonicalTimeframe(declared)) {
        return json(400, { error: { message: `file ${i + 1} (${file.name}): timeframe '${declared}' is not in the canonical set.` } });
      }
      timeframe = declared;
    } else {
      const hinted = hint !== undefined ? intervalToTimeframe(hint) : undefined;
      if (hinted === undefined) {
        return json(422, {
          error: { message: `file ${i + 1} (${file.name}): timeframe is required — the median interval does not map unambiguously to a canonical timeframe. Set it in meta.` },
        });
      }
      timeframe = hinted;
    }
    const final = parseOhlcCsv(text, { symbol, timeframe, is24x7: meta.is24x7 === true });
    if (!final.ok) {
      return json(422, { error: { message: `file ${i + 1} (${file.name}): ${final.error}` }, file: file.name, issues: final.issues ?? [] });
    }
    for (const f of final.validationIssues) {
      if (f.severity !== "info") parseWarnings.push(`${file.name}: ${f.severity} — ${f.message}`);
    }
    seriesList.push(toUploadedSeries({ symbol, timeframe, candles: final.dataset.candles, is24x7: meta.is24x7 === true }));
  }

  // ---- Role assignment + cell assembly (spec-31 transport; single-file runs
  //      have no aux frames — baseline behavior, bit-identical). ----
  const uploaded = seriesList.map((s) => s.timeframe);
  const assign = assignMtfRoles(uploaded, anchor, overrides);
  if (!assign.ok) return json(400, { error: { message: assign.error } });
  const { roles, set, unused } = assign.assignment;
  if (unused.length > 0) {
    parseWarnings.push(`uploaded timeframe(s) not bound to a role and unused: ${unused.join(", ")}`);
  }

  const anchorSeries = seriesList.find((s) => s.timeframe === anchor);
  if (anchorSeries === undefined) {
    return json(400, { error: { message: `anchor '${anchor}' must be one of the uploaded timeframes.` } });
  }
  const resolveFrames = mtfFrameResolver({ symbol, anchor, roles, datasets: seriesList });
  const cell: BacktestCell = {
    symbol,
    timeframe: anchor,
    series: {
      symbol,
      timeframe: anchor,
      candles: anchorSeries.candles,
    },
  };
  const frames = resolveFrames({ symbol }, anchor);
  if (frames !== undefined) cell.frames = frames;

  const config = withMtfSet(defaultConfig(), set);
  try {
    const result = runHistoricalValidation({
      cells: [cell],
      config: cfg,
      deps: { config },
    });
    result.warnings.push(...parseWarnings);
    return json(200, { result });
  } catch (e) {
    return json(500, { error: { message: e instanceof Error ? e.message : "validation failed" } });
  }
}
