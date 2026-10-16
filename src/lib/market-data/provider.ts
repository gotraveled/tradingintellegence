import type {
  Candle,
  DataClassification,
  DataQualityReport,
  MarketDataError,
  MarketDataRequest,
  MarketDataSource,
  RawCandle,
  Timeframe,
} from "@/lib/types";
import { normalizeCandles } from "./normalize";

/**
 * Historical market-data provider contract (spec 6 + 16).
 * The engine layer consumes ONLY this interface — it never sees vendor-specific formats.
 * Real providers (REST vendors, Dhan, etc.) are future phases; the contract is already stable.
 *
 * Distinct from `services/market-data.ts#MarketDataProvider` — that is the UI-facing read seam;
 * this is the engine-layer historical pipeline.
 */

export interface MarketDataResult {
  /** Normalized, validated candles — strictly ascending, deduped by the provider's own rules. */
  candles: Candle[];
  /** Quality summary of what was returned — callers may gate on `status`. */
  quality: DataQualityReport;
  source: MarketDataSource;
  /**
   * Freshness classification of this response — set by the provider from vendor
   * evidence (e.g. Polygon's `DELAYED` aggregate status) or by the router's
   * declared capability row. Absent → callers treat as `"historical"`.
   * Never `"live"` from a REST aggregate read.
   */
  classification?: DataClassification;
  /** Warnings from normalization/validation even when `ok` — e.g. gaps, misalignment. */
  warnings?: string[];
}

export type ProviderResponse =
  { ok: true; result: MarketDataResult } | { ok: false; error: MarketDataError };

export interface HistoricalDataProvider {
  readonly source: MarketDataSource;
  /** Fetch normalized candles for a request. Errors are returned, never thrown. */
  getCandles(request: MarketDataRequest): Promise<ProviderResponse>;
  /** What this provider can serve — for `unsupported_symbol`/`unsupported_timeframe` checks. */
  supports(request: MarketDataRequest): boolean;
}

/** Deterministic error constructor — providers return structured errors, not exceptions. */
export function providerError(
  code: MarketDataError["code"],
  message: string,
  detail?: string,
): ProviderResponse {
  return { ok: false, error: { code, message, detail } };
}

// ---------------------------------------------------------------------------
// Fixture provider (spec 7) — deterministic, repository-backed test data.

export interface CandleFixture {
  name: string;
  symbol: string;
  timeframe: Timeframe;
  /** Loosely-typed rows — providers exercise the same normalization path as real feeds. */
  rows: RawCandle[];
  /** False selects a weekday-session calendar (gaps over weekends are expected, not corrupt). */
  is24x7?: boolean;
}

/**
 * Serves named fixtures from a registry. Same fixture + same request → identical output,
 * every time. Returns `data_not_available` for unknown names — no implicit fallbacks.
 */
export class FixtureProvider implements HistoricalDataProvider {
  readonly source: MarketDataSource = { id: "fixture", kind: "fixture", label: "Test fixtures" };
  private readonly fixtures: ReadonlyMap<string, CandleFixture>;
  /** Produces the quality report for a normalized slice — sees the fixture for calendar choice. */
  private readonly validate: (candles: Candle[], fixture: CandleFixture) => DataQualityReport;

  constructor(
    fixtures: CandleFixture[],
    validate: (candles: Candle[], fixture: CandleFixture) => DataQualityReport,
  ) {
    this.fixtures = new Map(fixtures.map((f) => [f.symbol, f]));
    this.validate = validate;
  }

  supports(request: MarketDataRequest): boolean {
    return this.fixtures.has(request.asset.symbol);
  }

  async getCandles(request: MarketDataRequest): Promise<ProviderResponse> {
    if (request.start >= request.end) {
      return providerError("invalid_request", "start must be before end");
    }
    const fixture = this.fixtures.get(request.asset.symbol);
    if (!fixture) {
      return providerError(
        "unsupported_symbol",
        `fixture '${request.asset.symbol}' not registered`,
      );
    }
    if (fixture.timeframe !== request.timeframe) {
      return providerError(
        "unsupported_timeframe",
        `fixture '${fixture.name}' is ${fixture.timeframe}, requested ${request.timeframe}`,
      );
    }

    const { candles } = normalizeCandles(fixture.rows);
    const inRange = candles.filter((c) => c.time >= request.start && c.time < request.end);
    const limited = request.limit !== undefined ? inRange.slice(0, request.limit) : inRange;

    // All normalized bars are returned unfiltered — nothing is silently repaired or dropped;
    // `quality` is the authoritative description of what the slice contains.
    const quality = this.validate(limited, fixture);
    return {
      ok: true,
      result: {
        candles: limited,
        quality,
        source: this.source,
        warnings: quality.warnings.map((w) => w.message),
      },
    };
  }
}
