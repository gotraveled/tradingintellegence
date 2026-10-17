/**
 * Shared upload → BacktestCell pipeline for the import routes.
 *
 * One code path owns provenance for every upload-driven evaluation endpoint:
 * per-file canonical CSV parsing, timeframe declaration or median-interval
 * inference, one-instrument enforcement, spec-10/31 role assignment, and the
 * integrity gate that REJECTS error-severity series findings (duplicate,
 * out-of-order, or overlapping timestamps; invalid OHLC). The engine's
 * closedIndexAt join and bar indexing require ascending unique bars, and
 * spec-4 forbids silently repairing corrupt ordering — corrupt files are
 * refused loudly, warning-severity findings (gaps, alignment hints) are
 * disclosed in `warnings` and never block.
 *
 * Extracted verbatim from api/import/historical-validation — both routes must
 * share this behavior bit-for-bit.
 */
import { parseOhlcCsv, inferIntervalHint } from "@/lib/services/csv-ohlc";
import { toUploadedSeries, type UploadedSeries } from "@/lib/services/uploaded-provider";
import {
  assignMtfRoles,
  isCanonicalTimeframe,
  mtfFrameResolver,
  type MtfRoleAssignment,
} from "@/lib/services/mtf-upload";
import { TIMEFRAME_MS } from "@/lib/market-data/timeframes";
import type { BacktestCell, Timeframe } from "@/lib/types";

export const UPLOAD_MIN_FILES = 1;
export const UPLOAD_MAX_FILES = 4;

export interface UploadFileMeta {
  symbol?: string;
  timeframe?: string;
  is24x7?: boolean;
}

export interface ParsedUpload {
  cells: BacktestCell[];
  symbol: string;
  anchor: Timeframe;
  /** Role → uploaded timeframe binding — feed `withMtfSet` on every engine
   *  config the run uses so frame roles resolve to the right timeframes. */
  set: MtfRoleAssignment["set"];
  /** Warning-severity series findings + unused-timeframe notes. */
  warnings: string[];
}

export type ParseUploadOutcome =
  | { ok: true; upload: ParsedUpload }
  | { ok: false; status: number; body: unknown };

const intervalToTimeframe = (ms: number): Timeframe | undefined =>
  ([...Object.keys(TIMEFRAME_MS), "1M"] as Timeframe[]).find(
    (tf) => tf !== "1M" && TIMEFRAME_MS[tf as keyof typeof TIMEFRAME_MS] === ms,
  );

/**
 * Turn a multipart `files`/`meta`/`symbol`/`anchor`/`htf`/`etf` form into the
 * BacktestCell set for one instrument. Every failure is an actionable
 * {status, body} for the route — never a thrown exception.
 */
