/**
 * POST /api/import/analysis — run the canonical spec-25/26 pipeline over a
 * user-uploaded OHLC dataset (Phase P2).
 *
 * Multipart fields: `file` (CSV text), `symbol`, `timeframe` (required);
 * optional `is24x7`, `lookbackDays`, `asOf`. The file is parsed and validated
 * server-side with the same `parseOhlcCsv` + `normalizeCandles` + `validateSeries`
 * path as /api/import/validate, wrapped in an `UploadedDatasetProvider`
 * (`source.kind: "file"`), and evaluated by `executeAnalysis` — the exact
 * service `/api/analysis` uses. No provider key, no vendor traffic, no
 * persistence; the dataset lives only for this request.
 *
 * Rights: uploaded data is analyzed for the uploader's own session — it does
 * not enter any vendor serving path and the response marks it `file`/`historical`.
 */
import { parseOhlcCsv } from "@/lib/services/csv-ohlc";
import {
  toUploadedSeries,
  UploadedDatasetProvider,
} from "@/lib/services/uploaded-provider";
import {
  ANALYSIS_MAX_LOOKBACK_DAYS,
  executeAnalysis,
} from "@/lib/services/analysis-service";
import { ServiceUnavailableError } from "@/lib/services/types";
import { TIMEFRAME_MS } from "@/lib/market-data/timeframes";
import type { AnalysisRequest, Timeframe } from "@/lib/types";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

const isTimeframe = (v: unknown): v is Timeframe =>
  typeof v === "string" && (v === "1M" || v in TIMEFRAME_MS);

export async function POST(req: Request): Promise<Response> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("multipart/form-data")) {
    return json(400, {
      error: { message: "content-type must be multipart/form-data with a 'file' field." },
    });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: { message: "Malformed multipart body." } });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return json(400, { error: { message: "multipart body must include a 'file' field." } });
  }
  const symbol = (form.get("symbol") ?? "").toString().trim();
  const timeframe = (form.get("timeframe") ?? "").toString().trim();
  if (symbol === "") {
    return json(400, { error: { message: "symbol is required — name your dataset." } });
  }
  if (!isTimeframe(timeframe)) {
    return json(400, {
      error: { message: "timeframe must be one of the canonical timeframe set." },
    });
  }
  const is24x7 = form.get("is24x7") === "true";
  const asOf = form.get("asOf")?.toString();
  const lookbackRaw = form.get("lookbackDays")?.toString();
  const lookbackDays = lookbackRaw === undefined ? undefined : Number(lookbackRaw);
  if (lookbackDays !== undefined &&
      (!Number.isFinite(lookbackDays) || lookbackDays <= 0 || lookbackDays > ANALYSIS_MAX_LOOKBACK_DAYS)) {
    return json(400, {
      error: {
        message: `lookbackDays must be a positive number no greater than ${ANALYSIS_MAX_LOOKBACK_DAYS}.`,
      },
    });
  }

  const outcome = parseOhlcCsv(await file.text(), {
    symbol,
    timeframe,
    is24x7,
  });
  if (!outcome.ok) {
    return json(422, { error: { message: outcome.error }, issues: outcome.issues ?? [] });
  }
  if (outcome.stats.duplicates > 0 || outcome.stats.outOfOrder > 0 || outcome.stats.invalidBars > 0) {
    return json(422, {
      error: {
        message:
          "The dataset fails structural validation — fix the flagged rows first " +
          `(${outcome.stats.duplicates} duplicates, ${outcome.stats.outOfOrder} out-of-order, ` +
          `${outcome.stats.invalidBars} invalid bars).`,
      },
      issues: outcome.issues,
      validationIssues: outcome.validationIssues.slice(0, 100),
    });
  }

  const provider = new UploadedDatasetProvider([
    toUploadedSeries({
      symbol,
      timeframe,
      candles: outcome.dataset.candles,
      is24x7,
    }),
  ]);

  const request: AnalysisRequest = {
    symbols: [symbol],
    timeframe,
    ...(asOf !== undefined ? { asOf } : {}),
    ...(lookbackDays !== undefined ? { lookbackDays } : {}),
  };

  try {
    const result = await executeAnalysis(request, { provider });
    return json(200, {
      result,
      dataset: {
        rowCount: outcome.dataset.rowCount,
        rejectedCount: outcome.dataset.rejectedCount,
        stats: outcome.stats,
        gaps: outcome.stats.gaps,
        provenance: "user-uploaded — not licensed for redistribution",
      },
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
