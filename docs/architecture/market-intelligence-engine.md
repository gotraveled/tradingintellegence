# Market Intelligence Engine — Architecture

> Canonical entry point for the engine specification. The rule-level contracts live in
> [`../engine/`](../engine/README.md) (00–22, numbered); this document is the architectural
> map — what the engine is, where it sits, and what it may never do.

## What it is

A **deterministic, testable market-analysis pipeline**. Given normalized candles + a versioned
configuration, it produces structured market evidence: swings, structure, liquidity, zones,
imbalances, momentum, setups, explainable scores, and measured outcomes. Every output is a number
or an enumerable state — never subjective language.

## Where it sits

```
Frontend (Next.js, this repo) → API boundary → Market Intelligence Engine → Market Data → Database
```

- The app depends only on the service seam (`src/lib/services/*`) and domain types
  (`src/lib/types/domain/*`). Detection logic never enters React components or API handlers.
- The engine is a separate, replaceable unit — interfaces in `src/lib/services/engine.ts`, config
  in `src/lib/types/domain/config.ts`. Implementations may live here (pure TS) or behind a
  service; the contracts are identical either way.

## The deterministic pipeline

```
CandleSeries ──→ SwingEngine ──→ MarketStructureEngine ──→ LiquidityEngine ─┐
       │                                                                    ├─→ SetupDetectionEngine ─→ OpportunityScoringEngine ─→ TradePlan
       ├─→ ZoneEngine ←─────────── (structure + pools)                      │            ↑                           ↑
       ├─→ ImbalanceEngine                                                │            │                           │
       ├─→ MomentumEngine (+ DisplacementEngine)                          ├────────────┘                           │
       ├─→ MultiTimeframeEngine (per-TF structure + momentum)             ┘                                    Opportunity
       └─→ MarketRegimeEngine ──────────────────────────────────────────────────────────────────────────────────→ SetupOutcome
```

Each arrow consumes only the outputs it declares — no engine re-detects upstream work.

## Non-negotiable invariants

| Invariant                                                         | Enforced by                              |
| ----------------------------------------------------------------- | ---------------------------------------- |
| Closed bars only; `confirmedIndex`/`confirmedAt` gates visibility | spec 18 + `state(t)` replay tests        |
| Same input + same `EngineConfig` → identical output               | pure contracts, `paramsVersion` stamps   |
| `insufficient_data` returned honestly — never fabricated          | `EngineErrorCode`, contract tests        |
| Score = evidence quality, never probability                       | spec 15, `ScoreContribution[]` mandatory |
| Setup lifecycle is a state machine, never scattered booleans      | spec 11, `SetupStatus`                   |
| No order placement / broker / exchange execution — anywhere       | architectural rule, spec 16              |

## Document map

| Area                       | Doc                                       |
| -------------------------- | ----------------------------------------- |
| Ground rules + pipeline    | `docs/engine/00-overview.md`              |
| Market data contract       | `docs/engine/01-market-data-contract.md`  |
| Swings                     | `docs/engine/02-swing-detection.md`       |
| Structure (BOS/CHOCH)      | `docs/engine/03-market-structure.md`      |
| Liquidity + sweeps         | `docs/engine/04-liquidity.md`             |
| Demand / supply zones      | `docs/engine/05–07`                       |
| FVG / imbalances           | `docs/engine/08-imbalances.md`            |
| Displacement + momentum    | `docs/engine/09-momentum.md`              |
| Multi-timeframe            | `docs/engine/10-multi-timeframe.md`       |
| Setup lifecycle + types    | `docs/engine/11–14`                       |
| Scoring                    | `docs/engine/15-opportunity-score.md`     |
| Trade plan                 | `docs/engine/16-trade-plan.md`            |
| Outcomes + ML schema       | `docs/engine/17-outcomes.md`              |
| Look-ahead bias            | `docs/engine/18-look-ahead.md`            |
| Regime                     | `docs/engine/19-regime.md`                |
| Engine contracts           | `docs/engine/20-engine-interfaces.md`     |
| Configuration              | `docs/engine/21-configuration.md`         |
| Testing                    | `docs/engine/22-testing.md`               |
| Contested definitions (v1) | `docs/engine/23-contested-definitions.md` |

## Explicitly out of scope (future phases)

Order placement, broker APIs (Dhan or any other), TradingView integration, exchange execution,
automated trading, real-money execution, and any AI/ML model — the deterministic pipeline and its
outcome dataset must exist and be validated first.
