import type { EngineParams, ID, ISODateTime, Price, Timeframe, UnixMs } from "./common";

export type AssetClass = "equities" | "indices" | "forex" | "crypto" | "commodities" | "futures";

export type MarketSegmentId =
  "crypto" | "forex" | "commodities" | "indices" | "us-stocks" | "indian-markets";

export interface MarketSession {
  id: string;
  name: string;
  /** IANA timezone, e.g. "America/New_York". */
  timezone: string;
  /** Local session open/close in HH:mm (24h) within `timezone`. */
  open: string;
  close: string;
}

/** A venue or grouping of tradable assets (e.g. NSE, US equities, spot crypto). */
export interface Market {
  id: ID;
  segment: MarketSegmentId;
  name: string;
  timezone: string;
  sessions: MarketSession[];
  /** True for markets that trade continuously (e.g. crypto). */
  is24x7?: boolean;
}

/** A tradable instrument. */
export interface Asset {
  id: ID;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  marketId: ID;
  exchange?: string;
  baseCurrency?: string;
  quoteCurrency: string;
  /** Decimal places used when displaying prices. */
  pricePrecision: number;
  tickSize?: number;
  isActive?: boolean;
}

/**
 * Normalized candle (docs/engine/01-market-data-contract.md). Optional fields may be omitted by
 * the feed; rules that need them must declare a fallback.
 */
export interface Candle {
  /** Bar open time. */
  time: UnixMs;
  open: Price;
  high: Price;
  low: Price;
  close: Price;
  volume?: number;
  tradeCount?: number;
  vwap?: number;
  /** Resolved session label (e.g. "london", "nse_regular"); opaque to the engine. */
  sessionId?: string;
  /** Producing venue when a feed aggregates per-candle. */
  exchange?: string;
  /** Present on aggregated feeds where the asset class varies per candle. */
  assetClass?: AssetClass;
}

export interface CandleSeries {
  symbol: string;
  timeframe: Timeframe;
  /** Strictly ascending by `time`, no duplicates. */
  candles: Candle[];
  exchange?: string;
  assetClass?: AssetClass;
  /** IANA timezone used for session/day boundaries (from the Market record). */
  timezone?: string;
  sessions?: MarketSession[];
  /** Parameter set + version stamp so outputs can be reproduced exactly. */
  params?: EngineParams;
}

export interface Quote {
  symbol: string;
  last: Price;
  change: number;
  changePercent: number;
  updatedAt: ISODateTime;
}

// ---------------------------------------------------------------------------
// Phase 3 — historical market-data layer (docs/market-data).

/** Minimal identity for requesting data about a tradable instrument. */
export interface AssetIdentifier {
  symbol: string;
  assetClass?: AssetClass;
  /** Producing venue when known (e.g. "BINANCE", "NSE"). */
  exchange?: string;
  /** Links to the Market record for session/day-boundary rules. */
  marketId?: ID;
}

/** Where candles come from — a provider implementation, never a raw vendor name in output. */
export interface MarketDataSource {
  id: string;
  kind: "fixture" | "file" | "rest" | "websocket" | "database";
  label: string;
}

/**
 * Candle as a provider feed might emit it — untyped, unvalidated.
 * Fields are loosely typed on purpose: normalization converts to `Candle` and reports issues.
 */
export interface RawCandle {
  /** Any timestamp representation a feed might send (ms, seconds, ISO string). */
  time?: number | string;
  open?: number | string;
  high?: number | string;
  low?: number | string;
  close?: number | string;
  volume?: number | string;
  [key: string]: unknown;
}

/**
 * Fully normalized candle — `Candle` fields plus the identity the spec requires on each bar.
 * Timestamp convention: **`time` is the bar OPEN time in Unix epoch ms, UTC.** Day/session
 * alignment is UTC-based; local-timezone rendering is a presentation concern.
 */
export interface NormalizedCandle extends Candle {
  id: ID;
  symbol: string;
  timeframe: Timeframe;
  assetClass?: AssetClass;
  /** Which provider emitted this bar (audit trail). */
  source?: string;
  /** Provider's own timestamp when it differs from the bar-open convention. */
  sourceTimestamp?: UnixMs;
}

/** Normalized request shape every provider must accept. */
export interface MarketDataRequest {
  asset: AssetIdentifier;
  timeframe: Timeframe;
  /** Inclusive bar-open time range. */
  start: UnixMs;
  /** Exclusive end — bars with time >= end are excluded. */
  end: UnixMs;
  limit?: number;
}

/** Structured provider failure codes (spec 16). */
export type MarketDataErrorCode =
  | "invalid_request"
  | "unsupported_symbol"
  | "unsupported_timeframe"
  | "data_not_available"
  | "provider_error"
  | "rate_limited"
  | "invalid_data"
  | "incomplete_data";

