/**
 * Continuation Setup Detection Engine (docs/engine/14 — conditions; 11 — universal lifecycle).
 *
 * Chronological, causal per-bar state machine, structurally paired with `reversal.ts`/`breakout.ts`.
 * The engine consumes per-bar snapshots of the Phase 4B–4G outputs via a caller-supplied
 * provider — the canonical causal path composes the 4G join:
 *
 *   causalFramesAt(roles, t) → JoinedFrame.snapshot → detectContinuations.at(idx)
 *
 * Contract `detect()` consumes end-of-series snapshots (caller duty); historical backtests
 * MUST drive `detectContinuations` with per-bar `*StateAt` providers.
 *
 * Spec-14 specifics:
 * - Direction is inherited from canonical structure (`trend`, classified confirmed swings —
 *   HH/HL for bullish, LH/LL for bearish) — never re-derived from candles.
 * - The impulse/pullback geometry is a setup-level definition measured on candles, anchored
 *   to upstream swing entities (prices/ids) — the spec's own definition, not a re-detection.
 * - Pullback quality is the spec's 0–1 composite: overlap ratio, counter-move displacement <
 *   impulse displacement (upstream `displacementScore` per bar — never recomputed), declining
 *   volume. Components absent → skipped and the mean redistributes (spec-09 convention).
 * - `pullbackMaxPct` is a hard gate: exceeding it cancels the premise — a reversal warning,
 *   never a bearish setup (spec 14: "needs its own spec-12 sequence").
 *
 * Deliberately out of scope: scoring, trade plans (targets/entry band are lifecycle evidence
 * metadata only), probability, alerts, execution.
 */
import type {
  Candle,
  ContinuationConfig,
  DetectionEvent,
  Direction,
  Imbalance,
  LifecycleConfig,
  LiquidityPool,
  MarketStructure,
  Momentum,
  MultiTimeframeAlignment,
  Setup,
  SetupReason,
  SetupStatus,
  SwingPoint,
  Timeframe,
  Zone,
} from "@/lib/types";
import type { EngineError, SetupDetectionEngine } from "@/lib/services/engine";
import { atrAt, poolStatusAt, TRANSITION_BAR } from "./reversal";

const toISO = (ms: number) => new Date(ms).toISOString();
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** Spec 14 zone proximity: "within 0.5×ATR of its proximal edge" — spec-literal constant. */
const ZONE_NEAR_ATR = 0.5;
/** Spec 14 FVG interaction: "fillPct crossed 50 or 100 inside it" — ≥50% penetration required. */
const FVG_FILL_PCT = 50;
/** Spec 14: "pullback quality ≥ 0.5 required" — spec-literal composite gate. */
const QUALITY_MIN = 0.5;

/** Everything the detector may legally see at one closed bar — same shape as the 4H provider. */
export interface ContinuationInput {
  structure?: MarketStructure;
  momentum?: Momentum;
  pools?: LiquidityPool[];
  zones?: Zone[];
  imbalances?: Imbalance[];
  alignment?: MultiTimeframeAlignment;
  events?: DetectionEvent[];
}

interface Live {
  key: string;
  setup: Setup;
  dir: Direction;
  anchorRef: string;
  impulseStart: number; // HL/LH pivot bar (premise origin — CHOCH cancellation is gated to it)
  impulseEnd: number; // HH/LL pivot bar
  impulseHeight: number;
  extreme: number; // evolving pullback extreme (min low bull / max high bear)
  extremeBar: number; // bar where the pullback extreme printed — bounds the pullback segment
  recoverySeen: boolean;
  recoveryClose?: number;
  progressBar: number; // last lifecycle progress (confirm/activation/target) — expiry reference
  counterLevel?: number; // last confirmed countertrend swing level (N7 evidence)
  confirmBar?: number;
  entryLow?: number;
  entryHigh?: number;
  invalidation?: number; // frozen at confirm: extreme ∓ invalidateAtr×ATR
  targets: number[];
  targetsHit: number;
  targetBars?: number[]; // bar index per hit, in order — spec 17 timeToTarget[]
}

