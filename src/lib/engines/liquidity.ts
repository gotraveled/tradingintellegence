import type {
  Candle,
  DetectionEvent,
  LiquidityConfig,
  LiquidityPool,
  LiquidityPoolType,
  LiquiditySide,
  MarketStructure,
  SwingPoint,
  Timeframe,
} from "@/lib/types";
import type { EngineError, LiquidityEngine } from "@/lib/services/engine";

/**
 * Liquidity Engine (docs/engine/04-liquidity.md).
 * Consumes the MarketStructure output (classified confirmed swings) — never recomputes
 * swings or structure. Pools (levels) and interactions (sweeps/breaks) are distinct entities.
 *
 * Look-ahead: pools form at the swing-confirmation bar (or session boundary); interactions
 * evaluate per bar close. `analyzeLiquidity(..., upToIndex)` is a point-in-time snapshot.
 *
 * ATR convention (documented in spec 04 notes): every level margin uses the pool's frozen
 * formation ATR — the representative swing's `metadata.atrAtPivot`; session pools use the
 * mean true range of the prior session's bars. Deterministic and scale-free.
 */

const toISO = (ms: number): string => new Date(ms).toISOString();
const APPROACH_ATR = 0.1; // spec 04: "approachAtr (0.1×ATR)" — fixed constant, not config.

export function poolId(
  symbol: string,
  timeframe: Timeframe,
  side: LiquiditySide,
  price: number,
  formedAt: number,
): string {
  return `liq:${symbol}:${timeframe}:${side}:${price}:${formedAt}`;
}

const atrOf = (s: SwingPoint): number =>
  typeof s.metadata?.atrAtPivot === "number" ? s.metadata.atrAtPivot : 0;
const equalCountOf = (s: SwingPoint): number =>
  typeof s.metadata?.equalCount === "number" ? s.metadata.equalCount : 1;

// ---------------------------------------------------------------------------

interface Pool extends LiquidityPool {
  /** Frozen formation ATR — all margins for this pool scale to it. */
  atr: number;
  memberIds: string[];
  lastTouchBar: number;
  /** Pending interaction state (one open raid/break per pool). */
  raid?: { penetrationBar: number; extreme: number };
  sweep?: { reclaimBar: number; extreme: number; penetrationBar: number };
  pendingBreak?: { breakBar: number; direction: "beyond_low" | "beyond_high" };
}

const band = (p: Pool): { lo: number; hi: number } => ({
  lo: p.lowerPrice ?? p.price,
  hi: p.upperPrice ?? p.price,
});

/** Two pools overlap when their bands touch within merge tolerance. */
function overlaps(a: Pool, cand: FormCandidate, tol: number): boolean {
  const b = band(a);
  return cand.hi >= b.lo - tol && cand.lo <= b.hi + tol;
}

const STATUS_RANK: Record<string, number> = { resting: 0, approaching: 1, expired: 2, swept: 3, broken: 4 };

/**
 * One pool per level band (spec 04). A widened band — e.g. a cluster forming after its
 * members' single-swing pools already exist — can bridge two pools; merge until stable.
 * Lifecycle winner = the more advanced status; identity keeps the earliest formed pool.
 */
