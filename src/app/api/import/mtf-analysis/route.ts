/**
 * POST /api/import/mtf-analysis — spec-10/31 multi-timeframe analysis over
 * 2..4 user-uploaded OHLC datasets of ONE declared instrument (Phase P3).
 *
 * Multipart fields:
 *   files          — repeated File fields (CSV text), 2–4 datasets.
 *   meta           — JSON array parallel to `files`:
 *                    { "symbol"?: string, "timeframe"?: string, "is24x7"?: boolean }.
 *                    `timeframe` may be omitted ONLY when the series' median
 *                    interval unambiguously maps to a canonical timeframe.
 *   symbol         — required: the instrument label EVERY dataset must share.
 *                    A per-file meta symbol that disagrees is an error — files
 *                    are never merged across instruments.
 *   anchor         — required: the analysis timeframe (must be one of the
 *                    uploaded timeframes); its dataset serves the cell's own
 *                    spec-26 series.
 *   htf / etf      — optional role overrides; must be uploaded timeframes on
 *                    the correct side of the anchor. Defaults: nearest
 *                    timeframe strictly above/below the anchor.
 *   asOf           — optional ISO evaluation timestamp; default = the latest
 *                    moment at which every dataset's last bar is CLOSED
 *                    (common-window end), so no unfinished candle is ever
 *                    visible to the join.
 *   lookbackDays   — optional cell-series context depth (≤180); defaults to
 *                    the uploaded span, capped at the product bound.
 *
 * Causality: frames reach the engine through `BacktestCell.frames` (spec-31).
 * The engine joins each frame at `barCloseTime(cellAnchorBar)` via
 * `closedIndexAt` — only bars whose canonical CLOSE is ≤ the anchor
 * contribute. A frame with no closed bar at the anchor degrades to vote-0
 * through `emptyFrame`, never a fabricated snapshot; frames rejected by
 * contract validation are counted in `engineDiagnostics.mtfFramesSkipped`.
 *
 * Rights & provenance: same posture as /api/import/analysis — uploads are
 * analyzed for the uploader's session only, `source.kind: "file"`, never
 * persisted, never served onward.
 */
import { parseOhlcCsv, inferIntervalHint } from "@/lib/services/csv-ohlc";
import {
  toUploadedSeries,
  UploadedDatasetProvider,
  type UploadedSeries,
} from "@/lib/services/uploaded-provider";
import {
  ANALYSIS_MAX_LOOKBACK_DAYS,
  executeAnalysis,
} from "@/lib/services/analysis-service";
import { defaultConfig } from "@/lib/services/engine-defaults";
import { ServiceUnavailableError } from "@/lib/services/types";
import {
  assignMtfRoles,
  classifyTimeSemantics,
  commonWindow,
  describeFrames,
  isCanonicalTimeframe,
  mtfFrameResolver,
  withMtfSet,
} from "@/lib/services/mtf-upload";
import { barCloseTime, closedIndexAt } from "@/lib/engines/mtf";
import { TIMEFRAME_MS } from "@/lib/market-data/timeframes";
import type { AnalysisRequest, Candle, Timeframe } from "@/lib/types";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

export const MTF_MIN_FILES = 2;
export const MTF_MAX_FILES = 4;

const DAY_MS = 86_400_000;
/** Interval hint maps to a canonical timeframe only on exact equality —
 *  a 45-minute median is NOT a 30m or 1h dataset. */
const intervalToTimeframe = (ms: number): Timeframe | undefined =>
  ([...Object.keys(TIMEFRAME_MS), "1M"] as Timeframe[]).find(
    (tf) => tf !== "1M" && TIMEFRAME_MS[tf as keyof typeof TIMEFRAME_MS] === ms,
  );

interface FileMeta {
  symbol?: string;
  timeframe?: string;
  is24x7?: boolean;
}

