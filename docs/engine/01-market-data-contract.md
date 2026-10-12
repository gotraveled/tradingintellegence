# 01 — Market Data Contract

Everything the engine computes starts from normalized candles. Providers convert their native
formats into this contract; the engine never sees provider-specific data.

## Normalized candle

```ts
interface Candle {
  /** Bar open time, Unix epoch milliseconds (UTC). */
  time: UnixMs;
  open: Price;
  high: Price;
  low: Price;
  close: Price;

  // Optional — a feed may omit any of them; the engine must cope.
  volume?: number; // Traded volume; absent for index/forex spot feeds.
  tradeCount?: number; // Number of trades in the bar.
  vwap?: number; // Volume-weighted average price for the bar.
  sessionId?: string; // Session the bar belongs to (see Session boundaries).
  exchange?: string; // Producing exchange when it differs per candle (aggregated feeds).
}
```

Rules:

- `high >= max(open, close, low)` and `low <= min(open, close, high)`; providers must enforce.
- A candle is **closed** only after `time + timeframeMs` has fully elapsed. The engine must
  distinguish a live (still-forming) bar from closed bars; most rules consume closed bars only
  (noted per rule).
- `volume` is optional, never zero-padded. Rules that use volume must declare a
  volume-unavailable fallback.

## Candle identity

A candle is uniquely identified by the tuple:

```
(symbol, exchange?, timeframe, openTime)
```

`exchange` participates because the same symbol can exist on multiple venues (e.g. spot crypto).
Two candles with the same identity but different OHLCV are a data error — the latest
normalized record wins and the conflict is surfaced in `metadata`.

## Series context

```ts
interface CandleSeries {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[]; // strictly ascending by `time`, no duplicates
  exchange?: string;
  assetClass?: AssetClass;
  timezone?: string; // IANA timezone used for session/day boundaries
  sessions?: MarketSession[]; // resolved from the Market record
  params: EngineParams; // parameter set + version stamp, for reproducibility
}
```

- `timezone` and `sessions` come from the `Market` record, not the data feed.
- `params` stamps the exact parameter set so any output can be reproduced.

## Sessions and non-24/7 markets

The engine must not assume continuous trading.

- `Market.sessions` defines local `open`/`close` times in the market's `timezone`
  (`MarketSession`, already in `types/domain/market.ts`). `Market.is24x7` marks continuous
  markets.
- A **gap** is any stretch between two consecutive closed candles larger than `timeframeMs` in a
  non-24/7 market. Expected gaps (overnight, weekend, holidays) come from the session calendar;
  unexpected gaps are flagged in `metadata` as `data_gap`.
- Session boundary events — session open/close, daily open, prior-session high/low — are
  computed from `sessions` and emitted as features for liquidity and structure rules.
- `sessionId` on a candle is the resolved session label (e.g. `"asia"`, `"london"`, `"newyork"`,
  `"nse_regular"`), assigned by the provider or derived from `sessions`; the engine treats it as
  opaque text.
- Multi-timeframe candle building aggregates from a finer timeframe, aligned to the market's
  session/day boundaries — never anchored to arbitrary offsets.

## Data quality requirements

Providers must report, per series:

- `coverage`: first/last available candle time.
- `missingBars`: count of expected-but-absent bars in non-24/7 markets.
- `source`: provider identifier.

The engine may refuse input where `missingBars` exceeds `params.maxMissingBarPct`
(default `2%`) — the stage returns `insufficient_data` rather than interpolating.

## Parameters introduced here

| Parameter          | Default | Meaning                                                                    |
| ------------------ | ------- | -------------------------------------------------------------------------- |
| `maxMissingBarPct` | `2`     | Max tolerable share of expected bars missing before a stage refuses input. |
