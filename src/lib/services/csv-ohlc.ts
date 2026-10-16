/**
 * User-uploaded OHLCV CSV parser + validator (Phase P2 — user-supplied data engine).
 *
 * Pipeline: raw text → delimiter/header detection → column mapping → per-row
 * parsing → `normalizeCandles` → `validateSeries` (the canonical spec-4 checks:
 * OHLC envelope, duplicates, ordering, gaps). NOTHING is silently repaired —
 * malformed rows are rejected with row-level actionable messages.
 *
 * Provenance rule: the parsed dataset is tagged `source.kind: "file"` and is
 * NEVER presented as licensed for redistribution — the user owns the upload;
 * the platform only analyzes it.
 */
import type { Candle, DataValidationIssue, Timeframe } from "@/lib/types";
import { normalizeCandles, normalizeTimestamp } from "@/lib/market-data/normalize";
import { validateSeries } from "@/lib/market-data/validation";
import { calendarFor } from "@/lib/market-data/sessions";

/** Abuse bounds — bounded work per request, same posture as the API routes. */
export const CSV_MAX_BYTES = 8 * 1024 * 1024; // 8 MB text ceiling
export const CSV_MAX_ROWS = 60_000;
export const CSV_PREVIEW_ROWS = 8;

export interface CsvColumnMapping {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface CsvParseIssue {
  row: number; // 1-based line number in the original file (header = 1)
  field?: string;
  message: string;
}

export interface ParsedOhlcDataset {
  symbol?: string;
  timeframe?: Timeframe;
  candles: Candle[];
  /** Human-usable mapping summary for the provenance line. */
  mapping: Required<CsvColumnMapping> | CsvColumnMapping;
  delimiter: string;
  /** Accepted row count after normalization (before window filtering). */
  rowCount: number;
  rejectedCount: number;
}

export interface CsvImportResult {
  ok: true;
  dataset: ParsedOhlcDataset;
  /** Row-level parse issues — malformed values surfaced, never hidden. */
  issues: CsvParseIssue[];
  /** Series-level spec-4 findings (dupes, ordering, gaps, misalignment). */
  validationIssues: DataValidationIssue[];
  preview: { headers: string[]; rows: string[][] };
  stats: {
    firstBar: number;
    lastBar: number;
    gaps: number;
    duplicates: number;
    outOfOrder: number;
    invalidBars: number;
  };
}

export type CsvImportOutcome =
  | CsvImportResult
  | { ok: false; error: string; issues?: CsvParseIssue[] };

// ---------------------------------------------------------------------------
// Delimiter + header detection
// ---------------------------------------------------------------------------

const DELIMITERS = [",", ";", "\t", "|"] as const;

/** Split one CSV line respecting double-quoted fields (RFC 4180 subset). */
function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/** Score a delimiter by how consistently it splits the first lines into ≥5 fields. */
function detectDelimiter(lines: string[]): string {
  let best: string = ",";
  let bestScore = 0;
  for (const d of DELIMITERS) {
    const counts = lines.slice(0, 10).map((l) => splitCsvLine(l, d).length);
    const fivePlus = counts.filter((c) => c >= 5).length;
    const consistent = counts.every((c) => c === counts[0]);
    const score = fivePlus * 10 + (consistent ? 5 : 0) + counts[0];
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Column-mapping detection
// ---------------------------------------------------------------------------

const TIME_ALIASES = new Set([
  "time", "date", "datetime", "timestamp", "date time", "date/time",
  "gmt time", "time utc", "utc", "ts", "epoch",
]);
const OPEN_ALIASES = new Set(["open", "o", "open price", "openprice"]);
const HIGH_ALIASES = new Set(["high", "h", "high price", "highprice"]);
const LOW_ALIASES = new Set(["low", "l", "low price", "lowprice"]);
const CLOSE_ALIASES = new Set([
  "close", "c", "close price", "closeprice", "adj close", "adjclose", "last", "last price",
]);
const VOLUME_ALIASES = new Set(["volume", "vol", "v", "tickvol", "tick volume", "real volume"]);
/** Columns that must not satisfy the required mapping on their own. */
const IGNORED_HINT = new Set(["symbol", "ticker", "change", "change%", "chg", "chg%", "name"]);

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/<[^>]*>/g, "").trim();
}

export function detectColumnMapping(headers: string[]): CsvColumnMapping | undefined {
  const find = (aliases: Set<string>): number | undefined => {
    const idx = headers.findIndex((h) => aliases.has(normalizeHeader(h)));
    return idx === -1 ? undefined : idx;
  };
  const time = find(TIME_ALIASES);
  const open = find(OPEN_ALIASES);
  const high = find(HIGH_ALIASES);
  const low = find(LOW_ALIASES);
  const close = find(CLOSE_ALIASES);
  if (time === undefined || open === undefined || high === undefined ||
      low === undefined || close === undefined) {
    return undefined;
  }
  const volume = find(VOLUME_ALIASES);
  return volume === undefined ? { time, open, high, low, close } : { time, open, high, low, close, volume };
}

/**
 * Positional fallback for headerless files: try the canonical layouts
 * time,O,H,L,C[,V] and O,H,L,C,V,time (both exist in exports). Verified by
 * actually parsing sample rows — a layout only wins if values decode.
 */
export function detectPositionalMapping(rows: string[][]): CsvColumnMapping | undefined {
  const layouts: CsvColumnMapping[] = [
    { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 },
    { open: 0, high: 1, low: 2, close: 3, volume: 4, time: 5 },
    { time: 0, open: 1, high: 2, low: 3, close: 4 },
  ];
  const sample = rows.slice(0, 20);
  for (const layout of layouts) {
    let hits = 0;
    for (const row of sample) {
      const t = normalizeTimestamp(row[layout.time]);
      const nums = [layout.open, layout.high, layout.low, layout.close]
        .map((i) => Number(row[i]));
      if (t !== undefined && nums.every(Number.isFinite)) hits += 1;
    }
    if (sample.length > 0 && hits / sample.length >= 0.8) return layout;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface CsvImportOptions {
  /** Explicit column indexes — overrides header/positional detection. */
  mapping?: CsvColumnMapping;
  /** Declared timeframe — enables alignment + gap checks. */
  timeframe?: Timeframe;
  /** Declared symbol — provenance only, never used to guess columns. */
  symbol?: string;
  /** 24/7 asset? selects the gap calendar (weekday vs always-open). */
  is24x7?: boolean;
}

export function parseOhlcCsv(text: string, opts: CsvImportOptions = {}): CsvImportOutcome {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, error: "The file is empty — nothing to import." };
  }
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > CSV_MAX_BYTES) {
    return { ok: false, error: `File is ${(bytes / 1024 / 1024).toFixed(1)} MB — the limit is ${CSV_MAX_BYTES / 1024 / 1024} MB.` };
  }

  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length > CSV_MAX_ROWS + 1) {
    return { ok: false, error: `File has ${lines.length} rows — the limit is ${CSV_MAX_ROWS} data rows.` };
  }
  if (lines.length < 2) {
    return { ok: false, error: "File needs a header plus at least one data row." };
  }

  const delimiter = detectDelimiter(lines);
  const grid = lines.map((l) => splitCsvLine(l, delimiter).map((f) => f.trim()));

  // Header vs headerless: a first row that decodes as data → no header.
  let headers: string[] | undefined;
  let dataStart = 0;
  let mapping = opts.mapping;
  if (mapping === undefined) {
    const detected = detectColumnMapping(grid[0]);
    if (detected !== undefined) {
      mapping = detected;
      headers = grid[0];
      dataStart = 1;
    } else {
      const positional = detectPositionalMapping(grid.slice(0, 25));
      if (positional === undefined) {
        const named = grid[0]
          .map((h, i) => (normalizeHeader(h) ? `"${grid[0][i]}"` : `col ${i}`))
          .join(", ");
        return {
          ok: false,
          error:
            "Could not identify the time/open/high/low/close columns. Found: " +
            named +
            ". Supply an explicit column mapping or export a standard OHLCV layout.",
        };
      }
      mapping = positional;
    }
  }

  const rows = grid.slice(dataStart);
  const issues: CsvParseIssue[] = [];
  const raw: { time?: string; open?: string; high?: string; low?: string; close?: string; volume?: string }[] = [];
  const maxCol = rows.reduce((m, r) => Math.max(m, r.length), 0);
  if (mapping.time >= maxCol || mapping.open >= maxCol || mapping.high >= maxCol ||
      mapping.low >= maxCol || mapping.close >= maxCol) {
    return {
      ok: false,
      error: "The chosen column mapping points beyond the file's columns. Check the mapping indexes.",
    };
  }

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const lineNo = i + dataStart + 1;
    if (r.length <= Math.max(mapping.time, mapping.open, mapping.high, mapping.low, mapping.close)) {
      issues.push({ row: lineNo, message: "row has fewer fields than the mapping requires — skipped" });
      continue;
    }
    raw.push({
      time: r[mapping.time],
      open: r[mapping.open],
      high: r[mapping.high],
      low: r[mapping.low],
      close: r[mapping.close],
      ...(mapping.volume !== undefined ? { volume: r[mapping.volume] } : {}),
    });
  }

  if (raw.length === 0) {
    return { ok: false, error: "No data rows survived parsing — check the file layout.", issues };
  }

  // Canonical normalization — timestamps, numeric coercion, rejection tracking.
  const { candles, rejected } = normalizeCandles(raw);
  for (const rej of rejected) {
    issues.push({
      row: rej.index + dataStart + 1,
      message: `required field missing or non-numeric — ${JSON.stringify(rej.raw).slice(0, 120)}`,
    });
  }
  if (candles.length === 0) {
    return {
      ok: false,
      error: "Every row was malformed — no usable OHLC values found. Check the delimiter and column mapping.",
      issues,
    };
  }

  // Canonical series validation — ordering, duplicates, OHLC envelope, gaps.
  const calendar = opts.is24x7 === false ? calendarFor({ is24x7: false }) : undefined;
  const validation = opts.timeframe
    ? validateSeries(candles, opts.timeframe, calendar)
    : { issues: [] as DataValidationIssue[], validBars: candles, duplicateCount: 0, outOfOrderCount: 0, invalidBarCount: 0, gaps: [] };

  const ordered = [...candles].sort((a, b) => a.time - b.time);
  const stats = {
    firstBar: ordered[0].time,
    lastBar: ordered[ordered.length - 1].time,
    gaps: validation.gaps.length,
    duplicates: validation.duplicateCount,
    outOfOrder: validation.outOfOrderCount,
    invalidBars: validation.invalidBarCount,
  };

  // Inferred interval hint when the user didn't declare a timeframe — reported,
  // never assumed: callers still require an explicit timeframe for analysis.
  const dataset: ParsedOhlcDataset = {
    ...(opts.symbol !== undefined ? { symbol: opts.symbol } : {}),
    ...(opts.timeframe !== undefined ? { timeframe: opts.timeframe } : {}),
    candles,
    mapping,
    delimiter,
    rowCount: candles.length,
    rejectedCount: rejected.length,
  };

  return {
    ok: true,
    dataset,
    issues,
    validationIssues: validation.issues,
    preview: {
      headers: headers ?? grid[0].map((_, i) => `column ${i + 1}`),
      rows: grid.slice(dataStart, dataStart + CSV_PREVIEW_ROWS),
    },
    stats,
  };
}

/** Median inter-bar delta — a hint for the user when timeframe is undeclared. */
export function inferIntervalHint(candles: Candle[]): number | undefined {
  if (candles.length < 3) return undefined;
  const deltas: number[] = [];
  const ordered = [...candles].sort((a, b) => a.time - b.time);
  for (let i = 1; i < ordered.length; i += 1) {
    deltas.push(ordered[i].time - ordered[i - 1].time);
  }
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  return Number.isFinite(median) && median > 0 ? median : undefined;
}

export const IGNORED_HINT_EXPORT = IGNORED_HINT; // kept for tests/documentation
