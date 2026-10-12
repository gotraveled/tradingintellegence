import type { Candle, CandleSeries } from "@/lib/types";

/**
 * Immutable view over a `CandleSeries` (spec 8).
 * Candles and the backing array are deep-frozen at construction — future engines cannot
 * accidentally mutate historical data. The raw `series.candles` array is never exposed.
 */
export class CandleSeriesView {
  readonly series: CandleSeries;
  /** Frozen defensive copy — the only array consumers may hold. */
  readonly candles: readonly Candle[];

  constructor(series: CandleSeries) {
    const frozen = series.candles.map((c) => Object.freeze({ ...c }));
    Object.freeze(frozen);
    this.series = series;
    this.candles = frozen as readonly Candle[];
  }

  get length(): number {
    return this.candles.length;
  }

  get first(): Candle | undefined {
    return this.candles[0];
  }

  get last(): Candle | undefined {
    return this.candles[this.candles.length - 1];
  }

  at(index: number): Candle | undefined {
    return this.candles[index];
  }

  /** New immutable view over a window — also frozen, never a mutable reference. */
  slice(start: number, end?: number): CandleSeriesView {
    return new CandleSeriesView({ ...this.series, candles: [...this.candles.slice(start, end)] });
  }

  timestamps(): readonly number[] {
    return this.candles.map((c) => c.time);
  }

  opens(): readonly number[] {
    return this.candles.map((c) => c.open);
  }

  highs(): readonly number[] {
    return this.candles.map((c) => c.high);
  }

  lows(): readonly number[] {
    return this.candles.map((c) => c.low);
  }

  closes(): readonly number[] {
    return this.candles.map((c) => c.close);
  }

  /** Undefined entries for candles that carry no volume — never invented. */
  volumes(): readonly (number | undefined)[] {
    return this.candles.map((c) => c.volume);
  }
}
