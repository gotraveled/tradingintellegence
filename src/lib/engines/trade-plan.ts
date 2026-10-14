import type {
  LifecycleConfig,
  OpportunityScoreResult,
  ScanPlan,
  Setup,
  SetupStatus,
  TradePlan,
  UnixMs,
} from "@/lib/types";
import type { EngineResult, TradePlanEngine } from "@/lib/services/engine";

/**
 * Trade Plan Engine (docs/engine/28-trade-plan-engine.md — implementation closure of the
 * spec-16 model, docs/engine/16-trade-plan.md).
 *
 * A pure snapshot assembler: the setup engines (12–14) already stamped entry band,
 * invalidation, ordered targets, and bar-indexed lifecycle markers on `setup.metadata`;
 * spec 15 already decided the score (or vetoed it). This module only *joins* those
 * point-in-time artifacts into the `TradePlan` — it never re-derives levels, never
 * scores, and never touches candles.
 *
 * Causality: every stamped bar is filtered by `stamp <= atIndex`. Status and target
 * reachability at `t` are reconstructed from stamps alone — the setup's final
 * `status`/`updatedAt` fields (which may encode post-`atIndex` transitions) are never
 * consulted for the at(t) answer.
 */

const STAGE = "plan";
/** Snapshot consumer — assembles point-in-time artifacts, not a bar range. */
const SNAPSHOT_BARS = { from: -1, to: -1 } as const;

const toISO = (ms: number) => new Date(ms).toISOString();
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** Lifecycle stamps the plan engine interprets — written by the setup-family replay (spec 11). */
const TERMINAL_STAMPS: [SetupStatus, string][] = [
  ["target_reached", "targetReachedBar"],
  ["invalidated", "invalidatedBar"],
  ["expired", "expiredBar"],
  ["cancelled", "cancelledBar"],
];

/** Stamped value visible at `atIndex` — anything > atIndex is future information. */
function stampAt(s: Setup, key: string, atIndex: number): number | undefined {
  const v = num(s.metadata?.[key]);
  return v !== undefined && v <= atIndex ? v : undefined;
}

/**
 * Status-at-`atIndex` from lifecycle stamps (spec 16): a plan exists only once
 * `confirmBar <= t`; terminal stamps mark the retained artifact `final`.
 */
function statusAt(s: Setup, atIndex: number): { status: SetupStatus; final: boolean } | undefined {
  if (stampAt(s, "confirmBar", atIndex) === undefined) return undefined;
  const term = TERMINAL_STAMPS.map(([status, key]) => ({ status, bar: stampAt(s, key, atIndex) }))
    .filter((x): x is { status: SetupStatus; bar: number } => x.bar !== undefined)
    .sort((a, b) => a.bar - b.bar)[0];
  if (term) return { status: term.status, final: true };
  if (stampAt(s, "partialTargetBar", atIndex) !== undefined) return { status: "partial_target", final: false };
  if (stampAt(s, "activeBar", atIndex) !== undefined) return { status: "active", final: false };
  return { status: "confirmed", final: false };
}

/** Spec-16 basis strings name the stamped evidence — never invented levels. */
function entryBasis(s: Setup): string {
  const m = s.metadata ?? {};
  switch (s.type) {
    case "reversal": {
      const z = typeof m.zoneId === "string" ? m.zoneId : undefined;
      const kind = s.direction === "bullish" ? "demand" : "supply";
      return z ? `${kind} zone ${z} proximal band` : `${kind} zone proximal band`;
    }
    case "breakout": {
      const rk = typeof m.rangeKey === "string" ? m.rangeKey : undefined;
      const b = num(m.boundary);
      if (rk && b !== undefined) return `range ${rk} boundary ${b}`;
      if (b !== undefined) return `range boundary ${b}`;
      return "breakout boundary band";
    }
    case "continuation": {
      const pb = num(m.pullbackExtreme);
      return pb !== undefined ? `pullback extreme ${pb} band` : "continuation pullback band";
    }
    default:
      return "setup entry band";
  }
}

