/**
 * Breakout Setup Detection Engine (docs/engine/13 — conditions; 11 — universal lifecycle).
 *
 * Chronological, causal per-bar state machine, structurally paired with `reversal.ts` (4H).
 * The engine consumes per-bar snapshots of the Phase 4B–4G outputs via a caller-supplied
 * provider — the canonical causal path composes the 4G join:
 *
 *   causalFramesAt(roles, t) → JoinedFrame.snapshot → detectBreakouts.at(idx)
 *
 * Contract `detect()` consumes end-of-series snapshots (caller duty); historical backtests
 * MUST drive `detectBreakouts` with per-bar `*StateAt` providers.
 *
 * Spec-13 specifics:
 * - The range itself is a *setup-level* definition (last ≥ rangeMinBars bars with
 *   max−min ≤ rangeMaxWidthAtr×ATR, structure trend "range") — not an upstream entity.
 *   Its boundaries are expected to coincide with `range_high`/`range_low` pools (spec 04);
 *   the pool is the anchor when present, otherwise the boundary price + range start anchor.
 * - Close-only rule: a wick beyond a boundary is nothing (spec 13/04). Attempts are computed
 *   from closes vs `breakout.breakAtr`; the liquidity stage's labels are consumed for the
 *   sweep-vs-attempt distinction — "a bar cannot be both a sweep and a breakout attempt
 *   (sweep classification wins)".
 * - developing is emitted as a bullish+bearish pair per range — direction is unknowable
 *   pre-break; the opposite-direction setup is `cancelled` when one side attempts.
 * - invalidated maps the spec's false-breakout semantics: any inside-close before
 *   acceptance = `false_breakout`; post-acceptance requires `invalidateAtr` depth.
 *
 * Deliberately out of scope: scoring, trade plans (targets/entry band are lifecycle evidence
 * metadata only), continuation setups, probability, alerts, execution.
 */
import type {
  BreakoutConfig,
  Candle,
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
  Timeframe,
  Zone,
} from "@/lib/types";
import type { EngineError, SetupDetectionEngine } from "@/lib/services/engine";
import { atrAt, poolStatusAt } from "./reversal";

const toISO = (ms: number) => new Date(ms).toISOString();
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** Spec 13 retest touch tolerance: "low ≤ resistance + 0.1×ATR" — fixed constant like spec 04's approachAtr. */
const RETEST_ATR = 0.1;
/** Spec 13: entry band = broken boundary ± 0.25×ATR (metadata evidence, not an order). */
const ENTRY_BAND_ATR = 0.25;

/** Everything the detector may legally see at one closed bar — same shape as the 4H provider. */
export interface BreakoutInput {
  structure?: MarketStructure;
  momentum?: Momentum;
  pools?: LiquidityPool[];
  zones?: Zone[];
  imbalances?: Imbalance[];
  alignment?: MultiTimeframeAlignment;
  events?: DetectionEvent[];
}

interface RangeQual {
  start: number;
  support: number;
  resistance: number;
  height: number;
}

interface Live {
  key: string; // `live` map key — `${rangeKey}:${dir}`
  setup: Setup;
  dir: Direction;
  rangeKey: string;
  rangeStart: number;
  support: number;
  resistance: number;
  boundary: number; // resistance for bullish, support for bearish
  anchorPoolId?: string;
  attemptBar?: number;
  volumeOk?: boolean; // B6 evaluated once at the attempt bar (skipped → true)
  confirmedBar?: number;
  activatedBar?: number;
  invalidation: number; // post-acceptance level — boundary ∓ invalidateAtr×ATR inside
  targets: number[]; // ordered evidence levels T1→T2
  targetsHit: number;
}

const inside = (dir: Direction, close: number, b: number) => (dir === "bullish" ? close < b : close > b);
const beyond = (dir: Direction, close: number, b: number, margin: number) =>
  dir === "bullish" ? close > b + margin : close < b - margin;
const sign = (dir: Direction) => (dir === "bullish" ? 1 : -1);

/** HTF side of the alignment: votes.htf when numeric, else parsed from the state label. */
function htfBias(a?: MultiTimeframeAlignment): Direction | "neutral" | undefined {
  if (!a) return undefined;
  const v = num(a.votes?.htf);
  if (v !== undefined) return v > 0 ? "bullish" : v < 0 ? "bearish" : "neutral";
  const s = a.state;
  if (s === "aligned_bull" || s === "pullback_in_trend_bull" || s === "realigning_bull" || s === "countertrend_bear")
    return "bullish";
  if (s === "aligned_bear" || s === "pullback_in_trend_bear" || s === "realigning_bear" || s === "countertrend_bull")
    return "bearish";
  return "neutral";
}

