/**
 * POST /api/import/validate — user-uploaded OHLC CSV validation + preview
 * (Phase P2). Multipart `file` field or JSON `{ text }`.
 *
 * Returns structural facts only: parsed preview, row/stats summary, and every
 * parse/validation finding. No candles are returned and nothing is stored —
 * the client keeps the file and re-submits it to /api/import/analysis on
 * confirm. Bounded by CSV_MAX_BYTES / CSV_MAX_ROWS.
 */
import { parseOhlcCsv, inferIntervalHint } from "@/lib/services/csv-ohlc";
import { TIMEFRAME_MS } from "@/lib/market-data/timeframes";
import type { Timeframe } from "@/lib/types";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

const timeframeHint = (ms: number | undefined): Timeframe | undefined => {
  if (ms === undefined) return undefined;
  for (const [tf, tfMs] of Object.entries(TIMEFRAME_MS)) {
    if (tfMs === ms) return tf as Timeframe;
  }
  return undefined;
};

const isTimeframe = (v: unknown): v is Timeframe =>
  typeof v === "string" && (v === "1M" || v in TIMEFRAME_MS);

async function readUpload(req: Request): Promise<{ text?: string; name?: string; error?: string }> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return { error: "multipart body must include a 'file' field." };
    }
    return { text: await file.text(), name: file.name };
  }
  if (type.includes("application/json")) {
    const body = (await req.json()) as { text?: unknown };
    if (typeof body?.text !== "string") {
      return { error: "JSON body must include a string 'text' field." };
    }
    return { text: body.text };
  }
  return { error: "content-type must be multipart/form-data or application/json." };
}

export async function POST(req: Request): Promise<Response> {
  const upload = await readUpload(req);
  if (upload.error !== undefined || upload.text === undefined) {
    return json(400, { error: { message: upload.error ?? "no file supplied." } });
  }

  const url = new URL(req.url);
  const timeframe = (url.searchParams.get("timeframe") ?? undefined) as Timeframe | undefined;
  const symbol = url.searchParams.get("symbol")?.trim() || undefined;
  const is24x7 = url.searchParams.get("is24x7") === "true";

  const outcome = parseOhlcCsv(upload.text, {
    ...(isTimeframe(timeframe) ? { timeframe } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
    is24x7,
  });

  if (!outcome.ok) {
    return json(422, { error: { message: outcome.error }, issues: outcome.issues ?? [] });
  }

  return json(200, {
    result: {
      fileName: upload.name,
      rowCount: outcome.dataset.rowCount,
      rejectedCount: outcome.dataset.rejectedCount,
      delimiter: outcome.dataset.delimiter === "\t" ? "tab" : outcome.dataset.delimiter,
      mapping: outcome.dataset.mapping,
      stats: {
        ...outcome.stats,
        firstBarIso: new Date(outcome.stats.firstBar).toISOString(),
        lastBarIso: new Date(outcome.stats.lastBar).toISOString(),
      },
      intervalHintMs: inferIntervalHint(outcome.dataset.candles),
      timeframeHint: timeframeHint(inferIntervalHint(outcome.dataset.candles)),
      issues: outcome.issues.slice(0, 100),
      validationIssues: outcome.validationIssues.slice(0, 100),
      preview: outcome.preview,
      provenance: "user-uploaded — not licensed for redistribution",
    },
  });
}