interface ParsedUpload {
  fileName: string;
  series: UploadedSeries;
  rowCount: number;
  rejectedCount: number;
  stats: {
    firstBar: number; lastBar: number; gaps: number;
    duplicates: number; outOfOrder: number; invalidBars: number;
  };
  timeSemantics: ReturnType<typeof classifyTimeSemantics>;
  intervalHintMs?: number;
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
  if (files.length < MTF_MIN_FILES || files.length > MTF_MAX_FILES) {
    return json(400, {
      error: {
        message: `supply ${MTF_MIN_FILES}–${MTF_MAX_FILES} CSV files in repeated 'files' fields (got ${files.length}).`,
      },
    });
  }

  let metas: FileMeta[] = [];
  const metaRaw = form.get("meta")?.toString();
  if (metaRaw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(metaRaw);
      if (!Array.isArray(parsed) || parsed.length !== files.length) {
        return json(400, {
          error: { message: "meta must be a JSON array with one entry per uploaded file." },
        });
      }
      metas = parsed as FileMeta[];
    } catch {
      return json(400, { error: { message: "meta is not valid JSON." } });
    }
  } else {
    metas = files.map(() => ({}));
  }

  // One declared instrument for the whole run — the per-file meta symbol must
  // agree with it when present. There is no "merge whatever arrived" path.
  const symbol = (form.get("symbol") ?? "").toString().trim().toUpperCase();
  if (symbol === "") {
    return json(400, {
      error: { message: "symbol is required — one instrument label for the whole MTF run." },
    });
  }
  for (let i = 0; i < metas.length; i += 1) {
    const ms = metas[i].symbol?.trim();
    if (ms !== undefined && ms !== "" && ms.toUpperCase() !== symbol) {
      return json(422, {
        error: {
          message:
            `file ${i + 1} (${files[i].name}) declares '${ms}' but the run symbol is ` +
            `'${symbol}'. Datasets for different instruments cannot be combined.`,
        },
      });
    }
  }

  const anchor = (form.get("anchor") ?? "").toString().trim();
  if (!isCanonicalTimeframe(anchor)) {
    return json(400, {
      error: { message: "anchor must be one of the canonical timeframe set." },
    });
  }
  const htfRaw = form.get("htf")?.toString().trim();
  const etfRaw = form.get("etf")?.toString().trim();
  const overrides = {
    ...(htfRaw !== undefined && htfRaw !== "" ? { htf: htfRaw as Timeframe } : {}),
    ...(etfRaw !== undefined && etfRaw !== "" ? { etf: etfRaw as Timeframe } : {}),
  };

  const asOfRaw = form.get("asOf")?.toString();
  const asOfParsed = asOfRaw === undefined ? undefined : Date.parse(asOfRaw);
  if (asOfRaw !== undefined && !Number.isFinite(asOfParsed)) {
    return json(400, { error: { message: "asOf must be a valid ISO timestamp when supplied." } });
  }
  const lookbackRaw = form.get("lookbackDays")?.toString();
  const lookbackDays = lookbackRaw === undefined ? undefined : Number(lookbackRaw);
  if (lookbackDays !== undefined &&
      (!Number.isFinite(lookbackDays) || lookbackDays <= 0 || lookbackDays > ANALYSIS_MAX_LOOKBACK_DAYS)) {
    return json(400, {
      error: { message: `lookbackDays must be a positive number no greater than ${ANALYSIS_MAX_LOOKBACK_DAYS}.` },
    });
  }

  // -------------------------------------------------------------------------
  // Per-file canonical validation — the same parse/normalize/validate pipeline
  // as /api/import/analysis. Timeframe is inferred only when unambiguous.
  const parsed: ParsedUpload[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const meta = metas[i];
    const text = await file.text();

    // Probe first so an undeclared timeframe can be resolved from the data.
    const probe = parseOhlcCsv(text, { symbol });
    if (!probe.ok) {
      return json(422, {
        error: { message: `file ${i + 1} (${file.name}): ${probe.error}` },
        file: file.name,
        issues: probe.issues ?? [],
      });
    }

    const hint = inferIntervalHint(probe.dataset.candles);
    let timeframe: Timeframe | undefined;
    const declared = meta.timeframe?.trim();
    if (declared !== undefined && declared !== "") {
      if (!isCanonicalTimeframe(declared)) {
        return json(400, {
          error: { message: `file ${i + 1} (${file.name}): timeframe '${declared}' is not in the canonical set.` },
        });
      }
      timeframe = declared;
    } else {
      const hinted = hint !== undefined ? intervalToTimeframe(hint) : undefined;
      if (hinted === undefined) {
        return json(422, {
          error: {
            message:
              `file ${i + 1} (${file.name}): timeframe is required — the median interval ` +
              `(${hint !== undefined ? `${Math.round(hint / 60000)} min` : "undetermined"}) does not ` +
              "map unambiguously to a canonical timeframe. Set it explicitly in meta.",
          },
        });
      }
      timeframe = hinted;
    }

    // Re-parse with the resolved timeframe so spec-4 alignment/gap checks run.
    const final = parseOhlcCsv(text, { symbol, timeframe, is24x7: meta.is24x7 === true });
    if (!final.ok) {
      return json(422, {
        error: { message: `file ${i + 1} (${file.name}): ${final.error}` },
        file: file.name,
        issues: final.issues ?? [],
      });
    }
    if (final.stats.duplicates > 0 || final.stats.outOfOrder > 0 || final.stats.invalidBars > 0) {
      return json(422, {
        error: {
          message:
            `file ${i + 1} (${file.name}) fails structural validation ` +
            `(${final.stats.duplicates} duplicates, ${final.stats.outOfOrder} out-of-order, ` +
            `${final.stats.invalidBars} invalid bars).`,
        },
        file: file.name,
        issues: final.issues,
        validationIssues: final.validationIssues.slice(0, 100),
      });
    }

    const timeCol = final.dataset.mapping.time;
    const sample = final.preview.rows[0]?.[timeCol];
    parsed.push({
      fileName: file.name,
      series: toUploadedSeries({
        symbol,
        timeframe,
        candles: final.dataset.candles,
        is24x7: meta.is24x7 === true,
      }),
      rowCount: final.dataset.rowCount,
      rejectedCount: final.dataset.rejectedCount,
      stats: final.stats,
      timeSemantics: classifyTimeSemantics(sample),
      ...(hint !== undefined ? { intervalHintMs: hint } : {}),
    });
  }

  // One dataset per timeframe — two files claiming the same timeframe is a
  // caller error, never a merge.
  const tfs = parsed.map((p) => p.series.timeframe);
  if (new Set(tfs).size !== tfs.length) {
    return json(422, {
      error: {
        message: `duplicate timeframe uploads (${tfs.join(", ")}) — each file must cover a distinct timeframe.`,
      },
    });
  }
  if (!tfs.includes(anchor)) {
    return json(422, {
      error: { message: `anchor ${anchor} must be one of the uploaded timeframes (${tfs.join(", ")}).` },
    });
  }

  const assignment = assignMtfRoles(tfs, anchor, overrides);
  if (!assignment.ok) {
    return json(400, { error: { message: assignment.error } });
  }

  const datasets = parsed.map((p) => p.series);
  const window = commonWindow(datasets);
  if (window === null) {
    return json(422, {
      error: {
        message:
          "the uploaded datasets do not overlap in time — there is no moment where " +
          "every timeframe contributes. Upload covering ranges or analyze single-timeframe.",
      },
    });
  }

  // Anchor timestamp — last moment where every dataset's final bar is closed,
  // unless the caller anchored explicitly (a mid-history PIT run is legal).
  const asOfMs = asOfParsed ?? window.end;
  const anchorCandles: Candle[] =
    parsed.find((p) => p.series.timeframe === anchor)?.series.candles ?? [];
  const anchorIdx = closedIndexAt(anchorCandles, anchor, asOfMs);
  if (anchorIdx < 0) {
    return json(422, {
      error: {
        message:
          `no ${anchor} bar is fully closed at the anchor — the anchor dataset does ` +
          "not extend far enough for a causal evaluation.",
      },
    });
  }
  const anchorCloseMs = barCloseTime(anchorCandles[anchorIdx], anchor);

  // Context depth for the cell series — defaults to the uploaded span, capped
  // by the product bound. Frames are never truncated (the engine consumes
  // full series; causality is the join's job, not truncation's).
  const spanDays = Math.ceil((asOfMs - window.start) / DAY_MS) + 1;
  const warnings: string[] = [];
  if (spanDays > ANALYSIS_MAX_LOOKBACK_DAYS) {
    warnings.push(
      `uploaded span (~${spanDays}d) exceeds the ${ANALYSIS_MAX_LOOKBACK_DAYS}d analysis bound — ` +
      "the anchor series is evaluated with the most recent context only; frame series are unaffected.",
    );
  }
  for (const p of parsed) {
    if (p.timeSemantics.kind === "iso_naive") {
      warnings.push(`${p.fileName}: ${p.timeSemantics.assumption}`);
    }
    if (p.rejectedCount > 0) {
      warnings.push(`${p.fileName}: ${p.rejectedCount} row(s) rejected during normalization.`);
    }
  }
  if (new Set(parsed.map((p) => p.series.is24x7 === true)).size > 1) {
    warnings.push("files mix 24/7 and weekday-session gap calendars — gap classification differs per file.");
  }
  for (const v of describeFrames({
    roles: assignment.assignment.roles,
    datasets,
    anchorCloseMs,
    fileNames: new Map(parsed.map((p) => [p.series.timeframe, p.fileName])),
  })) {
    if (v.state === "no-closed-bar") {
      warnings.push(
        `${v.timeframe} (${v.fileName ?? "file"}): no fully-closed bar exists at the anchor — ` +
        "it contributes vote-0 context, not a directional vote.",
      );
    }
  }

  const provider = new UploadedDatasetProvider(datasets);
  const config = withMtfSet(defaultConfig(), assignment.assignment.set);
  const frames = mtfFrameResolver({
    symbol,
    anchor,
    roles: assignment.assignment.roles,
    datasets,
  });

  const request: AnalysisRequest = {
    symbols: [symbol],
    timeframe: anchor,
    asOf: new Date(asOfMs).toISOString(),
    lookbackDays: lookbackDays ?? Math.min(spanDays, ANALYSIS_MAX_LOOKBACK_DAYS),
  };

  try {
    const result = await executeAnalysis(request, { provider, config, frames });
    return json(200, {
      result,
      mtf: {
        roles: assignment.assignment.roles,
        set: assignment.assignment.set,
        anchorTimeframe: anchor,
        anchorCloseIso: new Date(anchorCloseMs).toISOString(),
        window: {
          startIso: new Date(window.start).toISOString(),
          endIso: new Date(window.end).toISOString(),
        },
        frames: describeFrames({
          roles: assignment.assignment.roles,
          datasets,
          anchorCloseMs,
          fileNames: new Map(parsed.map((p) => [p.series.timeframe, p.fileName])),
        }),
        unusedTimeframes: assignment.assignment.unused,
        warnings,
        timeSemantics: Object.fromEntries(
          parsed.map((p) => [p.fileName, p.timeSemantics.assumption]),
        ),
      },
      datasets: parsed.map((p) => ({
        fileName: p.fileName,
        symbol,
        timeframe: p.series.timeframe,
        rowCount: p.rowCount,
        rejectedCount: p.rejectedCount,
        stats: p.stats,
        ...(p.intervalHintMs !== undefined ? { intervalHintMs: p.intervalHintMs } : {}),
      })),
      provenance: "user-uploaded — not licensed for redistribution",
    });
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return json(503, { error: { service: error.service, message: error.message } });
    }
    const message = error instanceof Error ? error.message : "Analysis failed.";
    const status = /must|required|invalid|No instruments|at most/i.test(message) ? 400 : 500;
    return json(status, { error: { message } });
  }
}