const REASON_LABEL: Record<string, { category: SetupReason["category"]; label: string }> = {
  B1: { category: "market_structure", label: "Range identified — structure trend range, span ≥ rangeMinBars, width ≤ rangeMaxWidthAtr×ATR" },
  B2: { category: "market_structure", label: "Compression — mean bar-range of tail ÷ range ≤ compressionRatio" },
  B3: { category: "liquidity", label: "Boundary pool anchor (range_high/range_low, spec 04)" },
  B4: { category: "liquidity", label: "Breakout attempt — close beyond boundary by breakAtr×ATR, not sweep-classified" },
  B5: { category: "momentum", label: "Displacement — displacementScore ≥ dispMinScore in break direction (attempt bar..+holdBars)" },
  B6: { category: "liquidity", label: "Volume — breakout-bar volume ≥ volumeMinRatio × median(20) (skipped when absent)" },
  B7: { category: "multi_timeframe", label: "HTF context does not fight the break direction (never auto-confirmed)" },
  B8: { category: "market_structure", label: "No opposing CHOCH before confirmation" },
};

const reason = (id: string, met: boolean, tf: Timeframe, signalIds?: string[]): SetupReason =>
  ({ id, category: REASON_LABEL[id].category, label: REASON_LABEL[id].label, met, timeframe: tf, signalIds });

/** Median of defined volumes over the 20 bars ending at `b`; undefined → check skipped. */
function medianVolume(candles: readonly Candle[], b: number): number | undefined {
  const vals: number[] = [];
  for (let i = Math.max(0, b - 19); i <= b; i++) {
    const v = candles[i].volume;
    if (typeof v === "number") vals.push(v);
  }
  if (vals.length < 20) return undefined;
  vals.sort((a, z) => a - z);
  const m = vals.length >> 1;
  return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
}

