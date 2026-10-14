/**
 * Phase 5 — Opportunity Scoring (docs/engine/15-opportunity-score.md).
 *
 * The 0–100 Opportunity Score measures EVIDENCE QUALITY for a detected setup — never a
 * probability of profit. Additive dimension model: score = clamp(0,100, Σ wᵢ·fᵢ), Σ wᵢ = 100.
 *
 * Causality: the scorer evaluates the setup at a given bar `t` (the confirmation bar on the
 * contract path) and reconstructs every time-varying status from bar-indexed stamps —
 * pool `sweepConfirmedBar`/`brokenBar` (poolStatusAt, shared with 4H), zone
 * `invalidatedBar`/`expiredBar`, imbalance `createdBar`/`filledBar`/`expiredBar`/`invalidatedAt`
 * (imbStatusAt, shared with 4J). The final end-of-series `status` fields are never consulted
 * to answer "was it open/swept/alive at t" — callers driving historical runs should pass
 * per-bar snapshots (the 4G causal join / `*StateAt` providers) in `snap`.
 *
 * Gates (spec 15 §4) return `gate`, never a score: unconfirmed/terminal lifecycle,
 * insufficient_data, countertrend MTF, dead anchor zone, rr < minRR.
 */
import type {
  Direction,
  Imbalance,
  LiquidityPool,
  MarketRegime,
  MarketStructure,
  Momentum,
  MtfAlignmentState,
  MultiTimeframeAlignment,
  OpportunityScoreResult,
  RegimeLabel,
  ScoreContribution,
  ScoreGate,
  ScoringConfig,
  Setup,
  SetupStatus,
  Zone,
} from "@/lib/types";
import type { EngineError, EngineResult, OpportunityScoringEngine } from "@/lib/services/engine";
import type { FrameRole, JoinedFrame } from "./mtf";
import { poolStatusAt } from "./reversal";
import { imbStatusAt } from "./continuation";

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

const DIMENSIONS = [
  "structure", "liquidity", "zoneQuality", "displacement", "momentum", "htfAlignment", "freshness", "fvg",
] as const;
type Dimension = (typeof DIMENSIONS)[number];

/** RegimeLabel (19, 6 states) → the 4-family keys spec 15's regimeMatrix uses. */
const REGIME_FAMILY: Record<RegimeLabel, MarketRegime | undefined> = {
  trending_bullish: "trending",
  trending_bearish: "trending",
  ranging: "ranging",
  high_volatility: "expanding",
  low_volatility: "compressing",
  transition: undefined, // no matrix family — identity modulation
};

/** Upstream evidence as legally visible at the scoring bar — causal-path callers pass the
 *  per-bar joined frame; the contract adapter passes end-of-series snapshots and the scorer
 *  reconstructs time-varying statuses from bar-indexed stamps. */
export interface ScoringSnapshot {
  /**
   * REQUIRED declaration of where these objects came from — the path is never ambiguous:
   * - `"at_bar"`   — per-bar causal providers (4G join / `*StateAt`): the authoritative
   *   historical path. Every field, stamped or not, is point-in-time at `atBar`.
   * - `"snapshot"` — end-of-series/convenience objects: bar-indexed stamps still reconstruct
   *   causal statuses, but non-stamped fields (zone freshness/strength, momentum, structure,
   *   alignment) read final values — NOT authoritative for historical validation.
   * The value is recorded in `meta.diagnostics.path` on every result.
   */
  provenance: "at_bar" | "snapshot";
  structure?: MarketStructure;
  pools?: readonly LiquidityPool[];
  zones?: readonly Zone[];
  imbalances?: readonly Imbalance[];
  momentum?: Momentum;
  alignment?: MultiTimeframeAlignment;
  /**
   * Spec-33 (spec-10 "HTF elements consumed"): the causalFramesAt join at the same
   * closed-bar `asOf` — per-role joined snapshots carrying frame pools/zones/imbalances/
   * events. `null` entries = honest absence (missing/insufficient frame). Scoring reads
   * HTF pools for the `liquidityContext` upgrade only; presence is caller-supplied.
   */
  frames?: Record<FrameRole, JoinedFrame | null>;
  regime?: RegimeLabel;
}