function consolidate(pools: Pool[], equalToleranceAtr: number): void {
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < pools.length; i += 1) {
      for (let j = i + 1; j < pools.length; j += 1) {
        const a = pools[i];
        const b = pools[j];
        if (a.side !== b.side || a.status === "expired" || b.status === "expired") continue;
        const ba = band(a);
        const bb = band(b);
        const tol = equalToleranceAtr * Math.max(a.atr, b.atr);
        if (bb.hi >= ba.lo - tol && bb.lo <= ba.hi + tol) {
          for (const s of b.sources) if (!a.sources.includes(s)) a.sources.push(s);
          for (const m of b.memberIds) if (!a.memberIds.includes(m)) a.memberIds.push(m);
          a.touches = Math.max(a.touches, a.memberIds.length, b.touches);
          const lo = Math.min(ba.lo, bb.lo);
          const hi = Math.max(ba.hi, bb.hi);
          if (hi > lo) {
            a.lowerPrice = lo;
            a.upperPrice = hi;
            a.price = (lo + hi) / 2;
          }
          a.lastTouchBar = Math.max(a.lastTouchBar, b.lastTouchBar);
          a.lastTouchedAt = a.lastTouchBar === b.lastTouchBar ? b.lastTouchedAt : a.lastTouchedAt;
          if (STATUS_RANK[b.status] > STATUS_RANK[a.status]) {
            a.status = b.status;
            a.sweptAt = b.sweptAt ?? a.sweptAt;
          }
          pools.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
}

interface FormCandidate {
  side: LiquiditySide;
  source: LiquidityPoolType;
  price: number;
  lo: number;
  hi: number;
  touches: number;
  memberIds: string[];
  atr: number;
}

/** Merge a candidate into an overlapping pool or create a new one — one pool per level band. */
function addOrMerge(
  pools: Pool[],
  cand: FormCandidate,
  mergeTol: number,
  symbol: string,
  timeframe: Timeframe,
  atBar: number,
  at: number,
  events: DetectionEvent[],
): Pool {
  const target = pools.find(
    (p) => p.side === cand.side && p.status !== "expired" && overlaps(p, cand, mergeTol),
  );
  if (target) {
    for (const s of cand.memberIds) if (!target.memberIds.includes(s)) target.memberIds.push(s);
    target.touches = Math.max(target.touches, target.memberIds.length, target.touches + 1);
    if (!target.sources.includes(cand.source)) target.sources.push(cand.source);
    target.lastTouchedAt = toISO(at);
    target.lastTouchBar = atBar;
    if (cand.source.startsWith("cluster") || cand.source.startsWith("range")) {
      target.lowerPrice = Math.min(target.lowerPrice ?? target.price, cand.lo);
      target.upperPrice = Math.max(target.upperPrice ?? target.price, cand.hi);
      target.price = (target.lowerPrice + target.upperPrice) / 2;
    }
    return target;
  }
  const pool: Pool = {
    id: poolId(symbol, timeframe, cand.side, cand.price, at),
    symbol,
    timeframe,
    side: cand.side,
    sources: [cand.source],
    price: cand.price,
    lowerPrice: cand.lo === cand.hi ? undefined : cand.lo,
    upperPrice: cand.lo === cand.hi ? undefined : cand.hi,
    touches: cand.touches,
    strength: 0, // computed at snapshot time (recency is time-dependent)
    status: "resting",
    formedAt: toISO(at),
    lastTouchedAt: toISO(at),
    atr: cand.atr,
    memberIds: [...cand.memberIds],
    lastTouchBar: atBar,
  };
  pools.push(pool);
  events.push({
    kind: "pool_formed",
    refId: pool.id,
    symbol,
    atBar,
    at: pool.formedAt,
    metadata: { side: cand.side, source: cand.source, price: cand.price },
  });
  return pool;
}

// ---------------------------------------------------------------------------

export interface LiquidityResult {
  pools: LiquidityPool[];
  events: DetectionEvent[];
  diagnostics: Record<string, number | string | boolean>;
}

export function analyzeLiquidity(
  candles: readonly Candle[],
  structure: MarketStructure,
  symbol: string,
  timeframe: Timeframe,
  cfg: LiquidityConfig,
  paramsVersion: string,
  upToIndex?: number,
): LiquidityResult {
  const end = upToIndex === undefined ? candles.length - 1 : Math.min(upToIndex, candles.length - 1);
  const events: DetectionEvent[] = [];
  const pools: Pool[] = [];
  const confirmedHighs: SwingPoint[] = [];
  const confirmedLows: SwingPoint[] = [];
  let abortedSweeps = 0;

  const usable = structure.swings
    .filter((s) => s.confirmedIndex !== undefined && s.status !== "developing" && s.status !== "superseded")
    .sort((a, b) => a.confirmedIndex! - b.confirmedIndex! || a.pivotIndex! - b.pivotIndex!);
  const confirmAt = new Map<number, SwingPoint[]>();
  for (const s of usable) {
    const c = s.confirmedIndex!;
    if (c <= end) confirmAt.set(c, [...(confirmAt.get(c) ?? []), s]);
  }

  /** Mean TR over [a,b] — causal ATR for session pools (no swing to borrow from). */
  const sessionAtr = (a: number, b: number): number => {
    let sum = 0;
    let n = 0;
    for (let i = Math.max(1, a); i <= b; i += 1) {
      const c = candles[i];
      const pc = candles[i - 1].close;
      sum += Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
      n += 1;
    }
    return n > 0 ? sum / n : 0;
  };

  const dayOf = (ms: number) => Math.floor(ms / 86_400_000);
  const weekOf = (ms: number) => {
    const d = new Date(ms);
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    return Math.floor((ms - dow * 86_400_000) / 604_800_000);
  };

  for (let t = 0; t <= end; t += 1) {
    const bar = candles[t];

    // 1. Session/week boundary pools — prior session's extreme becomes resting liquidity.
    if (t > 0) {
      if (dayOf(bar.time) !== dayOf(candles[t - 1].time)) {
        // find prior day's bar range
        let a = t - 1;
        while (a > 0 && dayOf(candles[a - 1].time) === dayOf(candles[t - 1].time)) a -= 1;
        const lo = Math.min(...candles.slice(a, t).map((c) => c.low));
        const hi = Math.max(...candles.slice(a, t).map((c) => c.high));
        const atr = sessionAtr(a, t - 1);
        const mt = cfg.equalToleranceAtr * atr;
        addOrMerge(pools, { side: "buy_side", source: "prev_day_high", price: hi, lo: hi, hi, touches: 1, memberIds: [`pdh:${candles[t - 1].time}`], atr }, mt, symbol, timeframe, t, bar.time, events);
        addOrMerge(pools, { side: "sell_side", source: "prev_day_low", price: lo, lo, hi: lo, touches: 1, memberIds: [`pdl:${candles[t - 1].time}`], atr }, mt, symbol, timeframe, t, bar.time, events);
      }
      if (weekOf(bar.time) !== weekOf(candles[t - 1].time)) {
        let a = t - 1;
        while (a > 0 && weekOf(candles[a - 1].time) === weekOf(candles[t - 1].time)) a -= 1;
        const lo = Math.min(...candles.slice(a, t).map((c) => c.low));
        const hi = Math.max(...candles.slice(a, t).map((c) => c.high));
        const atr = sessionAtr(a, t - 1);
        const mt = cfg.equalToleranceAtr * atr;
        addOrMerge(pools, { side: "buy_side", source: "prev_week_high", price: hi, lo: hi, hi, touches: 1, memberIds: [`pwh:${candles[t - 1].time}`], atr }, mt, symbol, timeframe, t, bar.time, events);
        addOrMerge(pools, { side: "sell_side", source: "prev_week_low", price: lo, lo, hi: lo, touches: 1, memberIds: [`pwl:${candles[t - 1].time}`], atr }, mt, symbol, timeframe, t, bar.time, events);
      }
    }

    // 2. Swing-confirmation pools — the confirmed set grows exactly when the Swing Engine
    //    makes each swing knowable.
    for (const s of confirmAt.get(t) ?? []) {
      const side: LiquiditySide = s.kind === "high" ? "buy_side" : "sell_side";
      const list = s.kind === "high" ? confirmedHighs : confirmedLows;
      const atr = atrOf(s);
      const tol = cfg.equalToleranceAtr * atr;

      // base single-level pool (weakest source — still a stop level)
      const baseSource: LiquidityPoolType = s.kind === "high" ? "swing_high" : "swing_low";
      const eqSource: LiquidityPoolType = s.kind === "high" ? "equal_highs" : "equal_lows";

      // equal partner search: other confirmed same-kind swings within tol → equal pool.
      const partners = list.filter((o) => Math.abs(o.price - s.price) <= Math.max(tol, cfg.equalToleranceAtr * atrOf(o)));
      const isEqual = equalCountOf(s) >= 2 || partners.length > 0;
      const eqTouches = 1 + partners.reduce((sum, o) => sum + equalCountOf(o), 0) + (equalCountOf(s) - 1);

      const merged = addOrMerge(
        pools,
        { side, source: isEqual ? eqSource : baseSource, price: s.price, lo: s.price, hi: s.price, touches: isEqual ? eqTouches : equalCountOf(s), memberIds: [s.id ?? `${s.pivotIndex}`, ...partners.map((o) => o.id ?? `${o.pivotIndex}`)], atr },
        cfg.equalToleranceAtr * Math.max(atr, 0),
        symbol, timeframe, t, bar.time, events,
      );
      // An equal pool also carries the plain swing source at the same level.
      if (isEqual && !merged.sources.includes(baseSource)) merged.sources.push(baseSource);
      if (isEqual && merged.sources.length === 1 && merged.sources[0] === baseSource) merged.sources.push(eqSource);

      // cluster: ≥clusterMinCount same-kind swings whose band ≤ clusterWidthAtr × ATR.
      const clusterSource: LiquidityPoolType = s.kind === "high" ? "cluster_high" : "cluster_low";
      const near = [...list, s].sort((a, b) => a.price - b.price);
      let best: SwingPoint[] | null = null;
      for (let i = 0; i + cfg.clusterMinCount <= near.length; i += 1) {
        const group = near.slice(i, i + cfg.clusterMinCount);
        const span = group[group.length - 1].price - group[0].price;
        const gAtr = group.reduce((x, o) => x + atrOf(o), 0) / group.length;
        if (span <= cfg.clusterWidthAtr * gAtr && group.includes(s)) {
          if (!best || span < Math.abs(best[best.length - 1].price - best[0].price)) best = group;
        }
      }
      // extend the tightest seed window to every adjacent member still inside the band
      if (best) {
        const gAtr = best.reduce((x, o) => x + atrOf(o), 0) / best.length;
        const width = cfg.clusterWidthAtr * gAtr;
        let loIdx = near.indexOf(best[0]);
        let hiIdx = near.indexOf(best[best.length - 1]);
        while (loIdx > 0 && near[hiIdx].price - near[loIdx - 1].price <= width) loIdx -= 1;
        while (hiIdx < near.length - 1 && near[hiIdx + 1].price - near[loIdx].price <= width) hiIdx += 1;
        const group = near.slice(loIdx, hiIdx + 1);
        const loP = group[0].price;
        const hiP = group[group.length - 1].price;
        addOrMerge(
          pools,
          { side, source: clusterSource, price: (loP + hiP) / 2, lo: loP, hi: hiP, touches: group.length, memberIds: group.map((o) => o.id ?? `${o.pivotIndex}`), atr: gAtr },
          cfg.equalToleranceAtr * gAtr,
          symbol, timeframe, t, bar.time, events,
        );
      }

      list.push(s);
    }

    // One pool per level band — consolidate after formation, before interactions.
    consolidate(pools, cfg.equalToleranceAtr);

    // 3. Interactions — approach, raid/sweep, break family, expiry.
    for (const p of pools) {
      // Terminal pools are done entirely; swept pools skip NEW interactions but must
      // still resolve a pending displacement window (3c).
      if (p.status === "expired" || p.status === "broken") continue;
      const closed = p.status === "swept";
      const L = p.price;
      const atr = p.atr;
      const down = p.side === "sell_side"; // sell-side pools sit BELOW lows

      // 3a. approach status — transient, recomputed per bar.
      const within = down
        ? bar.low > L && bar.low <= L + APPROACH_ATR * atr
        : bar.high < L && bar.high >= L - APPROACH_ATR * atr;
      if (!closed && within) {
        if (p.status === "resting") p.status = "approaching";
      } else if (!closed && p.status === "approaching") {
        p.status = "resting";
      }

      // 3b. raid/sweep — wick counts for penetration, close counts for reclaim.
      const penDepth = cfg.sweep.minPenetrationAtr * atr;
      const penetrated = down ? bar.low < L - penDepth : bar.high > L + penDepth;
      if (!closed && penetrated && !p.raid && !p.sweep) {
        p.raid = { penetrationBar: t, extreme: down ? bar.low : bar.high };
        p.lastTouchBar = t;
        p.lastTouchedAt = toISO(bar.time);
      } else if (p.raid) {
        // track the deepest penetration while the raid is open (§13 extreme price)
        p.raid.extreme = down ? Math.min(p.raid.extreme, bar.low) : Math.max(p.raid.extreme, bar.high);
      }

      if (!closed && p.raid) {
        const reclaimed = down ? bar.close > L : bar.close < L;
        if (reclaimed) {
          // sweep wins over a pending break from the same raid (spec: sweep classification wins)
          if (t - p.raid.penetrationBar <= cfg.sweep.maxReclaimBars) {
            const extreme = down ? Math.min(p.raid.extreme, bar.low) : Math.max(p.raid.extreme, bar.high);
            p.sweep = { reclaimBar: t, extreme, penetrationBar: p.raid.penetrationBar };
            p.pendingBreak = undefined;
            p.status = "swept";
            p.sweptAt = toISO(bar.time);
            events.push({
              kind: "sweep_developing",
              refId: p.id,
              symbol,
              atBar: t,
              at: p.sweptAt,
              metadata: {
                eventId: `${p.id}:sweep:${bar.time}`,
                side: p.side,
                level: L,
                penetrationBar: p.raid.penetrationBar,
                extreme,
              },
            });
          }
          p.raid = undefined; // reclaim resolves the raid either way — late reclaim isn't a sweep
        } else if (t - p.raid.penetrationBar > cfg.sweep.maxReclaimBars) {
          p.raid = undefined; // raid aged out — no sweep (pending break may still resolve)
        }
      }

      // 3c. sweep displacement resolution — strictly AFTER the reclaim bar (spec 04).
      if (p.sweep) {
        const within = t - p.sweep.reclaimBar >= 1 && t - p.sweep.reclaimBar <= cfg.sweep.displacementBars;
        const body = Math.abs(bar.close - bar.open);
        const range = bar.high - bar.low;
        const initiative = down ? bar.close > (bar.high + bar.low) / 2 : bar.close < (bar.high + bar.low) / 2;
        const displaced =
          body >= cfg.sweep.displacementBodyAtr * atr &&
          range >= cfg.sweep.displacementRangeAtr * atr &&
          initiative;
        if (within && displaced) {
          events.push({
            kind: "sweep_confirmed",
            refId: p.id,
            symbol,
            atBar: t,
            at: toISO(bar.time),
            metadata: {
              eventId: `${p.id}:sweep-confirmed:${bar.time}`,
              side: p.side,
              level: L,
              extreme: p.sweep.extreme,
              penetrationBar: p.sweep.penetrationBar,
              reclaimBar: p.sweep.reclaimBar,
            },
          });
          p.sweep = undefined;
        } else if (t - p.sweep.reclaimBar > cfg.sweep.displacementBars) {
          // Aborted sweep — diagnostics only (spec 04); pool still counts as swept.
          abortedSweeps += 1;
          p.metadata = { ...(p.metadata ?? {}), sweepAborted: true };
          p.sweep = undefined;
        }
      }

      // 3d. break family — close-only, first qualifying close.
      const breakMargin = cfg.break.minCloseAtr * atr;
      const beyond = down ? bar.close < L - breakMargin : bar.close > L + breakMargin;
      if (!p.pendingBreak && beyond && p.status !== "swept") {
        p.pendingBreak = { breakBar: t, direction: down ? "beyond_low" : "beyond_high" };
        p.lastTouchBar = t;
        p.lastTouchedAt = toISO(bar.time);
        events.push({
          kind: "break_attempt",
          refId: p.id,
          symbol,
          atBar: t,
          at: toISO(bar.time),
          metadata: { side: p.side, level: L },
        });
      }
      if (p.pendingBreak) {
        const pb = p.pendingBreak;
        const breakoutSide = pb.direction === "beyond_low" ? bar.close < L : bar.close > L;
        const backInside = !breakoutSide;
        if (backInside) {
          // A reclaim inside maxReclaimBars already resolved as a sweep above — reaching
          // here means the re-entry was too late for a sweep → false breakout.
          events.push({
            kind: "false_breakout",
            refId: p.id,
            symbol,
            atBar: t,
            at: toISO(bar.time),
            metadata: { side: p.side, level: L },
          });
          p.status = "swept";
          p.metadata = { ...(p.metadata ?? {}), falseBroken: true };
          p.pendingBreak = undefined;
        } else if (t - pb.breakBar >= cfg.break.holdBars) {
          events.push({
            kind: "breakout_success",
            refId: p.id,
            symbol,
            atBar: t,
            at: toISO(bar.time),
            metadata: { side: p.side, level: L, mode: "held" },
          });
          p.status = "broken";
          p.pendingBreak = undefined;
        } else {
          // intervening retest that holds → early success (spec 04)
          const retest =
            t - pb.breakBar <= cfg.break.retestWindow &&
            (pb.direction === "beyond_low"
              ? bar.high >= L - APPROACH_ATR * atr && bar.high <= L + APPROACH_ATR * atr
              : bar.low <= L + APPROACH_ATR * atr && bar.low >= L - APPROACH_ATR * atr);
          if (retest && breakoutSide) {
            events.push({
              kind: "breakout_success",
              refId: p.id,
              symbol,
              atBar: t,
              at: toISO(bar.time),
              metadata: { side: p.side, level: L, mode: "retest_hold" },
            });
            p.status = "broken";
            p.pendingBreak = undefined;
          }
        }
      }

      // 3e. expiry — poolExpiryBars without a touch.
      if (p.status === "resting" || p.status === "approaching") {
        if (t - p.lastTouchBar > cfg.poolExpiryBars) {
          p.status = "expired";
          p.expiredAt = toISO(bar.time);
        }
      }
    }
  }

  // Strength at snapshot: touches 40% · sources 25% · recency 20% · tightness 15%.
  for (const p of pools) {
    const b = band(p);
    const bandW = p.atr > 0 ? (b.hi - b.lo) / p.atr : 0;
    const touches = (Math.min(p.touches, 5) / 5) * 40;
    const sources = (Math.min(p.sources.length, 3) / 3) * 25;
    const recency = Math.max(0, 1 - Math.max(0, end - p.lastTouchBar) / cfg.poolExpiryBars) * 20;
    const tight = (1 - Math.min(bandW, 1)) * 15;
    p.strength = Math.round(touches + sources + recency + tight);
    // Pool composition survives the sweep — later engines read member swings (§9/§17).
    p.metadata = { ...(p.metadata ?? {}), memberSwingIds: p.memberIds.join(","), freshnessBars: end - p.lastTouchBar };
    delete (p as Partial<Pool>).raid;
    delete (p as Partial<Pool>).sweep;
    delete (p as Partial<Pool>).pendingBreak;
    delete (p as Partial<Pool>).atr;
    delete (p as Partial<Pool>).memberIds;
    delete (p as Partial<Pool>).lastTouchBar;
  }

  return {
    pools: pools.map((p) => ({ ...p })),
    events,
    diagnostics: {
      pools: pools.length,
      buySide: pools.filter((p) => p.side === "buy_side").length,
      sellSide: pools.filter((p) => p.side === "sell_side").length,
      swept: pools.filter((p) => p.status === "swept").length,
      broken: pools.filter((p) => p.status === "broken").length,
      expired: pools.filter((p) => p.status === "expired").length,
      mergedSources: pools.filter((p) => p.sources.length > 1).length,
      abortedSweeps,
    },
  };
}

export function liquidityStateAt(
  candles: readonly Candle[],
  structure: MarketStructure,
  symbol: string,
  timeframe: Timeframe,
  cfg: LiquidityConfig,
  paramsVersion: string,
  atIndex: number,
): LiquidityPool[] {
  return analyzeLiquidity(candles, structure, symbol, timeframe, cfg, paramsVersion, atIndex).pools;
}

// ---------------------------------------------------------------------------

export function createLiquidityEngine(): LiquidityEngine {
  return {
    analyze(input) {
      const { series, structure, config } = input;
      const errors: EngineError[] = [];
      const paramsVersion = series.params?.version ?? "unversioned";
      const metaBase = {
        stage: "liquidity",
        paramsVersion,
        barsConsumed: { from: 0, to: series.candles.length - 1 },
      };

      if (config.clusterMinCount < 2 || config.sweep.maxReclaimBars < 1 || config.poolExpiryBars < 1) {
        errors.push({ code: "invalid_config", message: "clusterMinCount ≥ 2, maxReclaimBars ≥ 1, poolExpiryBars ≥ 1" });
        return { ok: false, errors, meta: { ...metaBase, events: [] } };
      }

      const { pools, events, diagnostics } = analyzeLiquidity(
        series.candles,
        structure,
        series.symbol,
        series.timeframe,
        config,
        paramsVersion,
      );

      return { ok: true, data: { pools, events }, errors, meta: { ...metaBase, events, diagnostics } };
    },
  };
}