export function detectBreakouts(input: {
  candles: readonly Candle[];
  symbol: string;
  timeframe: Timeframe;
  /** Legally-visible upstream outputs at closed bar `idx` (phase 4B–4G `*StateAt`/join). */
  at(idx: number): BreakoutInput | null;
  config: { lifecycle: LifecycleConfig; breakout: BreakoutConfig };
}): { setups: Setup[]; events: DetectionEvent[] } {
  const { candles, symbol, timeframe, at } = input;
  const bc = input.config.breakout;
  const lc = input.config.lifecycle;
  const live = new Map<string, Live>(); // key: `${rangeKey}:${dir}` — duplicate prevention
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
      metadata: { eventId: `${s.id}:${to}:${t}`, family: "breakout", to, transitionReason: why },
    });
  };
  const finish = (l: Live) => {
    live.delete(l.key);
    done.push(l.setup);
  };

  /** Spec-13 range: longest suffix of closed bars whose max−min ≤ rangeMaxWidthAtr×ATR. */
  function qualifyRange(t: number): RangeQual | null {
    const atr = atrAt(candles, t);
    const cap = bc.rangeMaxWidthAtr * atr;
    let s = t;
    let hi = -Infinity;
    let lo = Infinity;
    while (s >= 0) {
      const nh = Math.max(hi, candles[s].high);
      const nl = Math.min(lo, candles[s].low);
      if (nh - nl > cap) break;
      hi = nh;
      lo = nl;
      s -= 1;
    }
    const start = s + 1;
    const len = t - start + 1;
    if (len < Math.max(bc.rangeMinBars, 1)) return null;
    const meanRange = (a: number, b: number) => {
      let sum = 0;
      for (let i = a; i <= b; i++) sum += candles[i].high - candles[i].low;
      return sum / (b - a + 1);
    };
    const tail = Math.min(bc.compressionBars, len);
    const compressed = meanRange(t - tail + 1, t) / meanRange(start, t) <= bc.compressionRatio;
    if (!compressed) return null;
    return { start, support: lo, resistance: hi, height: hi - lo };
  }

  /** Nearest boundary pool of the matching source/side within `anchorNearAtr`×ATR. */
  function anchorPool(pools: LiquidityPool[] | undefined, dir: Direction, boundary: number, t: number, atr: number) {
    const src = dir === "bullish" ? "range_high" : "range_low";
    const side = dir === "bullish" ? "buy_side" : "sell_side";
    return (pools ?? [])
      .filter(
        (p) =>
          p.side === side &&
          p.sources.includes(src) &&
          poolStatusAt(p, t) !== "swept" &&
          Math.abs(p.price - boundary) <= bc.anchorNearAtr * atr,
      )
      .sort((a, b) => Math.abs(a.price - boundary) - Math.abs(b.price - boundary) || a.id.localeCompare(b.id))[0];
  }

  /** Knowable sweep/false-breakout classification on the boundary pool (upstream label wins). */
  function boundaryTagged(snap: BreakoutInput | null, l: Live, t: number): string | null {
    const pool = (snap?.pools ?? []).find((p) => p.id === l.anchorPoolId);
    if (pool && poolStatusAt(pool, t) === "swept") return "boundary_swept";
    const e = (snap?.events ?? []).find(
      (e) =>
        e.refId === l.anchorPoolId &&
        e.atBar <= t &&
        (e.kind === "sweep_confirmed" || e.kind === "sweep_developing" || e.kind === "false_breakout"),
    );
    return e ? `boundary_${e.kind}` : null;
  }

  for (let t = 0; t < candles.length; t++) {
    const bar = candles[t];
    const snap = at(t);
    const atr = atrAt(candles, t);
    const range = snap?.structure?.trend === "range" ? qualifyRange(t) : null;

    // ---- Lifecycle for live setups (spec 11) — evaluated at every closed bar. ----
    for (const l of [...live.values()]) {
      const s = l.setup;
      const terminal =
        s.status === "invalidated" || s.status === "expired" || s.status === "cancelled" || s.status === "target_reached";
      if (terminal) continue;

      // 1. upstream classification wins — boundary pool swept / false-breakout
      if (l.attemptBar !== undefined || s.status === "confirmed" || s.status === "active" || s.status === "partial_target") {
        const tag = boundaryTagged(snap, l, t);
        if (tag) {
          transit(l, t, "invalidated", tag);
          finish(l);
          continue;
        }
      }
      // 2. close-back-inside rules (close only — wicks never invalidate)
      const isInside = inside(l.dir, bar.close, l.boundary);
      if (l.attemptBar !== undefined && (s.status === "developing" || s.status === "confirmed") && isInside) {
        transit(l, t, "invalidated", "false_breakout"); // spec 13: reclaim inside before acceptance
        finish(l);
        continue;
      }
      if ((s.status === "active" || s.status === "partial_target") && inside(l.dir, bar.close, l.invalidation)) {
        transit(l, t, "invalidated", "close_through_invalidation");
        finish(l);
        continue;
      }
      // 3. targets while active (ordered hits — evidence levels, not orders)
      if (s.status === "active" || s.status === "partial_target") {
        let hit = 0;
        while (l.targetsHit < l.targets.length) {
          const reached = l.dir === "bullish" ? bar.high >= l.targets[l.targetsHit] : bar.low <= l.targets[l.targetsHit];
          if (!reached) break;
          l.targetsHit++;
          hit++;
        }
        if (hit > 0) {
          const final = l.targetsHit >= l.targets.length;
          transit(l, t, final ? "target_reached" : "partial_target", final ? "final_target" : `target_${l.targetsHit}`);
          if (final) { finish(l); continue; }
        }
      }
      // 4. attempt → developing-with-attempt (close-only; sweep classification disqualifies)
      if (s.status === "developing" && l.attemptBar === undefined &&
          beyond(l.dir, bar.close, l.boundary, bc.breakAtr * atr) &&
          boundaryTagged(snap, l, t) === null) {
        l.attemptBar = t;
        s.metadata = { ...(s.metadata ?? {}), attemptBar: t };
        const med = medianVolume(candles, t);
        l.volumeOk = med === undefined || (bar.volume !== undefined && bar.volume >= bc.volumeMinRatio * med);
        const r4 = s.reasons.find((r) => r.id === "B4");
        if (r4) r4.met = true;
        const r6 = s.reasons.find((r) => r.id === "B6");
        if (r6) r6.met = l.volumeOk === true;
      }
      // 5. confirmation — attempt + displacement (+volume) + HTF not fighting
      if (s.status === "developing" && l.attemptBar !== undefined) {
        const dispMet =
          snap?.momentum !== undefined &&
          (snap.momentum.displacementScore ?? -1) >= bc.dispMinScore &&
          snap.momentum.bias === l.dir;
        const r5 = s.reasons.find((r) => r.id === "B5");
        if (r5 && dispMet) r5.met = true;
        const fighting = snap?.alignment !== undefined && htfBias(snap.alignment) !== undefined &&
          htfBias(snap.alignment) !== "neutral" && htfBias(snap.alignment) !== l.dir;
        const r7 = s.reasons.find((r) => r.id === "B7");
        if (r7) r7.met = snap?.alignment !== undefined && !fighting;
        // dispBars window is [attemptBar, attemptBar+dispBars] — expiry precedes confirm so a
        // late displacement can never confirm outside the spec window.
        if (t - l.attemptBar > bc.dispBars) {
          transit(l, t, "expired", "attempt_unconfirmed"); // displacement window elapsed
          finish(l);
          continue;
        } else if (dispMet && l.volumeOk !== false && !fighting) {
          l.confirmedBar = t;
          s.metadata = { ...(s.metadata ?? {}), confirmBar: t, dispScore: snap?.momentum?.displacementScore ?? null };
          transit(l, t, "confirmed", "attempt_disp_confirmed");
        }
      }
      // 6. acceptance or retest → active (spec 13: setup tradeable only once the level holds)
      if (s.status === "confirmed" && l.attemptBar !== undefined) {
        const touches =
          l.dir === "bullish" ? bar.low <= l.boundary + RETEST_ATR * atr : bar.high >= l.boundary - RETEST_ATR * atr;
        const closesOut = !inside(l.dir, bar.close, l.boundary);
        const retestHold = t > l.attemptBar && touches && closesOut && t - l.attemptBar <= bc.retestWindow;
        const acceptance = t - l.attemptBar >= bc.holdBars; // any inside-close already invalidated
        if (acceptance || retestHold) {
          l.activatedBar = t;
          transit(l, t, "active", acceptance ? "acceptance_held" : "retest_hold");
        } else if (t - l.attemptBar > bc.retestWindow) {
          transit(l, t, "expired", "retest_window");
          finish(l);
          continue;
        }
      }
      // 7. cancelled — opposing confirmed CHOCH before confirmation; opposite side broke first
      if (s.status === "developing" && snap) {
        const oppChoch = (snap.structure?.breaks ?? []).find(
          (b) => b.confirmed && b.direction !== l.dir && b.type === "CHOCH" &&
            b.breakIndex !== undefined && b.breakIndex > l.rangeStart && b.breakIndex <= t,
        );
        if (oppChoch) {
          const r8 = s.reasons.find((r) => r.id === "B8");
          if (r8) r8.met = false;
          transit(l, t, "cancelled", `opposing_${oppChoch.type}`);
          finish(l);
          continue;
        }
      }
      // 8. expiry — developing without attempt: lifecycle expiry or the range ceased to qualify
      if (s.status === "developing" && l.attemptBar === undefined) {
        const created = num(s.metadata?.candidateBar) ?? t;
        const rangeLost = range === null || range.start > l.rangeStart;
        if (t - created > lc.expiryBars || rangeLost) {
          transit(l, t, "expired", rangeLost ? "range_lost" : "stalled");
          finish(l);
        }
      }
    }

    // ---- New developing pair: a qualifying range emits bullish + bearish candidates. ----
    if (range) {
      for (const dir of ["bullish", "bearish"] as const) {
        const boundary = dir === "bullish" ? range.resistance : range.support;
        const anchor = anchorPool(snap?.pools, dir, boundary, t, atr);
        const rangeKey = anchor?.id ?? `rng:${range.start}`;
        const key = `${rangeKey}:${dir}`;
        if (live.has(key)) continue;
        if (done.some((x) => x.direction === dir && x.metadata?.rangeKey === rangeKey)) continue;
        const height = range.height;
        const invalidation =
          dir === "bullish" ? boundary - lc.invalidateAtr * atr : boundary + lc.invalidateAtr * atr;
        // Targets — ordered evidence levels (T1 measured move; T2 nearest opposing pool/zone).
        const forward = (p: number) => sign(dir) * (p - boundary);
        const t1 = boundary + sign(dir) * height;
        const opposing = (snap?.pools ?? [])
          .filter((p) => forward(p.price) > 0 && poolStatusAt(p, t) === "resting")
          .map((p) => p.price);
        const opposingZones = (snap?.zones ?? [])
          .filter((z) => forward(dir === "bullish" ? z.lowerPrice : z.upperPrice) > 0 && z.status === "active")
          .map((z) => (dir === "bullish" ? z.lowerPrice : z.upperPrice));
        const t2 = [...opposing, ...opposingZones].sort((a, b) => forward(a) - forward(b))[0];
        const targets = [...new Set(
          [t1, t2]
            .filter((x): x is number => x !== undefined && Number.isFinite(x))
            .map((x) => Number(x.toFixed(8))), // collapse float-noise duplicates (T1 == zone edge)
        )].sort((a, b) => forward(a) - forward(b));
        const id = `bo:${symbol}:${timeframe}:${dir}:${rangeKey}`;
        const setup: Setup = {
          id,
          symbol,
          timeframe,
          type: "breakout",
          direction: dir,
          score: 0, // placeholder — spec 15 scoring is a later phase; 0 ≠ quality claim
          status: "developing",
          reasons: [
            reason("B1", true, timeframe),
            reason("B2", true, timeframe),
            reason("B3", anchor !== undefined, timeframe, anchor?.id ? [anchor.id] : undefined),
            reason("B4", false, timeframe),
            reason("B5", false, timeframe),
            reason("B6", false, timeframe),
            reason("B7", false, timeframe),
            reason("B8", true, timeframe),
          ],
          zoneIds: undefined,
          liquidityEventIds: anchor ? [anchor.id] : undefined,
          contextTimeframe: snap?.alignment?.timeframes.htf,
          createdAt: toISO(bar.time),
          metadata: {
            candidateBar: t,
            rangeKey,
            rangeStart: range.start,
            support: range.support,
            resistance: range.resistance,
            boundary,
            rangeHeight: height,
            anchorPoolId: anchor?.id ?? null,
            entryBandLow: boundary - ENTRY_BAND_ATR * atr,
            entryBandHigh: boundary + ENTRY_BAND_ATR * atr,
            invalidation,
            targets: targets.join(","),
            mtfState: snap?.alignment?.state ?? null,
          },
        };
        const l: Live = {
          key, setup, dir, rangeKey, rangeStart: range.start,
          support: range.support, resistance: range.resistance, boundary,
          anchorPoolId: anchor?.id, invalidation, targets, targetsHit: 0,
        };
        live.set(key, l);
        events.push({
          kind: "setup_transition",
          refId: id,
          symbol,
          atBar: t,
          at: toISO(bar.time),
          metadata: { eventId: `${id}:developing:${t}`, family: "breakout", to: "developing", transitionReason: "range_qualified" },
        });
      }
    }
  }

  for (const l of live.values()) done.push(l.setup);
  done.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { setups: done, events };
}

