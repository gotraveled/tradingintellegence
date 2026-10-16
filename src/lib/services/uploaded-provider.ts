/**
 * UploadedDatasetProvider — a `HistoricalDataProvider` backed by user-supplied
 * OHLC data (Phase P2). It plugs CSV-imported candles into the canonical
 * analysis/backtest pipeline without touching engine code or provider routing.
 *
 * Provenance & rights:
 * - `source.kind: "file"` — the dataset is the user's upload, not a vendor feed.
 * - `classification` is always `"historical"` — uploaded data is archival by
 *   definition; never claimed fresh.
 * - No display-rights implications: the data never enters a vendor serving
 *   path; it is analyzed for the uploader's own session only.
 * - Gap semantics: `is24x7` selects the gap calendar; otherwise weekday gaps
 *   are the conservative default (same rule fixtures use).
 */
import type {
  Candle,
  DataClassification,
  MarketDataRequest,
  MarketDataSource,
  Timeframe,
} from "@/lib/types";
import type {
  HistoricalDataProvider,
  ProviderResponse,
} from "@/lib/market-data/provider";
import { providerError } from "@/lib/market-data/provider";
import { buildQualityReport } from "@/lib/market-data/quality";
import { calendarFor, type SessionCalendar } from "@/lib/market-data/sessions";

export interface UploadedSeries {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  /** False selects a weekday-session calendar for gap classification. */
  is24x7?: boolean;
}

export class UploadedDatasetProvider implements HistoricalDataProvider {
  readonly source: MarketDataSource = {
    id: "uploaded-csv",
    kind: "file",
    label: "User-uploaded dataset",
  };
  private readonly series: ReadonlyMap<string, UploadedSeries>;

  constructor(series: UploadedSeries[]) {
    this.series = new Map(
      series.map((s) => [`${s.symbol}@${s.timeframe}`, s]),
    );
  }

  supports(request: MarketDataRequest): boolean {
    const s = this.series.get(`${request.asset.symbol}@${request.timeframe}`);
    return s !== undefined && s.candles.length > 0;
  }

  async getCandles(request: MarketDataRequest): Promise<ProviderResponse> {
    if (request.start >= request.end) {
      return providerError("invalid_request", "start must be before end");
    }
    const s = this.series.get(`${request.asset.symbol}@${request.timeframe}`);
    if (!s) {
      return providerError(
        "unsupported_symbol",
        `no uploaded dataset for '${request.asset.symbol}' at ${request.timeframe}`,
      );
    }
    const inRange = s.candles
      .filter((c) => c.time >= request.start && c.time < request.end)
      .sort((a, b) => a.time - b.time);
    if (inRange.length === 0) {
      return providerError(
        "data_not_available",
        `the uploaded dataset has no bars inside the requested window`,
      );
    }
    const calendar: SessionCalendar = calendarFor({ is24x7: s.is24x7 === true });
    const quality = buildQualityReport({
      symbol: s.symbol,
      timeframe: s.timeframe,
      candles: inRange,
      calendar,
    });
    const classification: DataClassification = "historical";
    return {
      ok: true,
      result: {
        candles: inRange,
        quality,
        source: this.source,
        classification,
        warnings: [
          `dataset: user-uploaded, ${s.candles.length} bars — not a licensed feed`,
          ...quality.warnings.map((w) => w.message),
        ],
      },
    };
  }
}

/** Convenience: normalize a parse result's rows for provider construction. */
export function toUploadedSeries(input: {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  is24x7?: boolean;
}): UploadedSeries {
  return {
    symbol: input.symbol,
    timeframe: input.timeframe,
    candles: input.candles,
    ...(input.is24x7 !== undefined ? { is24x7: input.is24x7 } : {}),
  };
}