const SCOREABLE: readonly SetupStatus[] = ["confirmed", "active", "partial_target"];

const TERMINAL: readonly SetupStatus[] = [
  "target_reached", "invalidated", "expired", "cancelled",
];

/** Zone status at bar t from bar-indexed stamps; stamps are definitive both ways, an
 *  un-stamped terminal status stays terminal (never inferred alive). */
function zoneStatusAt(z: Zone, t: number): Zone["status"] {
  const inv = num(z.metadata?.invalidatedBar);
  if (inv !== undefined) return inv <= t ? "invalidated" : "active";
  const exp = num(z.metadata?.expiredBar);
  if (exp !== undefined) return exp <= t ? "expired" : "active";
  return z.status;
}

export function scoreOpportunity(input: {
  setup: Setup;
  /** Bar index at which the setup is evaluated — `metadata.confirmBar` on the contract path. */
  atBar: number;
  /** ms timestamp of `atBar` — enables `invalidatedAt` (ISO) comparisons; omitted on the
   *  contract path where the contract carries no series. */
  atMs?: number;
  snap: ScoringSnapshot;
  config: ScoringConfig;
}): EngineResult<OpportunityScoreResult> {
  const { setup: s, atBar: t, atMs, snap, config: cfg } = input;
  const meta = {
    stage: "opportunity-score",
    paramsVersion: "1",
    barsConsumed: { from: num(s.metadata?.candidateBar) ?? t, to: t },
    events: [],
  };
  const fail = (code: EngineError["code"], message: string): EngineResult<OpportunityScoreResult> =>
    ({ ok: false, errors: [{ code, message }], meta });
  const gated = (gate: ScoreGate, emittedStatus: SetupStatus): EngineResult<OpportunityScoreResult> => ({
    ok: true,
    data: { gate, emittedStatus },
    errors: [],
    meta: { ...meta, diagnostics: { gate, emittedStatus, path: snap.provenance } },
  });

  // ---- Config validation (spec 21: invalid_config must be loud). ----
  const w = cfg.weights;
  for (const d of DIMENSIONS) {
    const v = w?.[d];
    if (typeof v !== "number" || v < 0)
      return fail("invalid_config", `scoring.weights.${d} must be a non-negative number`);
  }
  const wSum = DIMENSIONS.reduce((a, d) => a + w[d], 0);
  if (Math.abs(wSum - 100) > 1e-9)
    return fail("invalid_config", `scoring.weights must sum to 100 (got ${wSum})`);
  if (!(cfg.minRR >= 0)) return fail("invalid_config", "scoring.minRR must be ≥ 0");
  for (const [reg, byType] of Object.entries(cfg.regimeMatrix ?? {}))
    for (const [typ, byDim] of Object.entries(byType ?? {}))
      for (const [dim, f] of Object.entries(byDim ?? {})) {
        if (typeof f !== "number" || f < 0.5 || f > 1.5)
          return fail("invalid_config", `regimeMatrix.${reg}.${typ}.${dim} must be within [0.5, 1.5] (spec 15 §3)`);
      }

  // ---- Gate 1 — lifecycle (spec 16: a plan/score exists only while confirmed..partial_target).
  if (s.status === "developing") return gated("unconfirmed", "developing");
  if (TERMINAL.includes(s.status)) return gated("terminal", s.status);

  // ---- Gate 2 — required evidence inputs (spec 15 §4: insufficient_data). ----
  if (snap.structure === undefined || snap.momentum === undefined)
    return gated("insufficient_data", "developing");

  // ---- Gate 3 — countertrend MTF veto (spec 15 §4 — trumps the table's 0.2 bucket). ----
  const mtf: MtfAlignmentState | undefined = snap.alignment?.state ?? undefined;
  if (mtf === "countertrend_bull" || mtf === "countertrend_bear") return gated("countertrend", "developing");

  // ---- Resolve anchors from the setup's recorded evidence (never re-derived from candles). ----
  const zoneId = s.zoneIds?.[0] ?? (s.metadata?.zoneId as string | undefined);
  const zone = zoneId !== undefined ? (snap.zones ?? []).find((z) => z.id === zoneId) : undefined;
  const poolId =
    (s.metadata?.poolId as string | undefined) ??
    (s.metadata?.anchorPoolId as string | undefined) ??
    s.liquidityEventIds?.[0];
  const pool = poolId !== undefined ? (snap.pools ?? []).find((p) => p.id === poolId) : undefined;

  // ---- Gate 4 — anchor zone dead at t (spec 15 §4: invalidated/expired). ----
  if (zone !== undefined) {
    const zst = zoneStatusAt(zone, t);
    if (zst === "invalidated" || zst === "expired") return gated("zone_dead", "cancelled");
  }

  // ---- Gate 5 — RR filter (spec 15: rr < minRR drops the setup BEFORE scoring; spec 16
  //      defines rr = (finalTarget − entryZone.mid)/(entryZone.mid − invalidation), mirrored). ----
  const bandLo = num(s.metadata?.entryBandLow);
  const bandHi = num(s.metadata?.entryBandHigh);
  const inv = num(s.metadata?.invalidation);
  const targets = String(s.metadata?.targets ?? "")
    .split(",").map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (bandLo === undefined || bandHi === undefined || inv === undefined || targets.length === 0)
    return gated("insufficient_data", "developing");
  const entryMid = (bandLo + bandHi) / 2;
  const sgn = s.direction === "bullish" ? 1 : -1;
  const risk = sgn * (entryMid - inv);
  const reward = sgn * (targets[targets.length - 1] - entryMid);
  if (!(risk > 0) || !Number.isFinite(reward)) return gated("insufficient_data", "developing");
  const rr = reward / risk;
  if (rr < cfg.minRR) return gated("rr_below_min", "developing");

  // ---- Feature values (all mappings are spec-15 table rows — no invented terms). ----
  const dir = s.direction as Direction;
  const trend = snap.structure.trend;
  const trendAligned = (dir === "bullish" && trend === "uptrend") || (dir === "bearish" && trend === "downtrend");
  const trendOpposing = (dir === "bullish" && trend === "downtrend") || (dir === "bearish" && trend === "uptrend");
  const fStructure = trendAligned ? 1 : trendOpposing ? 0 : 0.4; // transition|range → 0.4
  //    └ range is unmapped in spec 15's table; grouped with transition (no directional
  //      agreement) — documented as the smallest consistent reading, not a spec term.

  const fLiquidity = ((): number => {
    if (pool === undefined) return 0;
    const st = poolStatusAt(pool, t);
    if (st === "swept") return 1; // confirmed sweep — sweepConfirmedBar ≤ t by construction
    if (st === "resting" || st === "approaching") {
      // Spec-33 (spec-10 "HTF elements consumed" — liquidityContext): an ETF sweep/proximity
      // against an HTF-ROLE pool is stronger evidence than a cell-local level — the anchor
      // pool's price band overlapping an HTF frame pool's band upgrades 0.5 → 1.0 (the only
      // higher tier spec-15's table offers). Joined frames are already causal at `t`.
      const htfPools = snap.frames?.htf?.snapshot.liquidity ?? [];
      const lo = pool.lowerPrice ?? pool.price;
      const hi = pool.upperPrice ?? pool.price;
      const htfBacked = htfPools.some(
        (p) => (p.lowerPrice ?? p.price) <= hi && (p.upperPrice ?? p.price) >= lo,
      );
      return htfBacked ? 1 : 0.5;
    }
    return 0; // broken/expired pool contributes no fuel evidence
  })();

  const fZone = zone !== undefined ? Math.min(1, Math.max(0, zone.strength / 100)) : 0;

  const disp = num(s.metadata?.dispScore) ?? snap.momentum.displacementScore;
  const fDisp = disp === undefined ? 0 : Math.min(1, Math.max(0, disp / 100));

  const fMomentum =
    snap.momentum.state === "strengthening" ? 1
    : snap.momentum.state === "neutral" ? 0.5
    : 0; // weakening | diverging

  const fHtf =
    mtf === undefined || mtf === "no_context" || mtf === "ltf_directed" || mtf === "neutral" ? 0.2
    : mtf === "aligned_bull" || mtf === "aligned_bear" ? 1
    : 0.5; // pullback_in_trend_* | realigning_* | htf_dominant

  const fFresh = zone === undefined ? 0
    : zone.freshness === "fresh" ? 1
    : zone.freshness === "tested" ? 0.5
    : 0.1; // mitigated

  const fFvg = ((): number => {
    const imbs = snap.imbalances ?? [];
    let fvg = s.metadata?.fvgId !== undefined && s.metadata?.fvgId !== null
      ? imbs.find((f) => f.id === s.metadata?.fvgId)
      : undefined;
    if (fvg === undefined) {
      // No recorded anchor FVG — scan the confirming leg (createdBar inside the leg window).
      const legStart =
        s.type === "reversal" ? num(s.metadata?.sweepBar) ?? num(s.metadata?.candidateBar)
        : s.type === "breakout" ? num(s.metadata?.attemptBar) ?? num(s.metadata?.candidateBar)
        : undefined; // continuation's leg FVG is always the recorded anchor — no scan
      if (legStart === undefined) return 0;
      fvg = imbs
        .filter((f) => f.direction === dir && (num(f.metadata?.createdBar) ?? -1) >= legStart &&
          (num(f.metadata?.createdBar) ?? Infinity) <= t)
        .sort((a, b) => (num(b.metadata?.createdBar) ?? 0) - (num(a.metadata?.createdBar) ?? 0) || a.id.localeCompare(b.id))[0];
      if (fvg === undefined) return 0;
    }
    const st = imbStatusAt(fvg, t, atMs);
    return st === "open" || st === "partially_filled" ? 1 : 0.3;
  })();

  // ---- Regime modulation (spec 15 §3): factor per dimension, then renormalize Σ to 100. ----
  const family = snap.regime !== undefined ? REGIME_FAMILY[snap.regime] : undefined;
  const row =
    (snap.regime !== undefined ? cfg.regimeMatrix?.[snap.regime] : undefined) ??
    (family !== undefined ? cfg.regimeMatrix?.[family] : undefined);
  const factors = row?.[s.type] ?? {};
  const effRaw = DIMENSIONS.map((d) => w[d] * (factors[d] ?? 1));
  const effSum = effRaw.reduce((a, b) => a + b, 0);
  const scale = effSum > 0 ? 100 / effSum : 0;

  const features: Record<Dimension, number> = {
    structure: fStructure, liquidity: fLiquidity, zoneQuality: fZone, displacement: fDisp,
    momentum: fMomentum, htfAlignment: fHtf, freshness: fFresh, fvg: fFvg,
  };
  const labels: Record<Dimension, string> = {
    structure: `structure.trend ${trend} vs ${dir}`,
    liquidity: pool === undefined ? "no liquidity evidence on the setup" : `pool ${pool.id} ${poolStatusAt(pool, t)}`,
    zoneQuality: zone === undefined ? "no anchor zone" : `zone ${zone.id} strength ${zone.strength}`,
    displacement: disp === undefined ? "no displacement score" : `displacementScore ${disp}`,
    momentum: `momentum ${snap.momentum.state}`,
    htfAlignment: `mtf ${mtf ?? "no_context"}`,
    freshness: zone === undefined ? "no anchor zone" : `zone freshness ${zone.freshness}`,
    fvg: "fvg on confirming leg",
  };
  const signals: Record<Dimension, string[] | undefined> = {
    structure: snap.structure.lastBreak?.id !== undefined ? [snap.structure.lastBreak.id] : undefined,
    liquidity: pool?.id !== undefined ? [pool.id] : undefined,
    zoneQuality: zone?.id !== undefined ? [zone.id] : undefined, // zone id lives here only —
    displacement: undefined,                                      // freshness reads the same
    momentum: undefined,                                          // entity; signalIds stay
    htfAlignment: undefined,                                      // disjoint (spec 15 §2)
    freshness: undefined,
    fvg: undefined, // filled below when a leg FVG resolves
  };
  // fvg signalIds need the resolved entity — recompute cheaply:
  if (fFvg > 0) {
    const imbs = snap.imbalances ?? [];
    const recorded = s.metadata?.fvgId as string | undefined;
    const fvg = recorded ? imbs.find((f) => f.id === recorded) : imbs
      .filter((f) => f.direction === dir)
      .sort((a, b) => (num(b.metadata?.createdBar) ?? 0) - (num(a.metadata?.createdBar) ?? 0))[0];
    if (fvg !== undefined) signals.fvg = [fvg.id];
  }

  const contributions: ScoreContribution[] = DIMENSIONS.map((d, i) => {
    const weight = Number((effRaw[i] * scale).toFixed(4));
    const points = Number((weight * features[d]).toFixed(4));
    return { dimension: d, weight, feature: features[d], points, label: labels[d], signalIds: signals[d] };
  });

  // Spec 15 §2 — assert disjoint signal inputs across dimensions.
  {
    const seen = new Set<string>();
    for (const c of contributions)
      for (const id of c.signalIds ?? []) {
        if (seen.has(id)) return fail("internal", `signal ${id} feeds more than one dimension`);
        seen.add(id);
      }
  }

  const score = Number(Math.min(100, Math.max(0, contributions.reduce((a, c) => a + c.points, 0))).toFixed(4));
  return {
    ok: true,
    data: { score, contributions },
    errors: [],
    meta: {
      ...meta,
      diagnostics: {
        path: snap.provenance,
        regime: snap.regime ?? "none",
        regimeFamily: family ?? "none",
        rr: Number(rr.toFixed(4)),
      },
    },
  };
}

