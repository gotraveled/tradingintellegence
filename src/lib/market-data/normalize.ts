import type { Candle, DataValidationIssue, RawCandle } from "@/lib/types";

/**
 * Raw → normalized conversion (spec 3). The pipeline is
 * RawCandle[] → normalize → validate → CandleSeries — providers never emit domain types the
 * engines consume directly.
 */

const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

/** Accepts ms epoch, seconds epoch, or ISO-8601 — output is always bar-open ms, UTC. */
export function normalizeTimestamp(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    // Heuristic: < 1e12 is seconds epoch, >= is ms. Documented, deterministic.
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === "string") {
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export interface NormalizeResult {
  candles: Candle[];
  /** Raw rows that could not be converted — surfaced, never dropped silently. */
  rejected: { index: number; raw: RawCandle; reason: string }[];
  issues: DataValidationIssue[];
}

/**
 * Convert loosely-typed provider rows into `Candle` records. Only the four OHLC + time are
 * required; optional fields pass through when present and are omitted otherwise.
 */
export function normalizeCandles(raw: RawCandle[]): NormalizeResult {
  const candles: Candle[] = [];
  const rejected: NormalizeResult["rejected"] = [];
  const issues: DataValidationIssue[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const r = raw[i];
    const time = normalizeTimestamp(r.time);
    const open = num(r.open);
    const high = num(r.high);
    const low = num(r.low);
    const close = num(r.close);

    if (
      time === undefined ||
      open === undefined ||
      high === undefined ||
      low === undefined ||
      close === undefined
    ) {
      rejected.push({ index: i, raw: r, reason: "missing or non-numeric required field(s)" });
      issues.push({
        code: "missing_timestamp",
        severity: "error",
        index: i,
        message: `row ${i}: required field(s) missing or non-numeric`,
      });
      continue;
    }

    const candle: Candle = { time, open, high, low, close };
    const volume = num(r.volume);
    if (volume !== undefined) candle.volume = volume;
    const vwap = num(r.vwap);
    if (vwap !== undefined) candle.vwap = vwap;
    const tradeCount = num(r.tradeCount);
    if (tradeCount !== undefined) candle.tradeCount = tradeCount;
    if (typeof r.exchange === "string") candle.exchange = r.exchange;
    if (typeof r.session === "string") candle.sessionId = r.session;

    candles.push(candle);
  }

  return { candles, rejected, issues };
}