function invalidationBasis(s: Setup): string {
  const m = s.metadata ?? {};
  switch (s.type) {
    case "reversal": {
      const z = typeof m.zoneId === "string" ? m.zoneId : undefined;
      return z ? `zone ${z} distal boundary` : "zone distal boundary";
    }
    case "breakout": {
      const rk = typeof m.rangeKey === "string" ? m.rangeKey : undefined;
      const b = num(m.boundary);
      if (rk && b !== undefined) return `range ${rk} boundary ${b} ±ATR`;
      if (b !== undefined) return `range boundary ${b} ±ATR`;
      return "breakout boundary ±ATR";
    }
    case "continuation": {
      const pb = num(m.pullbackExtreme);
      return pb !== undefined ? `pullback ${pb} ±ATR` : "pullback ±ATR";
    }
    default:
      return "setup invalidation level";
  }
}

/**
 * buildTradePlan — assemble the spec-16 `TradePlan` at `atIndex` from stamped evidence.
 * `unavailable` when the setup had not confirmed by `atIndex` or spec-15 vetoed the score;
 * `insufficient_data` for absent stamped fields; `invalid_input` for corrupt levels;
 * `invalid_config` for a non-positive `expiryBars`.
 */
export function buildTradePlan(input: {
  setup: Setup;
  score: OpportunityScoreResult;
  atIndex: number;
  atMs?: UnixMs;
  config: LifecycleConfig;
}): EngineResult<{ plan: TradePlan }> {
  const { setup: s, score, atIndex, atMs, config } = input;
  const paramsVersion = `exp${config.expiryBars}`;
  const meta = {
    stage: STAGE,
    paramsVersion,
    barsConsumed: { ...SNAPSHOT_BARS },
    events: [],
  };
  const fail = (code: "insufficient_data" | "invalid_input" | "invalid_config" | "unavailable" | "internal", message: string): EngineResult<{ plan: TradePlan }> => ({
    ok: false,
    errors: [{ code, message }],
    meta,
  });

  if (!Number.isFinite(config.expiryBars) || config.expiryBars <= 0) {
    return fail("invalid_config", "plan: requires finite expiryBars > 0");
  }
  if (!Number.isInteger(atIndex) || atIndex < 0) {
    return fail("invalid_input", "plan: atIndex must be a non-negative integer");
  }

  // ---- Lifecycle gating (spec 16): no plan before confirmation; terminal keeps `final`. ----
  const st = statusAt(s, atIndex);
  if (st === undefined) {
    return fail("unavailable", "plan: setup not confirmed at evaluation index — no plan exists yet");
  }

  // ---- Spec-15 score is authoritative — a veto is never turned into a fabricated score. ----
  if (
    score.gate !== undefined ||
    score.score === undefined ||
    !Number.isFinite(score.score) ||
    !score.contributions ||
    score.contributions.length === 0
  ) {
    return fail("unavailable", "plan: scoring gated or produced no scored breakdown — no plan");
  }

  // ---- Stamped evidence levels (specs 12–14) — authoritative, never recomputed. ----
  const low = num(s.metadata?.entryBandLow);
  const high = num(s.metadata?.entryBandHigh);
  const invalidation = num(s.metadata?.invalidation);
  if (low === undefined || high === undefined || invalidation === undefined) {
    return fail("insufficient_data", "plan: setup missing entryBand/invalidation metadata");
  }
  if (!Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(invalidation)) {
    return fail("invalid_input", "plan: non-finite stamped entry/invalidation level");
  }
  if (low > high) {
    return fail("invalid_input", `plan: inverted entry band (low ${low} > high ${high})`);
  }

  // ---- Targets — stamped CSV → T1..Tn; reachability from targetBars ≤ atIndex. ----
  const raw = s.metadata?.targets;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fail("insufficient_data", "plan: setup missing targets metadata");
  }
  const prices = raw.split(",").map((x) => Number(x.trim()));
  if (prices.length === 0 || prices.some((p) => !Number.isFinite(p))) {
    return fail("invalid_input", "plan: malformed targets metadata (non-finite price)");
  }
  const rawBars = typeof s.metadata?.targetBars === "string" ? s.metadata.targetBars : "";
  const targetBars = rawBars.length > 0 ? rawBars.split(",").map((x) => Number(x.trim())) : [];
  if (targetBars.some((b) => !Number.isFinite(b))) {
    return fail("invalid_input", "plan: malformed targetBars metadata (non-finite bar)");
  }
  const targets = prices.map((price, i) => ({
    label: `T${i + 1}`,
    price,
    reached: targetBars[i] !== undefined && targetBars[i] <= atIndex,
  }));
  const targetsReached = targets.filter((t) => t.reached).length;

  // ---- Risk/reward to the final target (spec 16) — no minRR gate here (spec 15 owns it). ----
  const mid = (low + high) / 2;
  const finalTarget = prices[prices.length - 1];
  const bullish = s.direction === "bullish";
  const risk = bullish ? mid - invalidation : invalidation - mid;
  if (risk <= 0) {
    return fail("invalid_input", `plan: non-positive risk (mid ${mid}, invalidation ${invalidation})`);
  }
  const reward = bullish ? finalTarget - mid : mid - finalTarget;
  const riskReward = reward / risk;

  const pending = s.reasons.filter((r) => !r.met);
  const plan: TradePlan = {
    setupId: s.id,
    symbol: s.symbol,
    timeframe: s.timeframe,
    direction: s.direction,
    entryZone: { low, high, basis: entryBasis(s) },
    invalidation: { price: invalidation, basis: invalidationBasis(s), closeOnly: true },
    targets,
    riskReward,
    score: score.score,
    scoreContributions: score.contributions,
    reasons: s.reasons,
    ...(pending.length > 0 ? { conditionsPending: pending } : {}),
    expiryBars: config.expiryBars,
    ...(st.final ? { final: true } : {}),
    createdAt: atMs !== undefined ? toISO(atMs) : s.createdAt,
    paramsVersion,
  };

  return {
    ok: true,
    data: { plan },
    errors: [],
    meta: {
      ...meta,
      diagnostics: {
        statusAt: st.status,
        targetsTotal: prices.length,
        targetsReached,
        final: st.final,
      },
    },
  };
}