const inside = (dir: Direction, close: number, level: number) => (dir === "bullish" ? close < level : close > level);
const sign = (dir: Direction) => (dir === "bullish" ? 1 : -1);

/** Spec-32 confirmation gate — direction-signed `alignmentScore >= 0.8` (spec 10's
 *  canonical rule). Inactive when no alignment is composed: unframed runs stay
 *  bit-identical to the spec-31 baseline. Evaluated per bar — never latched. */
const mtfConfirmable = (a: MultiTimeframeAlignment | undefined, dir: Direction): boolean =>
  a === undefined || a.alignmentScore * (dir === "bullish" ? 1 : -1) >= 0.8;

const REASON_LABEL: Record<string, { category: SetupReason["category"]; label: string }> = {
  N1: { category: "market_structure", label: "Established trend — trend=u/d + ≥minTrendSwings confirmed + ≥1 HH·HL / LH·LL in order" },
  N2: { category: "market_structure", label: "Impulse — last HL→HH (LH→LL) travel ≥ impulseMinAtr×ATR within impulseMaxBars" },
  N3: { category: "market_structure", label: "Pullback — ≥pullbackMinBars consecutive, depth ∈ [pullbackMinPct, pullbackMaxPct]" },
  N4: { category: "supply_demand", label: "Zone/FVG interaction — pullback extreme inside zone/proximal edge or ≥50% into impulse-leg FVG" },
  N5: { category: "momentum", label: "Pullback quality — overlap/displacement/volume composite ≥ 0.5" },
  N6: { category: "momentum", label: "Momentum recovery — strengthening or directionalMove flip + recovery body bar" },
  N8: { category: "multi_timeframe", label: "MTF confirmation threshold — direction-signed alignmentScore ≥ 0.8 (specs 10/32)" },
  N7: { category: "market_structure", label: "Continuation confirmation — close beyond last countertrend swing by confirmCloseAtr×ATR" },
};

const reason = (id: string, met: boolean, tf: Timeframe, signalIds?: string[]): SetupReason =>
  ({ id, category: REASON_LABEL[id].category, label: REASON_LABEL[id].label, met, timeframe: tf, signalIds });

const confirmedSwings = (s: MarketStructure | undefined, t: number): SwingPoint[] =>
  (s?.swings ?? []).filter(
    (x) => x.status === "confirmed" && x.confirmedIndex !== undefined && x.confirmedIndex <= t,
  );

/** Imbalance's legally-visible status at bar t — reconstructed from bar-indexed stamps only.
 *  The final `status` is NEVER consulted for terminal states: an FVG that fills at bar 110 was
 *  still open at bar 105, and only `filledBar`/`invalidatedAt`/`expiredBar` can say so. */
export function imbStatusAt(f: Imbalance, t: number, barMs?: number): Imbalance["status"] | "unformed" {
  const created = num(f.metadata?.createdBar);
  if (created !== undefined && created > t) return "unformed";
  if (f.invalidatedAt !== undefined && barMs !== undefined && Date.parse(f.invalidatedAt) <= barMs) return "invalidated";
  const filled = num(f.metadata?.filledBar);
  if (filled !== undefined) return filled <= t ? "filled" : "open"; // stamped → definitive both ways
  const expired = num(f.metadata?.expiredBar);
  if (expired !== undefined && expired <= t) return "expired";
  // No terminal stamp — keep the snapshot status verbatim: non-terminal states pass through;
  // an un-stamped terminal stays terminal (never inferred open — final status is not evidence).
  return f.status;
}