export interface MarketDataError {
  code: MarketDataErrorCode;
  message: string;
  /** Provider-specific detail for debugging — never drives control flow. */
  detail?: string;
}

export type ValidationSeverity = "error" | "warning" | "info";

export type ValidationIssueCode =
  | "missing_timestamp"
  | "invalid_timestamp"
  | "non_finite_ohlc"
  | "invalid_ohlc_relationship"
  | "negative_volume"
  | "misaligned_interval"
  | "out_of_order"
  | "duplicate_timestamp"
  | "overlapping_candle"
  | "gap_expected"
  | "gap_unexpected"
  | "gap_unknown"
  | "missing_candle";

export interface DataValidationIssue {
  code: ValidationIssueCode;
  severity: ValidationSeverity;
  /** Bar index in the validated array, when the issue is bar-specific. */
  index?: number;
  /** Bar-open time involved, when known. */
  timestamp?: UnixMs;
  message: string;
}

export type DataGapKind = "expected" | "unexpected" | "unknown";

/** A stretch of missing bars between two observed timestamps. */
export interface DataGap {
  kind: DataGapKind;
  /** Time of the last observed bar before the gap. */
  afterTime: UnixMs;
  /** Time of the first observed bar after the gap. */
  beforeTime: UnixMs;
  /** Number of interval-length bars absent in between. */
  missingBars: number;
}

export type DataQualityStatus = "valid" | "valid_with_warnings" | "invalid";

/** Deterministic data-quality summary (spec 5) — every metric defined, none invented. */
export interface DataQualityReport {
  symbol: string;
  timeframe: Timeframe;
  startTimestamp?: UnixMs;
  endTimestamp?: UnixMs;
  barCount: number;
  /** Computable only for calendars that can count trading intervals (e.g. 24/7). */
  expectedBarCount?: number;
  missingBarCount: number;
  duplicateCount: number;
  invalidBarCount: number;
  outOfOrderCount: number;
  gaps: DataGap[];
  /** valid bars / expected bars × 100; absent when expectedBarCount is undefined. */
  coveragePct?: number;
  warnings: DataValidationIssue[];
  errors: DataValidationIssue[];
  /** Informational findings (e.g. expected weekend gap) — never downgrade status. */
  info: DataValidationIssue[];
  status: DataQualityStatus;
}

// ---------------------------------------------------------------------------
// Chart candles boundary — POST /api/candles.
//
// A bounded historical-candles read for the chart surface: one symbol, one canonical
// timeframe, either an explicit [from, to) window or a bounded `bars` lookback ending
// at `to` (default: server time). The response carries the provider's own normalized
// candles and spec-5 quality report verbatim — the API never fills gaps, synthesizes
// bars, or rewrites provider data.

/** Historical-candles request. `from` (inclusive) + `to` (exclusive) OR `bars` lookback. */
export interface CandlesRequest {
  /** Catalog symbol preferred; unknown symbols pass through to the provider's own support check. */
  symbol: string;
  timeframe: Timeframe;
  /** Inclusive window start (ISO timestamp). Mutually exclusive with `bars`. */
  from?: ISODateTime;
  /** Exclusive window end (ISO timestamp); defaults to server time at the request. */
  to?: ISODateTime;
  /** Lookback depth in bars ending at `to`; bounded server-side. */
  bars?: number;
}

/** Successful candles read — including an honestly empty (zero-bar) window. */
export interface CandlesResult {
  /** Symbol as requested (trimmed, uppercased). */
  symbol: string;
  /** Resolved identity — catalog metadata when known, `{symbol}` only otherwise. Never invented. */
  asset: AssetIdentifier;
  timeframe: Timeframe;
  /** Actual exclusive-end window fetched (start aligned to the timeframe boundary). */
  window: { start: UnixMs; end: UnixMs };
  /** Provider-normalized candles, ascending, deduplicated — verbatim, gaps preserved. */
  candles: Candle[];
  candleCount: number;
  /** Spec-5 quality report — gap metrics include *expected* closures, not only defects. */
  quality: DataQualityReport;
  source: MarketDataSource;
  /** Always "historical" — aggregates from a REST provider; never live or streaming. */
  classification: "historical";
  /** Server retrieval time of this response. */
  retrievedAt: ISODateTime;
  /** The actual vendor ticker served, when it differs from the requested symbol (e.g. X:BTCUSD). */
  servedTicker?: string;
  /** Provider warnings (rejected rows, ticker alias) — surfaced, never hidden. */
  warnings: string[];
}
