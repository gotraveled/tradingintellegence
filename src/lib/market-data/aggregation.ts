import type { Candle, CandleSeries, Timeframe } from "@/lib/types";
import { alignFloor, intervalDivisible, timeframeMs } from "./timeframes";

/**
 * Deterministic timeframe aggregation (spec 10).
 * open = first open, high = max, low = min, close = last close, volume = Σ where present.
 * Only target windows fully covered by source bars are emitted — incomplete periods produce
 * NO candle unless `allowPartial` is explicitly requested.
 */

export interface AggregationOptions {
  /** Emit a trailing partial window (e.g. live-data use). Default false — strict coverage. */
  allowPartial?: boolean;
}

export interface AggregationResult {
  candles: Candle[];
  /** Source windows dropped for incomplete coverage — surfaced, not silent. */
  droppedWindows: number;
}

export function aggregateCandles(
  source: readonly Candle[],
  from: Timeframe,
  to: Timeframe,
  options: AggregationOptions = {},
): AggregationResult {
  if (!intervalDivisible(from, to)) {
    return { candles: [], droppedWindows: 0 };
  }
  const targetMs = timeframeMs(to);
  if (targetMs === undefined || source.length === 0) {
    return { candles: [], droppedWindows: 0 };
  }

  const out: Candle[] = [];
  let dropped = 0;
  let bucket: Candle[] = [];
  let bucketStart = -1;

  const flush = () => {
    const expected = targetMs / timeframeMs(from)!;
    if (bucket.length === expected || (options.allowPartial && bucket.length > 0)) {
      out.push(merge(bucket, bucketStart));
    } else if (bucket.length > 0) {
      dropped += 1;
    }
    bucket = [];
    bucketStart = -1;
  };

  for (const c of source) {
    const start = alignFloor(c.time, to);
    if (bucketStart !== -1 && start !== bucketStart) flush();
    if (bucketStart === -1) bucketStart = start;
    bucket.push(c);
  }
  flush();

  return { candles: out, droppedWindows: dropped };
}

/** Roll up a complete (or explicitly-allowed partial) window into one target bar. */
function merge(bucket: Candle[], time: number): Candle {
  const merged: Candle = {
    time,
    open: bucket[0].open,
    high: Math.max(...bucket.map((c) => c.high)),
    low: Math.min(...bucket.map((c) => c.low)),
    close: bucket[bucket.length - 1].close,
  };
  // Volume is summed only when every source bar carries it — partial sums would lie.
  if (bucket.every((c) => c.volume !== undefined)) {
    merged.volume = bucket.reduce((s, c) => s + (c.volume ?? 0), 0);
  }
  if (bucket.every((c) => c.tradeCount !== undefined)) {
    merged.tradeCount = bucket.reduce((s, c) => s + (c.tradeCount ?? 0), 0);
  }
  if (bucket.every((c) => c.vwap !== undefined)) {
    const vSum = bucket.reduce((s, c) => s + (c.volume ?? 0), 0);
    merged.vwap =
      vSum > 0
        ? bucket.reduce((s, c) => s + (c.vwap ?? 0) * (c.volume ?? 0), 0) / vSum
        : bucket[bucket.length - 1].vwap;
  }
  return merged;
}

/** Aggregate an entire series — preserves identity fields, replaces candles. */
export function aggregateSeries(
  series: CandleSeries,
  to: Timeframe,
  options: AggregationOptions = {},
): CandleSeries & { droppedWindows: number } {
  const { candles, droppedWindows } = aggregateCandles(
    series.candles,
    series.timeframe,
    to,
    options,
  );
  return { ...series, timeframe: to, candles, droppedWindows };
}