export function detectContinuations(input: {
  candles: readonly Candle[];
  symbol: string;
  timeframe: Timeframe;
  /** Legally-visible upstream outputs at closed bar `idx` (phase 4B–4G `*StateAt`/join). */
  at(idx: number): ContinuationInput | null;
  config: { lifecycle: LifecycleConfig; continuation: ContinuationConfig };
}): { setups: Setup[]; events: DetectionEvent[] } {
  const { candles, symbol, timeframe, at } = input;
  const cc = input.config.continuation;
  const lc = input.config.lifecycle;
  const live = new Map<string, Live>();
  const done: Setup[] = [];
  const events: DetectionEvent[] = [];
  const momHist: (Momentum | undefined)[] = [];

  const transit = (l: Live, t: number, to: SetupStatus, why: string) => {
    const s = l.setup;
    if (s.status === to && to !== "partial_target") return;
    s.status = to;
    s.updatedAt = toISO(candles[t].time);
    const barKey = TRANSITION_BAR[to];
    s.metadata = { ...(s.metadata ?? {}), transitionReason: why, ...(barKey ? { [barKey]: t } : {}) };
    events.push({
      kind: "setup_transition",
      refId: s.id,
      symbol,
      atBar: t,
      at: toISO(candles[t].time),
      metadata: { eventId: `${s.id}:${to}:${t}`, family: "continuation", to, transitionReason: why },
    });
  };
  const finish = (l: Live) => {
    live.delete(l.key);
    done.push(l.setup);
  };

  /** Trend + impulse per spec 14 — classified confirmed swings only, direction by trend. */
  function trendImpulse(snap: ContinuationInput | null, dir: Direction, t: number) {
    const st = snap?.structure;
    const want = dir === "bullish" ? "uptrend" : "downtrend";
    if (st?.trend !== want) return null;
    const sw = confirmedSwings(st, t);
    if (sw.length < cc.minTrendSwings) return null;
    const base = dir === "bullish" ? "HL" : "LH";
    const top = dir === "bullish" ? "HH" : "LL";
    const lastBase = [...sw].reverse().find((x) => x.classification === base && x.pivotIndex !== undefined);
    const lastTop = [...sw].reverse().find((x) => x.classification === top && x.pivotIndex !== undefined);
    if (!lastBase || !lastTop || lastBase.pivotIndex! >= lastTop.pivotIndex!) return null;
    const atr = atrAt(candles, t);
    const height = Math.abs(lastTop.price - lastBase.price);
    if (height < cc.impulseMinAtr * atr) return null;
    if (lastTop.pivotIndex! - lastBase.pivotIndex! > cc.impulseMaxBars) return null;
    return { base: lastBase, top: lastTop, height, atr };
  }

  /** N4 — pullback extreme inside a qualifying zone/proximal band or ≥50% into impulse-leg FVG. */
  function interaction(snap: ContinuationInput | null, dir: Direction, imp: { base: SwingPoint; top: SwingPoint }, t: number, extreme: number, atr: number): { zoneId?: string; fvgId?: string } {
    const zt = dir === "bullish" ? "demand" : "supply";
    for (const z of snap?.zones ?? []) {
      if (z.type !== zt || z.status !== "active") continue;
      if (z.freshness !== "fresh" && z.freshness !== "tested") continue;
      const inv = num(z.metadata?.invalidatedBar);
      if (inv !== undefined && inv <= t) continue;
      // proximal edge: the boundary facing price (upper for demand, lower for supply)
      const prox = dir === "bullish" ? z.upperPrice : z.lowerPrice;
      const distal = dir === "bullish" ? z.lowerPrice : z.upperPrice;
      const near = dir === "bullish" ? extreme >= distal && extreme <= prox + ZONE_NEAR_ATR * atr
                                     : extreme <= distal && extreme >= prox - ZONE_NEAR_ATR * atr;
      if (near) return { zoneId: z.id };
    }
    for (const f of snap?.imbalances ?? []) {
      if (f.direction !== dir) continue;
      const cb = num(f.metadata?.createdBar);
      if (cb === undefined || cb <= imp.base.pivotIndex! || cb > imp.top.pivotIndex!) continue; // must be from the impulse leg
      const st = imbStatusAt(f, t, candles[t].time);
      if (st !== "open" && st !== "partially_filled") continue;
      const h = f.upperPrice - f.lowerPrice;
      if (h <= 0) continue;
      const pen = dir === "bullish" ? ((f.upperPrice - extreme) / h) * 100 : ((extreme - f.lowerPrice) / h) * 100;
      if (pen >= FVG_FILL_PCT) return { fvgId: f.id };
    }
    return {};
  }

  /** N5 — spec-14 quality composite on [impulse bars, pullback bars] at the evaluation bar. */
  function quality(dir: Direction, l: Live, t: number): number | null {
    const parts: number[] = [];
    // (a) overlap ratio — combined bar range of pullback vs impulse; lower = cleaner.
    const rangeSum = (a: number, b: number) => {
      let s = 0;
      for (let i = a; i <= b; i++) s += candles[i].high - candles[i].low;
      return s;
    };
    const impR = rangeSum(l.impulseStart, l.impulseEnd);
    if (l.impulseEnd + 1 <= l.extremeBar && impR > 0) {
      parts.push(1 - Math.min(1, rangeSum(l.impulseEnd + 1, l.extremeBar) / impR)); // retracing segment only
    }
    // (b) counter-move displacement < impulse displacement — upstream scores only.
    const impDisp = Math.max(...Array.from({ length: l.impulseEnd - l.impulseStart + 1 }, (_, i) => {
      const m = momHist[l.impulseStart + i];
      return m?.bias === dir ? m.displacementScore ?? 0 : 0;
    }));
    const pullDisp = Math.max(...Array.from({ length: Math.max(0, l.extremeBar - l.impulseEnd) }, (_, i) => {
      const m = momHist[l.impulseEnd + 1 + i];
      return m && m.bias !== dir && m.bias !== "neutral" ? m.displacementScore ?? 0 : 0;
    }));
    if (impDisp > 0 || pullDisp > 0) parts.push(pullDisp < impDisp ? 1 : 0);
    // (c) declining pullback volume vs impulse volume (skipped where volume absent).
    const vol = (a: number, b: number) => {
      const vs: number[] = [];
      for (let i = a; i <= b; i++) if (typeof candles[i].volume === "number") vs.push(candles[i].volume!);
      return vs.length ? vs.reduce((x, y) => x + y, 0) / vs.length : undefined;
    };
    const iv = vol(l.impulseStart, l.impulseEnd);
    const pv = vol(l.impulseEnd + 1, t);
    if (iv !== undefined && pv !== undefined) parts.push(pv < iv ? 1 : 0);
    return parts.length ? parts.reduce((x, y) => x + y, 0) / parts.length : null;
  }

  /** N7 — last confirmed countertrend swing inside the pullback (micro lower-high / higher-low). */
  function counterSwing(snap: ContinuationInput | null, l: Live, t: number): SwingPoint | undefined {
    const kind = l.dir === "bullish" ? "high" : "low";
    return confirmedSwings(snap?.structure, t)
      .filter((x) => x.kind === kind && x.pivotIndex !== undefined && x.pivotIndex > l.impulseEnd && x.pivotIndex < t)
      .sort((a, b) => a.pivotIndex! - b.pivotIndex!)
      .at(-1);
  }

  for (let t = 0; t < candles.length; t++) {
    const bar = candles[t];
    const snap = at(t);
    momHist[t] = snap?.momentum;
    const atr = atrAt(candles, t);

    for (const l of [...live.values()]) {
      const s = l.setup;
      const terminal =
        s.status === "invalidated" || s.status === "expired" || s.status === "cancelled" || s.status === "target_reached";
      if (terminal) continue;

      // evolving pullback extreme + depth gate (hard rule — spec 14 test property)
      if (s.status === "developing") {
        const improved = l.dir === "bullish" ? bar.low < l.extreme : bar.high > l.extreme;
        if (improved) {
          l.extreme = l.dir === "bullish" ? bar.low : bar.high;
          l.extremeBar = t;
        }
        const top = num(s.metadata?.impulseTop) ?? l.extreme;
        const retrace = l.impulseHeight > 0 ? (Math.abs(top - l.extreme) / l.impulseHeight) * 100 : 0;
        if (retrace > cc.pullbackMaxPct) {
          transit(l, t, "cancelled", "pullback_too_deep"); // reversal warning — premise dies
          finish(l);
          continue;
        }
      }
      // cancelled — opposing confirmed CHOCH on the setup timeframe before confirmation
      if (s.status === "developing" && snap) {
        const choch = (snap.structure?.breaks ?? []).find(
          (b) => b.confirmed && b.direction !== l.dir && b.type === "CHOCH" &&
            b.breakIndex !== undefined && b.breakIndex > l.impulseStart && b.breakIndex <= t,
        );
        if (choch) {
          transit(l, t, "cancelled", `opposing_${choch.type}`);
          finish(l);
          continue;
        }
      }
      // invalidated — close through the pullback defence (level frozen at confirmation)
      if (l.invalidation !== undefined && inside(l.dir, bar.close, l.invalidation)) {
        transit(l, t, "invalidated", "close_through_defence");
        finish(l);
        continue;
      }
      // targets while active (ordered evidence levels, not orders)
      if (s.status === "active" || s.status === "partial_target") {
        let hit = 0;
        while (l.targetsHit < l.targets.length) {
          const reached = l.dir === "bullish" ? bar.high >= l.targets[l.targetsHit] : bar.low <= l.targets[l.targetsHit];
          if (!reached) break;
          l.targetsHit++;
          (l.targetBars ??= []).push(t);
          hit++;
        }
        if (hit > 0) {
          s.metadata = { ...(s.metadata ?? {}), targetBars: (l.targetBars ?? []).join(",") };
          l.progressBar = t;
          const final = l.targetsHit >= l.targets.length;
          transit(l, t, final ? "target_reached" : "partial_target", final ? "final_target" : `target_${l.targetsHit}`);
          if (final) { finish(l); continue; }
        }
      }
      // N6 — momentum recovery latch (recovery bar evidence kept for the entry band)
      if (s.status === "developing" && snap?.momentum) {
        const m = snap.momentum;
        const dm = m.features?.directionalMove;
        const flipped =
          dm !== undefined &&
          ((l.dir === "bullish" && dm > 0) || (l.dir === "bearish" && dm < 0)) &&
          momHist.slice(l.impulseEnd + 1, t).some((x) => {
            const d = x?.features?.directionalMove;
            return d !== undefined && ((l.dir === "bullish" && d < 0) || (l.dir === "bearish" && d > 0));
          });
        const bodyOk = Math.abs(bar.close - bar.open) >= cc.recoveryBodyAtr * atr &&
          (l.dir === "bullish" ? bar.close > bar.open : bar.close < bar.open);
        if (bodyOk && (m.state === "strengthening" || flipped)) {
          l.recoverySeen = true;
          l.recoveryClose = bar.close;
          const r6 = s.reasons.find((r) => r.id === "N6");
          if (r6) r6.met = true;
        }
      }
      // developing → confirmed: N5 quality + latched recovery + N7 countertrend close
      if (s.status === "developing") {
        const q = quality(l.dir, l, t);
        const r5 = s.reasons.find((r) => r.id === "N5");
        if (r5 && q !== null && q >= QUALITY_MIN) r5.met = true;
        const cs = counterSwing(snap, l, t);
        if (cs) l.counterLevel = cs.price;
        const confirmClose =
          l.counterLevel !== undefined &&
          beyond2(l.dir, bar.close, l.counterLevel, cc.confirmCloseAtr * atr);
        // Spec 32 — numeric confirmation gate tracks the CURRENT bar's signed score
        // (not latched); N8 reports the verdict honestly while developing.
        const r8 = s.reasons.find((r) => r.id === "N8");
        if (r8) r8.met = mtfConfirmable(snap?.alignment, l.dir);
        const r7 = s.reasons.find((r) => r.id === "N7");
        if (r7) {
          r7.met = confirmClose === true;
          if (cs && !r7.signalIds?.includes(cs.id ?? "")) r7.signalIds = [...(r7.signalIds ?? []), cs.id ?? `${cs.pivotIndex}`];
        }
        if (q !== null && q >= QUALITY_MIN && l.recoverySeen && confirmClose &&
            mtfConfirmable(snap?.alignment, l.dir)) {
          l.confirmBar = t;
          const pbLow = l.extreme;
          const rec = l.recoveryClose ?? bar.close;
          l.entryLow = Math.min(pbLow, rec);
          l.entryHigh = Math.max(pbLow, rec);
          l.invalidation = l.dir === "bullish" ? pbLow - lc.invalidateAtr * atr : pbLow + lc.invalidateAtr * atr;
          // targets — T1 prior HH/LL, T2 impulse projection from the pullback extreme, T3 next opposing pool
          const forward = (p: number) => sign(l.dir) * (p - pbLow);
          const t1 = num(s.metadata?.impulseTop) ?? pbLow;
          const t2 = pbLow + sign(l.dir) * l.impulseHeight;
          const t3 = (snap?.pools ?? [])
            .filter((p) => forward(p.price) > 0 && p.price !== t1 && poolStatusAt(p, t) === "resting" &&
              sign(l.dir) * (p.price - t1) > 0)
            .map((p) => p.price)
            .sort((a, b) => forward(a) - forward(b))[0];
          l.targets = [...new Set([t1, t2, t3]
            .filter((x): x is number => x !== undefined && Number.isFinite(x))
            .map((x) => Number(x.toFixed(8))))].sort((a, b) => forward(a) - forward(b));
          s.metadata = {
            ...(s.metadata ?? {}), pullbackExtreme: pbLow, quality: Number(q.toFixed(4)),
            entryBandLow: l.entryLow, entryBandHigh: l.entryHigh, invalidation: l.invalidation,
            targets: l.targets.join(","), confirmBar: t, recoveryClose: rec,
            t3PoolId: (snap?.pools ?? []).find((p) => p.price === t3)?.id ?? null,
          };
          l.progressBar = t;
          transit(l, t, "confirmed", "quality_recovery_confirm");
        }
      }
      // confirmed → active — spec 11: bar range overlaps the entry band (wick counts).
      if (s.status === "confirmed" && l.entryLow !== undefined && l.entryHigh !== undefined &&
          bar.low <= l.entryHigh && bar.high >= l.entryLow) {
        l.progressBar = t;
        transit(l, t, "active", "band_reentry");
      }
      // expired — spec 11 universal stale guard: no `active` within expiryBars of creation
      // (developing/confirmed), or no target/invalidation for expiryBars while active.
      {
        const created = num(s.metadata?.candidateBar) ?? t;
        const preActive = s.status === "developing" || s.status === "confirmed";
        const stale = preActive ? t - created > lc.expiryBars : t - l.progressBar > lc.expiryBars;
        if (s.status !== "cancelled" && stale) {
          transit(l, t, "expired", "stalled");
          finish(l);
        }
      }
    }

    // ---- New developing candidate: trend + impulse + valid pullback + zone/FVG interaction. ----
    if (snap) {
      for (const dir of ["bullish", "bearish"] as const) {
        const imp = trendImpulse(snap, dir, t);
        if (!imp) continue;
        const top = imp.top.price;
        const pbBars = t - imp.top.pivotIndex!;
        if (pbBars < cc.pullbackMinBars) continue;
        const extreme = dir === "bullish"
          ? Math.min(...candles.slice(imp.top.pivotIndex! + 1, t + 1).map((x) => x.low))
          : Math.max(...candles.slice(imp.top.pivotIndex! + 1, t + 1).map((x) => x.high));
        const retrace = imp.height > 0 ? (Math.abs(top - extreme) / imp.height) * 100 : 0;
        if (retrace < cc.pullbackMinPct || retrace > cc.pullbackMaxPct) continue;
        const it = interaction(snap, dir, imp, t, extreme, atr);
        if (!it.zoneId && !it.fvgId) continue; // spec 14: interaction is required — no anchor, no setup
        const anchorRef = it.zoneId ?? it.fvgId!;
        const key = `${dir}:${anchorRef}`;
        if (live.has(key)) continue;
        if (done.some((x) => x.direction === dir && x.metadata?.anchorRef === anchorRef)) continue;
        const id = `cont:${symbol}:${timeframe}:${dir}:${anchorRef}`;
        const setup: Setup = {
          id,
          symbol,
          timeframe,
          type: "continuation",
          direction: dir,
          score: 0, // placeholder — spec 15 scoring is a later phase; 0 ≠ quality claim
          status: "developing",
          reasons: [
            reason("N1", true, timeframe),
            reason("N2", true, timeframe),
            reason("N3", true, timeframe),
            reason("N4", true, timeframe, [it.zoneId ?? it.fvgId].filter((x): x is string => x !== undefined)),
            reason("N5", false, timeframe),
            reason("N6", false, timeframe),
            reason("N7", false, timeframe),
            // Spec 32 — the gate reason exists only when alignment is composed; absent
            // alignment emits nothing so unframed records stay identical to baseline.
            ...(snap.alignment !== undefined
              ? [reason("N8", mtfConfirmable(snap.alignment, dir), timeframe)]
              : []),
          ],
          zoneIds: it.zoneId ? [it.zoneId] : undefined,
          contextTimeframe: snap.alignment?.timeframes.htf,
          createdAt: toISO(bar.time),
          metadata: {
            candidateBar: t,
            anchorRef,
            fvgId: it.fvgId ?? null,
            impulseBase: imp.base.price,
            impulseTop: imp.top.price,
            impulseStart: imp.base.pivotIndex ?? null,
            impulseEnd: imp.top.pivotIndex ?? null,
            impulseHeight: imp.height,
            pullbackExtreme: extreme,
            mtfState: snap.alignment?.state ?? null,
          },
        };
        const extremeBar = dir === "bullish"
          ? imp.top.pivotIndex! + 1 + candles.slice(imp.top.pivotIndex! + 1, t + 1).findIndex((x) => x.low === extreme)
          : imp.top.pivotIndex! + 1 + candles.slice(imp.top.pivotIndex! + 1, t + 1).findIndex((x) => x.high === extreme);
        live.set(key, {
          key, setup, dir, anchorRef,
          impulseStart: imp.base.pivotIndex!, impulseEnd: imp.top.pivotIndex!, impulseHeight: imp.height,
          extreme, extremeBar, recoverySeen: false, progressBar: t, targets: [], targetsHit: 0,
        });
        events.push({
          kind: "setup_transition",
          refId: id,
          symbol,
          atBar: t,
          at: toISO(bar.time),
          metadata: { eventId: `${id}:developing:${t}`, family: "continuation", to: "developing", transitionReason: "pullback_into_origin" },
        });
      }
    }
  }

  for (const l of live.values()) done.push(l.setup);
  done.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { setups: done, events };
}

