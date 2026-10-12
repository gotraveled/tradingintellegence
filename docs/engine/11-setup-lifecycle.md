# 11 — Setup Lifecycle (Universal State Machine)

Every setup type (reversal, breakout, continuation — and any future type) uses the same state
machine. Scattered booleans are forbidden: a setup is in exactly one state, and every transition
has a named trigger recorded in `metadata.transitionReason`.

## States

```
DEVELOPING ──(required conditions all met)──→ CONFIRMED
    │                                            │
    │                                            └──(entry condition reached / price enters
    │                                               the entry band)──→ ACTIVE
    │                                                                   │
    │                                   ┌──(partial target hit)─────────┤
    │                                   ↓                               ↓
    │                            PARTIAL_TARGET ──(final target)──→ TARGET_REACHED
    │                                                               │     │
    │                                                               └──(close through
    │                                                                   invalidation)──→ INVALIDATED
    └──(conditions stale / pre-empted)──→ CANCELLED                     │
                └──────────────────────→ EXPIRED ←──────────────────────┘
```

| State            | Meaning                                                                                                                                                                                                                                                 | Terminal? |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `developing`     | Some required conditions met; missing ones listed in `reasons[].met = false`.                                                                                                                                                                           | No        |
| `confirmed`      | All required conditions met — the setup _qualifies_; entry band may not be reached yet.                                                                                                                                                                 | No        |
| `active`         | Price entered the defined entry band after confirmation.                                                                                                                                                                                                | No        |
| `partial_target` | At least one target reached, final target not; invalidation unchanged.                                                                                                                                                                                  | No        |
| `target_reached` | Final target reached.                                                                                                                                                                                                                                   | Yes       |
| `invalidated`    | Close through the invalidation level (close-only — wicks do not invalidate).                                                                                                                                                                            | Yes       |
| `expired`        | `setup.expiryBars` elapsed without becoming `active` (confirmed) or without target/invalidation (active).                                                                                                                                               | Yes       |
| `cancelled`      | A required condition failed _before_ confirmation (e.g. the liquidity pool got swept by someone else's flow first) or the setup's context changed (e.g. opposing CHOCH before confirmation). Distinct from `expired` — something actively disproved it. | Yes       |

## Transition rules

- Transitions occur only at **bar close** on the setup's own timeframe — never intrabar.
- `developing → confirmed` requires **every** required condition `met: true`. Optional conditions
  never block confirmation; they add score.
- `confirmed → active` requires price to _enter the entry band_ — a bar's range overlapping
  `[entryBandLow, entryBandHigh]` (wick counts — the fill zone was touched).
- `invalidated` is close-through the invalidation level by `setup.invalidateAtr × ATR`.
- `partial_target` fires per-target; `target_reached` only when the final target is reached.
- Terminal states are immutable. A `target_reached` setup that later closes through invalidation
  is still `target_reached` — history does not rewrite (recorded as post-terminal metadata).
- `cancelled` is only reachable from `developing`/`confirmed`; once `active`, failure is
  `invalidated`, not `cancelled`.

## Per-type condition tables

Docs 12–14 define, per setup type: **required conditions** (all must be met to confirm),
**optional conditions** (score-only), the **entry band**, the **invalidation level**, and the
**target set**. The lifecycle machine consumes those tables — it contains no type-specific logic.

## Point-in-time

A backtest at bar `t` sees exactly the state that existed at the close of bar `t`. `confirmedAt`,
`activatedAt`, `invalidatedAt`, etc. are recorded per transition.
