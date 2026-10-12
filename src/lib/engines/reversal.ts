/**
 * Reversal Setup Detection Engine (docs/engine/12 — conditions; 11 — universal lifecycle).
 *
 * Chronological, causal per-bar state machine. The engine owns **no** upstream logic — it
 * consumes snapshots of the Phase 4B–4F outputs (and the Phase 4G alignment) at each closed
 * bar via a caller-supplied provider. The canonical causal path composes the 4G join:
 *
 *   causalFramesAt(roles, t) → JoinedFrame.snapshot → detectReversals.at(idx)
 *
 * Contract `detect()` consumes end-of-series snapshots (caller duty); historical backtests
 * MUST drive `detectReversals` with per-bar `*StateAt` providers so a future bar can never
 * alter a setup's past.
 *
 * Deliberately out of scope (later phases): score, trade plan (entry/SL/TP as orders),
 * breakout/continuation families, probability, alerts, execution. Targets/entry band live in
 * `metadata` as *evidence levels* required by the lifecycle (spec 11 `active`/`partial_target`
 * /`target_reached`) — they are not a trade plan.
 */
import type {
  Candle,
  DetectionEvent,
  Direction,
  Imbalance,
  LifecycleConfig,
  LiquidityPool,
  MarketStructure,
  Momentum,
  MtfAlignmentState,
  MultiTimeframeAlignment,
  ReversalConfig,
  Setup,
  SetupReason,
  SetupStatus,
  Timeframe,
  Zone,
} from "@/lib/types";
import type { EngineError, SetupDetectionEngine } from "@/lib/services/engine";

const toISO = (ms: number) => new Date(ms).toISOString();
const isoMs = (s: string) => Date.parse(s);

/** Spec ATR convention is Wilder-length 14 across docs 04/08/09 — reversal adds no window param. */
const ATR_LEN = 14;

/** Mean true range over the `len` bars ending at closed bar `i` (simple mean — engine convention). */
export function atrAt(candles: readonly Candle[], i: number, len = ATR_LEN): number {
  const from = Math.max(1, i - len + 1);
  let sum = 0;
  let n = 0;
  for (let k = from; k <= i; k++) {
    const c = candles[k];
    sum += Math.max(c.high - c.low, Math.abs(c.high - candles[k - 1].close), Math.abs(c.low - candles[k - 1].close));
    n++;
  }
  return n ? sum / n : 0;
}