/** beyond-margin helper (dir-relative close comparison). */
function beyond2(dir: Direction, close: number, level: number, margin: number): boolean {
  return dir === "bullish" ? close > level + margin : close < level - margin;
}

/**
 * Contract adapter — consumes end-of-series snapshots per the `SetupDetectionEngine` contract.
 * Historical runs that need causality should drive `detectContinuations` with 4G-joined providers;
 * bar-indexed metadata still guards what each bar may see.
 */
export function createContinuationSetupEngine(): SetupDetectionEngine {
  return {
    detect(input) {
      const errors: EngineError[] = [];
      const c = input.config.continuation;
      const bad =
        c.minTrendSwings < 1 || c.impulseMinAtr < 0 || c.impulseMaxBars < 1 ||
        c.pullbackMinPct < 0 || c.pullbackMaxPct <= c.pullbackMinPct || c.pullbackMaxPct > 100 ||
        c.pullbackMinBars < 1 || c.recoveryBodyAtr < 0 || c.confirmCloseAtr < 0 ||
        input.config.lifecycle.expiryBars < 0 || input.config.lifecycle.invalidateAtr < 0;
      if (bad)
        errors.push({
          code: "invalid_config",
          message: "continuation: minTrendSwings/impulseMaxBars/pullbackMinBars ≥ 1, 0 ≤ pullbackMinPct < pullbackMaxPct ≤ 100, ATR margins ≥ 0",
        });
      const candles = input.series?.candles ?? [];
      if (candles.length === 0)
        return {
          ok: errors.length === 0, data: [] as Setup[], errors,
          meta: { stage: "setups", paramsVersion: "1", barsConsumed: { from: -1, to: -1 }, events: [], diagnostics: { family: "continuation", setups: 0, confirmed: 0 } },
        };
      const { setups, events } = bad
        ? { setups: [] as Setup[], events: [] as DetectionEvent[] }
        : detectContinuations({
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
          diagnostics: { family: "continuation", setups: setups.length, confirmed: setups.filter((s) => s.status !== "developing").length },
        },
      };
    },
  };
}
