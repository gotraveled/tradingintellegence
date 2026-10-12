import type { Candle, CandleSeries, UnixMs } from "@/lib/types";
import { CandleSeriesView } from "./series";

/**
 * Historical replay + look-ahead protection (spec 13 + 14).
 *
 * The engine NEVER receives the full CandleSeries during replay. Each step hands it a
 * `HistoricalContext` containing only bars that existed at that moment — future candles are
 * structurally unreachable, not merely "off-limits by convention."
 */

/** Everything knowable at one point in history. No future fields exist by construction. */
export interface HistoricalContext {
  /** Index into the original series — the bar just closed. */
  readonly currentIndex: number;
  readonly timestamp: UnixMs;
  /** Bars 0..currentIndex — a frozen slice; mutation attempts throw in strict mode. */
  readonly visibleBars: readonly Candle[];
  /** The bar at currentIndex. */
  readonly currentBar: Candle;
  /** Bars after currentIndex that the engine will see later — metadata only (count, not data). */
  readonly remainingBars: number;
  /** Permitted trailing window — explicitly bounded history for indicator-style access. */
  window(size: number): readonly Candle[];
}

export interface ReplayOptions {
  startIndex?: number;
  endIndex?: number;
  step?: number;
}

export class HistoricalReplay {
  private readonly view: CandleSeriesView;
  private readonly start: number;
  private readonly end: number;
  private readonly step: number;

  constructor(series: CandleSeries, options: ReplayOptions = {}) {
    this.view = new CandleSeriesView(series);
    const n = this.view.length;
    this.start = Math.max(0, options.startIndex ?? 0);
    this.end = Math.min(n - 1, options.endIndex ?? n - 1);
    this.step = Math.max(1, options.step ?? 1);
  }

  get totalBars(): number {
    return this.view.length;
  }

  /** Context for a given index — only bars ≤ index are reachable. */
  context(index: number): HistoricalContext {
    if (index < 0 || index >= this.view.length) {
      throw new RangeError(`index ${index} outside series of length ${this.view.length}`);
    }
    const view = this.view;
    const visible = Object.freeze(view.candles.slice(0, index + 1)) as readonly Candle[];
    const currentBar = view.candles[index];
    return Object.freeze({
      currentIndex: index,
      timestamp: currentBar.time,
      visibleBars: visible,
      currentBar,
      remainingBars: view.length - index - 1,
      window: (size: number) =>
        Object.freeze(visible.slice(Math.max(0, visible.length - size))) as readonly Candle[],
    });
  }

  /** Iterate contexts from startIndex through endIndex, step apart. */
  *iterate(): Generator<HistoricalContext, void, void> {
    for (let i = this.start; i <= this.end; i += this.step) {
      yield this.context(i);
    }
  }
}
