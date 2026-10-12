# Market Data Layer — Implementation Reference

Phase 3 deliverable: the deterministic historical market-data and candle-processing foundation
that all future intelligence engines consume. Rule contracts remain canonical in
[`docs/engine/01-market-data-contract.md`](../engine/01-market-data-contract.md); this document
describes the implemented layer in `src/lib/market-data/`.

## Pipeline

```
RawCandle[] (any provider shape)
  → normalize.ts      loose → strict Candle, timestamps → bar-open ms UTC
  → validation.ts     per-bar + series checks → DataValidationIssue[]
  → quality.ts        DataQualityReport (valid / valid_with_warnings / invalid)
  → CandleSeries      domain DTO — strictly ascending, duplicates reported not merged
  → aggregation.ts    5m → 15m → 1h → 4h…, complete windows only
  → replay.ts         HistoricalReplay → HistoricalContext (past-only view)
  → engines (Phase 4+)
```

## The candle convention

- `time` = **bar OPEN time, Unix epoch milliseconds, UTC** — one canonical convention.
- Local/IANA timezone rendering is presentation-layer only; the engine never converts.
- Optional fields (`volume`, `tradeCount`, `vwap`, `sessionId`, `exchange`) are omitted when a
  provider doesn't supply them — never invented.
- `RawCandle` is the untyped provider shape; `NormalizedCandle` adds identity
  (`id`, `symbol`, `timeframe`, `source`, `sourceTimestamp`) to `Candle`.

## Provider contract (`provider.ts`)

`HistoricalDataProvider.getCandles(request: MarketDataRequest) → Promise<ProviderResponse>`:

| In                                                                     | Out                                                                                             |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `asset`, `timeframe`, `start` (inclusive), `end` (exclusive), `limit?` | `{ ok: true, result: { candles, quality, source } }` or `{ ok: false, error: MarketDataError }` |

Error codes (spec 16): `invalid_request`, `unsupported_symbol`, `unsupported_timeframe`,
`data_not_available`, `provider_error`, `rate_limited`, `invalid_data`, `incomplete_data` —
returned, never thrown. `FixtureProvider` serves the named `FIX-*` datasets; real vendor
providers implement the same interface in later phases. Distinct from
`services/market-data.ts#MarketDataProvider` (the UI read seam).

## Validation (`validation.ts`)

Single-pass, O(n). Per bar: timestamp present/valid, OHLC finite, `high ≥ max(open,close,low)`,
`low ≤ min(open,close,high)`, `volume ≥ 0`, interval alignment (warning). Series level:
ordering vs last valid bar, duplicate timestamps, overlaps (`delta < interval`), and gaps.
**Corrupt data is never silently repaired** — issues are returned; `validBars` is the set that
passed.

## Quality (`quality.ts`)

`DataQualityReport` — every metric defined: `barCount` = input rows; `expectedBarCount` =
`calendar.expectedBars(start, end+interval)` (only when the calendar can count, e.g. 24/7);
`missingBarCount` = Σ gap bars; `coveragePct` = valid/expected ×100; `status` = `invalid` when
any error exists, `valid_with_warnings` when warnings exist, else `valid`. Info findings never
downgrade alone.

## Timeframes (`timeframes.ts`)

Canonical set: `1m 3m 5m 15m 30m 1h 2h 4h 6h 12h 1D 1W 1M`. Fixed durations in `TIMEFRAME_MS`;
`1M` is calendar-based (no fixed ms). `alignFloor` uses epoch multiples, UTC Monday for `1W`,
UTC month start for `1M` — no timezone or locale dependence.

## Aggregation (`aggregation.ts`)

open = first, high = max, low = min, close = last, volume = Σ **only when every source bar has
volume** (partial sums would lie). A target bar is emitted only for a fully-covered window —
trailing partial windows are dropped unless `allowPartial: true`. Non-divisible conversions
(`intervalDivisible`) and calendar targets (`1M`) produce nothing.

## Sessions (`sessions.ts`)

`SessionCalendar` — `isOpenAt(t)` + `expectedBars()`. Shipped: `alwaysOpen()` (24/7),
`weekdayUtc()` (Mon–Fri UTC), `sessionWindowUtc(open, close)` (e.g. NSE 03:45–10:00 UTC).
Exchange calendars (NSE/NYSE, holidays) plug in later by implementing the same contract.

## Gaps (spec 12)

`classifyGap`: no calendar → `unknown`; any missing bar inside an open session → `unexpected`
(warning); all missing bars in closed time (weekend/off-hours) → `expected` (info).

## Replay + look-ahead protection (`replay.ts`)

`HistoricalReplay(series, {startIndex, endIndex, step})` yields `HistoricalContext` per bar:
`currentIndex`, `timestamp`, `currentBar`, `visibleBars` (frozen slice 0..i), `remainingBars`
(count only — no data), `window(n)` (bounded history). **The full series is never handed to
the engine during replay** — future bars are structurally unreachable, the foundation of
spec-18 no-look-ahead backtesting. `CandleSeriesView` deep-freezes candles so nothing can
mutate history.

## Determinism (spec 15)

No clocks, no randomness, no network, no timezone/locale dependence. Same fixture + same code →
identical output, byte-for-byte; verified in `__tests__/determinism.test.ts`.

## Tests

`src/lib/market-data/__tests__/` — 9 files covering validation, ordering, duplicates, gaps,
aggregation, series immutability, provider contract, fixture determinism, replay bounds, and
look-ahead protection. Run: `npm test`.
