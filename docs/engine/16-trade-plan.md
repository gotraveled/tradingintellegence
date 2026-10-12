# 16 — Trade Plan Model

A `TradePlan` is a **structured analytical artifact** — the engine's answer to "if this setup
resolves, what did the evidence suggest?" It is **not** a trade recommendation, not an order, and
never connects to broker execution. The UI renders it labelled as analysis; the platform has no
order surface at all.

## Contract

```ts
interface TradePlan {
  setupId: ID;
  symbol: string;
  timeframe: Timeframe;

  direction: Direction; // from the setup — never inferred here

  /** Price band where the setup's entry condition fires (specs 12–14). */
  entryZone: { low: Price; high: Price; basis: string };
  /** "basis" names the evidence: e.g. "proximal half of demand zone dz-1" or "FVG fvg-3 band". */

  invalidation: { price: Price; basis: string; closeOnly: true };
  /** closeOnly is always true — wicks never invalidate (specs 11–14). */

  targets: PriceTarget[]; // ordered T1 → T3, each { label, price, reached? }
  riskReward?: number; // to the final target; absent until entry+targets exist

  score: Score; // evidence quality at confirmation (spec 15)
  scoreContributions: ScoreContribution[]; // the explainable breakdown — mandatory

  reasons: SetupReason[]; // met conditions
  conditionsPending: SetupReason[]; // unmet conditions — plan is honest about gaps

  /** Bar count after which the plan stales, from setup.expiryBars (11). */
  expiryBars: number;
  createdAt: ISODateTime;
  paramsVersion: string; // EngineParams version that produced it
}
```

## Rules

- A plan exists only while its setup is `confirmed`/`active`/`partial_target`. Terminal setups keep
  their plan for outcome measurement — marked `final: true` in metadata.
- `riskReward = (finalTarget − entryZone.mid) / (entryZone.mid − invalidation)` for longs (mirrored
  for shorts). Plans with `rr < score.minRR` are filtered upstream (15) — a low-RR plan never
  reaches output.
- `entryZone` and `invalidation` are **bands/levels with named evidence**, not magic numbers —
  `basis` must resolve to a zone, FVG, pool, or structure level.
- **Separation of concerns is contractual:** the engine emits the plan; nothing in the engine or
  API may submit, size, route, or execute orders. If broker features ever exist, they consume
  plans as read-only input.

## What a plan is not

- Not a guarantee, signal, or advice — the score's own definition (15) applies.
- Not a position size, leverage suggestion, or portfolio instruction.
- Not mutable after the setup resolves — the frozen plan is what outcome measurement (17) scores.