/**
 * planStateAt — point-in-time plan for the historical `at(t)` join. Causality is entirely
 * inherited: pass the caller's PIT setup artifact, the spec-15 score at `t`, and the
 * evaluation index. Non-ok results degrade to `undefined` — never thrown, never fabricated.
 */
export function planStateAt(
  setup: Setup,
  score: OpportunityScoreResult,
  atIndex: number,
  config: LifecycleConfig,
): TradePlan | undefined {
  const r = buildTradePlan({ setup, score, atIndex, config });
  return r.ok && r.data ? r.data.plan : undefined;
}

/**
 * toScanPlan — canonical TradePlan → ScanPlan projection (spec 29). The scanner domain
 * consumes a flat {entry, stopLoss, targets, riskReward} view; `entry` is the entry-zone
 * midpoint — the same price `riskReward` is measured from (spec-16 derivation), so the
 * displayed entry and the RR anchor are always coherent. Pure projection: nothing
 * recomputed, the TradePlan is never mutated.
 */
export function toScanPlan(plan: TradePlan): ScanPlan {
  return {
    entry: (plan.entryZone.low + plan.entryZone.high) / 2,
    stopLoss: plan.invalidation.price,
    targets: plan.targets,
    riskReward: plan.riskReward,
  };
}

export function createTradePlanEngine(): TradePlanEngine {
  return {
    build(input) {
      return buildTradePlan(input);
    },
  };
}
