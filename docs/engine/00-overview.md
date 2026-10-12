# 00 — Engine Overview

## Objective

Specify a market intelligence engine that converts normalized OHLCV candles into labelled,
explainable market state: structure, liquidity, zones, momentum, setups, opportunity scores, and
historical outcomes. Every concept is a deterministic rule with explicit parameters — not a
subjective judgement.

**This document defines contracts.** Detection algorithms are implemented in a later phase, in a
separate service, behind the interfaces in `src/lib/services`.

## Processing pipeline

```
MARKET DATA            normalized candles (01-market-data-contract.md)
        ↓
DETERMINISTIC FEATURES swings, ATR, ranges, session markers (02-swing-detection.md, …)
        ↓
STRUCTURE            HH/HL/LH/LL, BOS, CHOCH, trend state
        ↓
LIQUIDITY            pools, equal highs/lows, sweeps
        ↓
ZONES                demand/supply origins, freshness, retests
        ↓
MOMENTUM             displacement, volatility regime, compression
        ↓
SETUP DETECTION      reversal / breakout / continuation condition tables
        ↓
OPPORTUNITY SCORE    weighted evidence → 0–100 quality score
        ↓
HISTORICAL OUTCOME   labelled outcomes (R-multiples) per setup instance
        ↓
ML / AI              later phase, trained on the labelled dataset above
```

Each stage consumes only the output of earlier stages plus raw candles. Stage boundaries are
defined by the domain types in `src/lib/types/domain`, so each stage is independently testable
and replaceable.

## Why deterministic first

- No AI model is required for the engine to function end-to-end.
- Deterministic labels produce the objective historical dataset that later ML/AI will train and
  be validated against. Training on subjective labels would not be reproducible.
- A deterministic rule can be unit-tested on hand-crafted candle sequences — a model cannot.

## Correctness principles

1. **No look-ahead.** At bar `t`, the engine may only use candles `0…t`. Every spec states the
   _confirmation bar_ — the first bar at which an event becomes visible in a backtest.
2. **Point-in-time outputs.** Where an entity can be revised (e.g. swings), the spec defines the
   lifecycle states (`developing` → `confirmed` → `invalidated`) and revision rules explicitly.
3. **Parameter versioning.** Thresholds and window sizes are inputs, not constants. Each
   parameter set is a named `EngineParams` object so results are reproducible and comparable.
4. **Market-agnostic.** The engine never assumes 24/7 trading, a fixed session length, or a
   specific tick size. Market properties come from `Market`/`Asset` records.
5. **Explainable output.** Every emitted entity carries the evidence that produced it (candle
   indices/timestamps, thresholds met) so the UI can show _why_.

## Failure and honesty model

- If input data is insufficient (too few candles, unknown tick size), the engine returns
  `insufficient_data` for that stage rather than guessing.
- If two rules conflict (e.g. structure says uptrend, momentum is bearish), both facts are
  emitted; conflict resolution lives in setup detection and scoring, where it is explicit.
- The engine reports coverage: which stages produced output and which were skipped. The UI shows
  "not connected"/empty states for missing stages — it never fabricates them.

## Testing requirements (apply to every later document)

- **Golden fixtures.** Each rule ships with hand-crafted candle fixtures and expected output.
- **Property tests.** Determinism (repeat runs identical), no look-ahead (truncate input → same
  prefix output), monotonicity where claimed (e.g. higher ATR → wider zones).
- **Edge cases.** Flat candles, gaps (session opens), equal highs/lows, single-bar ranges,
  missing volume.
- **Serialization round-trip.** Engine output must serialize to the domain types without loss.