/** First candle index whose open time ≥ `ms` (binary search; -1 when none). */
function indexAtOrAfter(candles: readonly Candle[], ms: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo < candles.length ? lo : -1;
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** Pool's legally-visible status at bar t, reconstructed from bar-indexed lifecycle metadata. */
export function poolStatusAt(pool: LiquidityPool, t: number): LiquidityPool["status"] {
  const sw = num(pool.metadata?.sweepConfirmedBar);
  const br = num(pool.metadata?.brokenBar);
  if (br !== undefined && br <= t) return "broken";
  if (sw !== undefined && sw <= t) return "swept";
  return pool.status === "swept" || pool.status === "broken" ? "resting" : pool.status;
}

/** Zone's effective liveness at bar t — `invalidatedBar` metadata restores a later-invalidated zone. */
function zoneAliveAt(zone: Zone, t: number): boolean {
  const inv = num(zone.metadata?.invalidatedBar);
  if (inv !== undefined) return inv > t && zone.status !== "forming" && zone.status !== "expired";
  return zone.status === "active";
}

/** Everything the detector may legally see at one closed bar — the JoinedFrame contract, widened with events. */
export interface ReversalInput {
  structure?: MarketStructure;
  momentum?: Momentum;
  pools?: LiquidityPool[];
  zones?: Zone[];
  imbalances?: Imbalance[];
  alignment?: MultiTimeframeAlignment;
  events?: DetectionEvent[];
}

interface Live {
  key: string; // `live` map key — `${zoneId}:${sweepAnchor}`
  setup: Setup;
  zoneId: string;
  dir: Direction;
  sweepBar?: number; // C3/C4 anchor (confirmed sweep)
  developingBar?: number; // sweep_developing trace anchor (C3 only)
  confirmedBar?: number;
  activatedBar?: number;
  entryLow: number;
  entryHigh: number;
  invalidation: number;
  targets: number[]; // ordered evidence levels T1→T3
  targetsHit: number;
  zoneIdx: number; // zone origin bar — zoneMaxAgeBars bookkeeping
}

function mirror(dir: Direction) {
  return {
    zoneType: dir === "bullish" ? ("demand" as const) : ("supply" as const),
    poolSide: dir === "bullish" ? ("sell_side" as const) : ("buy_side" as const),
    /** Bar entered the zone from price side: bullish → low ≤ upperPrice; bearish → high ≥ lowerPrice. */
    entered: (z: Zone, b: Candle) => (dir === "bullish" ? b.low <= z.upperPrice : b.high >= z.lowerPrice),
    distal: (z: Zone) => (dir === "bullish" ? z.lowerPrice : z.upperPrice),
    entryBand: (z: Zone, depth: number): [number, number] =>
      dir === "bullish"
        ? [z.lowerPrice, z.lowerPrice + depth * (z.upperPrice - z.lowerPrice)]
        : [z.upperPrice - depth * (z.upperPrice - z.lowerPrice), z.upperPrice],
    invalidates: (b: Candle, level: number) => (dir === "bullish" ? b.close < level : b.close > level),
    reaches: (b: Candle, price: number) => (dir === "bullish" ? b.high >= price : b.low <= price),
    acceptable: (s: MtfAlignmentState) =>
      s === (dir === "bullish" ? "aligned_bull" : "aligned_bear") ||
      s === (dir === "bullish" ? "realigning_bull" : "realigning_bear") ||
      s === (dir === "bullish" ? "pullback_in_trend_bull" : "pullback_in_trend_bear"),
  };
}

const REASON_LABEL: Record<string, { category: SetupReason["category"]; label: string }> = {
  C1: { category: "supply_demand", label: "Price entered significant zone (active, strength/age within limits)" },
  C2: { category: "liquidity", label: "Opposing-side pool near the zone's distal edge" },
  C3: { category: "liquidity", label: "Liquidity sweep (confirmed or developing) within max age" },
  C4: { category: "liquidity", label: "Reclaim — sweep confirmed by close back through the level" },
  C5: { category: "momentum", label: "Post-sweep displacement score ≥ threshold, matching direction" },
  C6: { category: "market_structure", label: "Confirmed structure break (CHOCH/BOS) against prior move" },
  C7: { category: "imbalance", label: "Departure-leg FVG open/partially_filled (optional)" },
  C8: { category: "multi_timeframe", label: "MTF context acceptable (optional; countertrend = veto)" },
};

function reason(id: string, met: boolean, tf: Timeframe, signalIds?: string[]): SetupReason {
  return { id, category: REASON_LABEL[id].category, label: REASON_LABEL[id].label, met, timeframe: tf, signalIds };
}

export function detectReversals(input: {
  candles: readonly Candle[];
  symbol: string;
  timeframe: Timeframe;
  /** Legally-visible upstream outputs at closed bar `idx` (phase 4B–4G `*StateAt`/join). */
  at(idx: number): ReversalInput | null;
  config: { lifecycle: LifecycleConfig; reversal: ReversalConfig };
}): { setups: Setup[]; events: DetectionEvent[] } {
  const { candles, symbol, timeframe, at } = input;
  const rc = input.config.reversal;
  const lc = input.config.lifecycle;
  const live = new Map<string, Live>(); // key: `${zoneId}:${sweepAnchor}` — duplicate prevention
  const done: Setup[] = [];
  const events: DetectionEvent[] = [];

  const transit = (l: Live, t: number, to: SetupStatus, why: string) => {
    const s = l.setup;
    if (s.status === to && to !== "partial_target") return; // partial_target fires per-target
    s.status = to;
    s.updatedAt = toISO(candles[t].time);
    s.metadata = { ...(s.metadata ?? {}), transitionReason: why };
    events.push({
      kind: "setup_transition",
      refId: s.id,
      symbol,
      atBar: t,
      at: toISO(candles[t].time),
      metadata: { eventId: `${s.id}:${to}:${t}`, family: "reversal", to, transitionReason: why },
    });
  };
  const finish = (l: Live) => {
    live.delete(l.key);
    done.push(l.setup);
  };

  for (let t = 0; t < candles.length; t++) {
    const bar = candles[t];
    const snap = at(t);
    const atr = atrAt(candles, t);

    // ---- Lifecycle for live setups (spec 11) — evaluated at every closed bar. ----
    for (const l of [...live.values()]) {
      const s = l.setup;
      const m = mirror(l.dir);
      const terminal = s.status === "invalidated" || s.status === "expired" || s.status === "cancelled" ||
        s.status === "target_reached";
      if (terminal) continue;
      // 1. close-through invalidation (close only — wicks never invalidate)
      if (m.invalidates(bar, l.invalidation)) {
        transit(l, t, "invalidated", "close_through_invalidation");
        finish(l);
        continue;
      }
      // 2. targets while active (ordered: any non-final hit → partial_target; last → target_reached)
      if (s.status === "active" || s.status === "partial_target") {
        let hit = 0;
        while (l.targetsHit < l.targets.length && m.reaches(bar, l.targets[l.targetsHit])) {
          l.targetsHit++;
          hit++;
        }
        if (hit > 0) {
          const final = l.targetsHit >= l.targets.length;
          transit(l, t, final ? "target_reached" : "partial_target", final ? "final_target" : `target_${l.targetsHit}`);
          if (final) { finish(l); continue; }
        }
      }
      // 3. entry band overlap → active (confirmed only)
      if (s.status === "confirmed" && bar.low <= l.entryHigh && bar.high >= l.entryLow) {
        l.activatedBar = t;
        transit(l, t, "active", "entry_band_touched");
      }
      // 4. premise disproved → cancelled (developing/confirmed only)
      if ((s.status === "developing" || s.status === "confirmed") && snap) {
        const oppBreak = (snap.structure?.breaks ?? []).filter(
          (b) => b.confirmed && b.direction !== l.dir && b.breakIndex !== undefined && b.breakIndex > (l.sweepBar ?? l.developingBar ?? -1) && b.breakIndex <= t,
        );
        if (oppBreak.length > 0) {
          transit(l, t, "cancelled", `opposing_${oppBreak[0].type ?? "break"}`);
          finish(l);
          continue;
        }
        const mtf = snap.alignment?.state;
        if (mtf?.startsWith("countertrend")) {
          transit(l, t, "cancelled", `mtf_veto_${mtf}`);
          finish(l);
          continue;
        }
      }
      // 5. expiry — sweep staleness pre-confirmation; lifecycle.expiryBars for stalled states
      const anchor = l.activatedBar ?? l.confirmedBar ?? l.sweepBar ?? l.developingBar;
      const limit = s.status === "developing" && l.sweepBar === undefined
        ? (num(l.setup.metadata?.candidateBar) ?? t) + lc.expiryBars
        : (anchor ?? t) + (s.status === "developing" ? rc.sweepMaxAgeBars : lc.expiryBars);
      if (t > limit) {
        transit(l, t, "expired", s.status === "developing" ? "sweep_stale" : "stalled");
        finish(l);
      }
    }

    if (!snap) continue; // insufficient data — nothing new can be knowable
    const zones = snap.zones ?? [];
    const pools = snap.pools ?? [];
    const imbalances = snap.imbalances ?? [];
    const momentum = snap.momentum;
    const structure = snap.structure;
    const alignment = snap.alignment;
    const evts = snap.events ?? [];

    // ---- New candidates: qualifying zones with a nearby opposing pool (spec 12 C1/C2). ----
    for (const dir of ["bullish", "bearish"] as const) {
      const m = mirror(dir);
      for (const zone of zones) {
        if (zone.type !== m.zoneType || !zoneAliveAt(zone, t)) continue;
        const zi = indexAtOrAfter(candles, isoMs(zone.createdAt));
        const zoneIdx = zi >= 0 ? zi : 0;
        if (t - zoneIdx > rc.zoneMaxAgeBars) continue;
        const anchor = `${zone.id}`;
        // Find the (latest) pool used for this setup — skip if a live setup already owns the key.
        const c1 = zone.strength >= rc.zoneMinStrength && (zone.remainingStrength ?? zone.strength) > 0 && m.entered(zone, bar);
        if (!c1) continue; // spec 12: developing = C1+C2 met — without zone entry there is no setup
        // One live setup per (zone, direction); a new setup requires a different sweep anchor.
        if ([...live.values()].some((l) => l.zoneId === zone.id && l.dir === dir)) continue;
        const near = pools.filter(
          (p) => p.side === m.poolSide && Math.abs(p.price - m.distal(zone)) <= atr && atr > 0,
        );
        const candidate = near
          // sw gated by ≤ t — a future confirmed sweep is not yet knowable
          .map((p) => ({ p, sw: num(p.metadata?.sweepConfirmedBar), st: poolStatusAt(p, t) }))
          .map((x) => ({ ...x, sw: x.sw !== undefined && x.sw <= t ? x.sw : undefined }))
          .filter((x) => x.st === "resting" || x.st === "approaching" || x.st === "swept")
          .sort((a, b) => (b.sw ?? -1) - (a.sw ?? -1))[0]; // freshest sweep anchors the setup
        if (!candidate) continue;
        const { p: pool, sw: sweepBar } = candidate;
        // Terminal setups on this zone re-arm only on a different sweep anchor.
        if (done.some((s) => s.zoneIds?.includes(zone.id) && s.direction === dir && num(s.metadata?.sweepBar) === sweepBar)) continue;
        const devEvt = evts.find(
          (e) => e.kind === "sweep_developing" && e.metadata?.poolId === pool.id && t - e.atBar <= rc.sweepMaxAgeBars,
        );
        const key = `${anchor}:${sweepBar ?? "pre"}`;
        if (live.has(key)) continue;
        if (zoneIdx >= 0 && zoneIdx > t) continue; // zone not knowable yet (defensive)

        // ---- Condition table C1–C8 (C9 is the active trigger, evaluated in lifecycle). ----
        const reasons: SetupReason[] = [];
        const c1met = c1;
        reasons.push(reason("C1", c1met, timeframe, [zone.id]));
        const c2 = true; // candidate pool exists (resting/approaching/swept within the distal band)
        reasons.push(reason("C2", c2, timeframe, [pool.id]));
        const c3 = (sweepBar !== undefined && t - sweepBar <= rc.sweepMaxAgeBars) || devEvt !== undefined;
        reasons.push(reason("C3", c3, timeframe, sweepBar !== undefined ? [pool.id] : devEvt ? [devEvt.metadata?.eventId as string] : undefined));
        const c4 = sweepBar !== undefined; // spec 04 confirms a sweep only on reclaim
        reasons.push(reason("C4", c4, timeframe));
        const c5 =
          momentum !== undefined &&
          momentum.displacementScore !== undefined &&
          momentum.displacementScore >= rc.dispMinScore &&
          momentum.bias === dir;
        reasons.push(reason("C5", c5, timeframe));
        const brk = (structure?.breaks ?? []).find(
          (b) => b.confirmed && b.direction === dir && b.breakIndex !== undefined &&
            (sweepBar === undefined || b.breakIndex >= sweepBar) && b.breakIndex <= t,
        );
        reasons.push(reason("C6", brk !== undefined, timeframe, brk?.id ? [brk.id] : undefined));
        const fvg = imbalances.find(
          (f) => f.direction === dir && (f.status === "open" || f.status === "partially_filled") &&
            isoMs(f.createdAt) >= candles[sweepBar ?? 0]?.time,
        );
        reasons.push(reason("C7", fvg !== undefined, timeframe, fvg ? [fvg.id] : undefined));
        const mtfState = alignment?.state;
        reasons.push(reason("C8", mtfState !== undefined && m.acceptable(mtfState), timeframe));

        const [entryLow, entryHigh] = m.entryBand(zone, rc.entryZoneDepth);
        const fvgBand = fvg && fvg.upperPrice - fvg.lowerPrice < entryHigh - entryLow
          ? [fvg.lowerPrice, fvg.upperPrice] as const
          : undefined;
        const [el, eh] = fvgBand ?? [entryLow, entryHigh];
        const invalidation =
          dir === "bullish" ? zone.lowerPrice - rc.invalidateAtr * atr : zone.upperPrice + rc.invalidateAtr * atr;

        // Targets — ordered evidence levels (lifecycle needs them; not a trade plan).
        const ref = m.distal(zone);
        const t1 = pools.filter((q) => q.side !== m.poolSide && poolStatusAt(q, t) === "resting" &&
          (dir === "bullish" ? q.price > ref : q.price < ref))
          .sort((a, b) => Math.abs(a.price - ref) - Math.abs(b.price - ref))[0]?.price;
        const t2 = zones.filter((z) => z.type !== m.zoneType && zoneAliveAt(z, t) &&
          (dir === "bullish" ? z.lowerPrice > ref : z.upperPrice < ref))
          .sort((a, b) => Math.abs(m.distal(a) - ref) - Math.abs(m.distal(b) - ref) || (dir === "bullish" ? a.lowerPrice - b.lowerPrice : b.upperPrice - a.upperPrice))[0];
        const t2p = t2 ? (dir === "bullish" ? t2.lowerPrice : t2.upperPrice) : undefined;
        const hh = (structure?.keyLevels ?? [])
          .filter((k) => /HH|EH|LL|EL/.test(k.label) && (dir === "bullish" ? /HH|EH/.test(k.label) : /LL|EL/.test(k.label)))
          .map((k) => k.price)
          .filter((pr) => (dir === "bullish" ? pr > ref : pr < ref))
          .sort((a, b) => (dir === "bullish" ? a - b : b - a))[0];
        const t3 = hh ?? candles.slice(0, t + 1).reduce(
          (acc, c) => (dir === "bullish" ? Math.max(acc, c.high) : Math.min(acc, c.low)),
          dir === "bullish" ? -Infinity : Infinity,
        );
        const targets = [t1, t2p, t3].filter((x): x is number => x !== undefined && Number.isFinite(x))
          .sort((a, b) => (dir === "bullish" ? a - b : b - a));

        const id = `rev:${symbol}:${timeframe}:${dir}:${key}`;
        const allMet = reasons.slice(0, 6).every((r) => r.met);
        const s: Setup = {
          id,
          symbol,
          timeframe,
          type: "reversal",
          direction: dir,
          score: 0, // placeholder — spec 15 scoring is a later phase; 0 ≠ quality claim
          status: allMet ? "confirmed" : "developing",
          reasons,
          zoneIds: [zone.id],
          liquidityEventIds: [pool.id],
          contextTimeframe: alignment?.timeframes.htf,
          createdAt: toISO(bar.time),
          metadata: {
            candidateBar: t,
            zoneId: zone.id,
            poolId: pool.id,
            fvgId: fvg?.id ?? null,
            breakId: brk?.id ?? null,
            entryBandLow: el,
            entryBandHigh: eh,
            invalidation,
            targets: targets.join(","),
          },
        };
        const l: Live = {
          key, setup: s, zoneId: zone.id, dir, zoneIdx,
          sweepBar, developingBar: devEvt?.atBar,
          confirmedBar: allMet ? t : undefined,
          entryLow: el, entryHigh: eh, invalidation, targets, targetsHit: 0,
        };
        live.set(key, l);
        // creation IS the developing transition — emit it explicitly (status already set)
        events.push({
          kind: "setup_transition",
          refId: s.id,
          symbol,
          atBar: t,
          at: toISO(bar.time),
          metadata: { eventId: `${s.id}:developing:${t}`, family: "reversal", to: "developing", transitionReason: "evidence_forming" },
        });
        if (allMet) transit(l, t, "confirmed", "all_required_met");
      }
    }

    // ---- Promote live developing setups whose remaining conditions became knowable at t. ----
    for (const l of [...live.values()]) {
      const s = l.setup;
      if (s.status !== "developing") continue;
      const m = mirror(l.dir);
      // refresh anchors (sweep may confirm after the developing trace)
      const pool = (snap.pools ?? []).find((p) => p.id === (s.metadata?.poolId as string));
      const sw = pool ? num(pool.metadata?.sweepConfirmedBar) : undefined;
      if (sw !== undefined && sw <= t) {
        l.sweepBar = sw;
        s.metadata = { ...(s.metadata ?? {}), sweepBar: sw };
      }
      const fvg = (snap.imbalances ?? []).find(
        (f) => f.direction === l.dir && (f.status === "open" || f.status === "partially_filled") && isoMs(f.createdAt) >= candles[l.sweepBar ?? 0]?.time,
      );
      if (fvg && s.metadata?.fvgId == null) s.metadata = { ...(s.metadata ?? {}), fvgId: fvg.id };
      const brk = (snap.structure?.breaks ?? []).find(
        (b) => b.confirmed && b.direction === l.dir && b.breakIndex !== undefined && (l.sweepBar === undefined || b.breakIndex >= l.sweepBar) && b.breakIndex <= t,
      );
      if (brk?.id && s.metadata?.breakId == null) s.metadata = { ...(s.metadata ?? {}), breakId: brk.id };
      const byId = (id: string) => s.reasons.find((r) => r.id === id);
      const reEval = [
        ["C3", (l.sweepBar !== undefined && t - l.sweepBar <= rc.sweepMaxAgeBars) || l.developingBar !== undefined],
        ["C4", l.sweepBar !== undefined],
        ["C5", snap.momentum !== undefined && (snap.momentum.displacementScore ?? -1) >= rc.dispMinScore && snap.momentum.bias === l.dir],
        ["C6", brk !== undefined],
        ["C7", fvg !== undefined],
        ["C8", snap.alignment !== undefined && m.acceptable(snap.alignment.state)],
      ] as const;
      for (const [rid, met] of reEval) { const r = byId(rid); if (r && met && !r.met) r.met = true; }
      if (s.reasons.slice(0, 6).every((r) => r.met)) {
        l.confirmedBar = t;
        transit(l, t, "confirmed", "all_required_met");
      }
    }
  }

  for (const l of live.values()) done.push(l.setup);
  done.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { setups: done, events };
}

/**
 * Contract adapter — consumes end-of-series snapshots per the `SetupDetectionEngine` contract.
 * Historical runs that need causality should drive `detectReversals` with 4G-joined providers;
 * bar-indexed pool/zone metadata still guards what each bar may see here.
 */
export function createReversalSetupEngine(): SetupDetectionEngine {
  return {
    detect(input) {
      const errors: EngineError[] = [];
      const r = input.config.reversal;
      const bad =
        r.zoneMaxAgeBars < 0 || r.zoneMinStrength < 0 || r.sweepMaxAgeBars < 0 || r.dispMinScore < 0 ||
        !(r.entryZoneDepth > 0 && r.entryZoneDepth <= 1) || r.invalidateAtr < 0 ||
        input.config.lifecycle.expiryBars < 0 || input.config.lifecycle.invalidateAtr < 0;
      if (bad) errors.push({ code: "invalid_config", message: "reversal/lifecycle parameters must be non-negative; entryZoneDepth in (0,1]" });
      const candles = input.series?.candles ?? [];
      if (candles.length === 0)
        return {
          ok: errors.length === 0, data: [] as Setup[], errors,
          meta: { stage: "setups", paramsVersion: "1", barsConsumed: { from: -1, to: -1 }, events: [], diagnostics: { family: "reversal", setups: 0, confirmed: 0 } },
        };
      const { setups, events } = bad
        ? { setups: [] as Setup[], events: [] as DetectionEvent[] }
        : detectReversals({
            candles,
            symbol: input.series.symbol,
            timeframe: input.series.timeframe,
            at: () => ({
              structure: input.structure,
              momentum: input.momentum,
              pools: input.pools,
              zones: input.zones,
              imbalances: input.imbalances,
              alignment: input.alignment,
            }),
            config: input.config,
          });
      return {
        ok: errors.length === 0,
        data: setups,
        errors,
        meta: {
          stage: "setups",
          paramsVersion: "1",
          barsConsumed: { from: 0, to: candles.length - 1 },
          events,
          diagnostics: { family: "reversal", setups: setups.length, confirmed: setups.filter((s) => s.status !== "developing").length },
        },
      };
    },
  };
}