/**
 * Contract adapter — spec 15/16: the score is evidence quality AT CONFIRMATION, so the
 * evaluation bar is the setup's stamped `metadata.confirmBar`. A confirmed setup without the
 * stamp cannot be point-in-time scored honestly → `insufficient_data` gate.
 */
export function createOpportunityScoringEngine(): OpportunityScoringEngine {
  return {
    score(input) {
      const t = num(input.setup.metadata?.confirmBar);
      if (t === undefined) {
        const scoreable = SCOREABLE.includes(input.setup.status);
        return {
          ok: true,
          data: {
            gate: scoreable ? "insufficient_data" : input.setup.status === "developing" ? "unconfirmed" : "terminal",
            emittedStatus: input.setup.status === "developing" ? "developing" : input.setup.status,
          },
          errors: [],
          meta: {
            stage: "opportunity-score", paramsVersion: "1",
            barsConsumed: { from: -1, to: -1 }, events: [],
            diagnostics: { gate: "confirmBar_missing", path: "snapshot" },
          },
        };
      }
      const res = scoreOpportunity({
        setup: input.setup,
        atBar: t,
        snap: {
          provenance: "snapshot", // contract path — convenience, NOT authoritative historical
          structure: input.structure,
          momentum: input.momentum,
          pools: input.pools,
          zones: input.zones,
          imbalances: input.imbalances,
          alignment: input.alignment,
          regime: input.regime,
        },
        config: input.config,
      });
      return { ...res, meta: { ...res.meta, stage: "opportunity-score" } };
    },
  };
}