export async function parseUploadForm(form: FormData): Promise<ParseUploadOutcome> {
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length < UPLOAD_MIN_FILES || files.length > UPLOAD_MAX_FILES) {
    return { ok: false, status: 400, body: {
      error: { message: `supply ${UPLOAD_MIN_FILES}–${UPLOAD_MAX_FILES} CSV files in repeated 'files' fields (got ${files.length}).` },
    } };
  }

  let metas: UploadFileMeta[];
  const metaRaw = form.get("meta")?.toString();
  if (metaRaw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(metaRaw);
      if (!Array.isArray(parsed) || parsed.length !== files.length) {
        return { ok: false, status: 400, body: {
          error: { message: "meta must be a JSON array with one entry per uploaded file." },
        } };
      }
      metas = parsed as UploadFileMeta[];
    } catch {
      return { ok: false, status: 400, body: {
        error: { message: "meta is not valid JSON." },
      } };
    }
  } else {
    metas = files.map(() => ({}));
  }

  const symbol = (form.get("symbol") ?? "").toString().trim().toUpperCase();
  if (symbol === "") {
    return { ok: false, status: 400, body: {
      error: { message: "symbol is required — one instrument label for the whole run." },
    } };
  }
  for (let i = 0; i < metas.length; i += 1) {
    const ms = metas[i].symbol?.trim();
    if (ms !== undefined && ms !== "" && ms.toUpperCase() !== symbol) {
      return { ok: false, status: 422, body: {
        error: {
          message: `file ${i + 1} (${files[i].name}) declares '${ms}' but the run symbol is '${symbol}'. Datasets for different instruments cannot be combined.`,
        },
      } };
    }
  }

  const anchor = (form.get("anchor") ?? "").toString().trim();
  if (!isCanonicalTimeframe(anchor)) {
    return { ok: false, status: 400, body: {
      error: { message: "anchor must be one of the canonical timeframe set." },
    } };
  }
  const htfRaw = form.get("htf")?.toString().trim();
  const etfRaw = form.get("etf")?.toString().trim();
  const overrides = {
    ...(htfRaw !== undefined && htfRaw !== "" ? { htf: htfRaw as Timeframe } : {}),
    ...(etfRaw !== undefined && etfRaw !== "" ? { etf: etfRaw as Timeframe } : {}),
  };

  // ---- Parse every upload through the canonical CSV pipeline. ----
  const seriesList: UploadedSeries[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const meta = metas[i];
    const text = await file.text();
    const probe = parseOhlcCsv(text, { symbol });
    if (!probe.ok) {
      return { ok: false, status: 422, body: {
        error: { message: `file ${i + 1} (${file.name}): ${probe.error}` },
        file: file.name, issues: probe.issues ?? [],
      } };
    }
    const hint = inferIntervalHint(probe.dataset.candles);
    let timeframe: Timeframe | undefined;
    const declared = meta.timeframe?.trim();
    if (declared !== undefined && declared !== "") {
      if (!isCanonicalTimeframe(declared)) {
        return { ok: false, status: 400, body: {
          error: { message: `file ${i + 1} (${file.name}): timeframe '${declared}' is not in the canonical set.` },
        } };
      }
      timeframe = declared;
    } else {
      const hinted = hint !== undefined ? intervalToTimeframe(hint) : undefined;
      if (hinted === undefined) {
        return { ok: false, status: 422, body: {
          error: { message: `file ${i + 1} (${file.name}): timeframe is required — the median interval does not map unambiguously to a canonical timeframe. Set it in meta.` },
        } };
      }
      timeframe = hinted;
    }
    const final = parseOhlcCsv(text, { symbol, timeframe, is24x7: meta.is24x7 === true });
    if (!final.ok) {
      return { ok: false, status: 422, body: {
        error: { message: `file ${i + 1} (${file.name}): ${final.error}` },
        file: file.name, issues: final.issues ?? [],
      } };
    }
    // Error-severity series findings (duplicate/out-of-order/overlapping
    // timestamps, invalid OHLC) violate the engine's sorted-unique-bars
    // precondition (closedIndexAt binary search). Spec-4 never silently
    // repairs — reject the file rather than evaluate corrupt ordering.
    const dataErrors = final.validationIssues.filter((f) => f.severity === "error");
    if (dataErrors.length > 0) {
      return { ok: false, status: 422, body: {
        error: {
          message:
            `file ${i + 1} (${file.name}): ${dataErrors.length} series integrity error(s) — ` +
            `${dataErrors[0].message}${dataErrors.length > 1 ? ` (+${dataErrors.length - 1} more)` : ""}. ` +
            "Bars are never silently repaired or dropped; fix the export and re-upload.",
        },
        file: file.name,
        issues: dataErrors.map((e) => ({ row: e.index, message: e.message })),
      } };
    }
    for (const f of final.validationIssues) {
      if (f.severity !== "info") warnings.push(`${file.name}: ${f.severity} — ${f.message}`);
    }
    seriesList.push(toUploadedSeries({ symbol, timeframe, candles: final.dataset.candles, is24x7: meta.is24x7 === true }));
  }

  // ---- Role assignment + cell assembly (spec-31 transport; single-file runs
  //      have no aux frames — baseline behavior, bit-identical). ----
  const uploaded = seriesList.map((s) => s.timeframe);
  const assign = assignMtfRoles(uploaded, anchor, overrides);
  if (!assign.ok) return { ok: false, status: 400, body: { error: { message: assign.error } } };
  const { roles, set, unused } = assign.assignment;
  if (unused.length > 0) {
    warnings.push(`uploaded timeframe(s) not bound to a role and unused: ${unused.join(", ")}`);
  }

  const anchorSeries = seriesList.find((s) => s.timeframe === anchor);
  if (anchorSeries === undefined) {
    return { ok: false, status: 400, body: {
      error: { message: `anchor '${anchor}' must be one of the uploaded timeframes.` },
    } };
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

  return { ok: true, upload: { cells: [cell], symbol, anchor, set, warnings } };
}