/**
 * Contract adapter — consumes end-of-series snapshots per the `SetupDetectionEngine` contract.
 * Historical runs that need causality should drive `detectBreakouts` with 4G-joined providers;
 * bar-indexed pool metadata still guards what each bar may see.
 */
export function createBreakoutSetupEngine(): SetupDetectionEngine {
  return {
    detect(input) {
      const errors: EngineError[] = [];
      const b = input.config.breakout;
      const bad =
        b.rangeMinBars < 1 || b.compressionBars < 1 || b.rangeMaxWidthAtr <= 0 ||
        b.compressionRatio <= 0 || b.breakAtr < 0 || b.dispMinScore < 0 ||
        b.holdBars < 1 || b.retestWindow < 1 || b.volumeMinRatio < 0 ||
        b.dispBars < 0 || b.anchorNearAtr < 0 ||
        input.config.lifecycle.expiryBars < 0 || input.config.lifecycle.invalidateAtr < 0;
      if (bad)
        errors.push({
          code: "invalid_config",
          message: "breakout: rangeMinBars/compressionBars/holdBars/retestWindow ≥ 1, ATR widths > 0, ratios ≥ 0, dispBars/anchorNearAtr ≥ 0",
        });
      const candles = input.series?.candles ?? [];
      if (candles.length === 0)
        return {
          ok: errors.length === 0, data: [] as Setup[], errors,
          meta: { stage: "setups", paramsVersion: "1", barsConsumed: { from: -1, to: -1 }, events: [], diagnostics: { family: "breakout", setups: 0, confirmed: 0 } },
        };
      const { setups, events } = bad
        ? { setups: [] as Setup[], events: [] as DetectionEvent[] }
        : detectBreakouts({
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
          diagnostics: { family: "breakout", setups: setups.length, confirmed: setups.filter((s) => s.status !== "developing").length },
        },
      };
    },
  };
}
