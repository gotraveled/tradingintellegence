import type {
  Candle,
  DetectionEvent,
  Direction,
  LiquidityPool,
  MarketStructure,
  Timeframe,
  Zone,
  ZoneConfig,
  ZonePattern,
  ZoneType,
} from "@/lib/types";
import type { EngineError, ZoneEngine } from "@/lib/services/engine";

/**
 * Demand/Supply Zone Engine (docs/engine/05-07).
 *
 * A zone is a compressed base (small-range, small-bodied contiguous bars) that precedes an
 * impulsive departure — DBR/RBR create demand, RBD/DBD create supply. The engine consumes
 * confirmed swings and breaks from MarketStructure and pool timing from LiquidityPools —
 * it never recomputes swings, structure, or pools.
 *
 * Look-ahead: a zone becomes an output only at its departure-confirmation bar `d`; every
 * attribute (boundaries, structureImpact, liquidityContext, fvgId, strength) is computed
 * from data knowable at `d`. Retests/invalidation evaluate per bar close strictly after `d`.
 * `analyzeZones(..., upToIndex)` is a point-in-time snapshot.
 *
 * ATR convention (documented in spec notes): all zone margins use the frozen formation ATR —
 * the mean true range of the `leg.lookbackBars` bars preceding the base. No `atrLength`
 * exists in ZoneConfig; the leg window is the market context the base is measured against.
 */

const toISO = (ms: number): string => new Date(ms).toISOString();

export function zoneId(
  symbol: string,
  timeframe: Timeframe,
  type: ZoneType,
  originMs: number,
  createdMs: number,
): string {
  return `zone:${symbol}:${timeframe}:${type}:${originMs}:${createdMs}`;
}

/** Per-side effective parameters — sideOverrides keys are dotted "group.field" paths (06). */
interface Eff {
  legLookback: number;
  legMinAtr: number;
  baseMin: number;
  baseMax: number;
  baseRangeAtr: number;
  baseBodyAtr: number;
  depMinAtr: number;
  depMaxBars: number;
  dispBodyAtr: number;
  dispRangeAtr: number;
  depthPct: number;
  invalidateAtr: number;
  maxRetests: number;
  retestDecay: number;
  depthDecay: number;
  freshMax: number;
  bodies: boolean;
  gapInvalidates: boolean;
}

function effective(cfg: ZoneConfig, type: ZoneType): Eff {
  const ov = cfg.sideOverrides?.[type] ?? {};
  const g = (key: string, fallback: number): number => ov[key] ?? fallback;
  return {
    legLookback: g("leg.lookbackBars", cfg.leg.lookbackBars),
    legMinAtr: g("leg.minMoveAtr", cfg.leg.minMoveAtr),
    baseMin: g("base.minBars", cfg.base.minBars),
    baseMax: g("base.maxBars", cfg.base.maxBars),
    baseRangeAtr: g("base.maxRangeAtr", cfg.base.maxRangeAtr),
    baseBodyAtr: g("base.maxBodyAtr", cfg.base.maxBodyAtr),
    depMinAtr: g("departure.minMoveAtr", cfg.departure.minMoveAtr),
    depMaxBars: g("departure.maxBars", cfg.departure.maxBars),
    dispBodyAtr: g("departure.displacementBodyAtr", cfg.departure.displacementBodyAtr),
    dispRangeAtr: g("departure.displacementRangeAtr", cfg.departure.displacementRangeAtr),
    depthPct: g("retest.depthMitigatedPct", cfg.retest.depthMitigatedPct),
    invalidateAtr: g("retest.invalidateCloseAtr", cfg.retest.invalidateCloseAtr),
    maxRetests: g("retest.maxRetests", cfg.retest.maxRetests),
    retestDecay: g("retest.retestDecay", cfg.retest.retestDecay),
    depthDecay: g("retest.depthDecay", cfg.retest.depthDecay),
    freshMax: g("freshnessMaxBars", cfg.freshnessMaxBars),
    bodies: cfg.boundaryMode === "bodies",
    gapInvalidates: cfg.gapInvalidates,
  };
}

interface ZoneInternal extends Zone {
  /** Frozen formation ATR (mean TR of the leg-in window). */
  atr: number;
  baseStart: number;
  baseEnd: number;
  createdBar: number;
  /** Creation or latest in-zone bar — expiry reference. */
  lastEntryBar: number;
  inRetest: boolean;
  height: number;
}

export interface ZoneResult {
  zones: Zone[];
  events: DetectionEvent[];
  diagnostics: Record<string, number | string | boolean>;
}

// ---------------------------------------------------------------------------

export function analyzeZones(
  candles: readonly Candle[],
  structure: MarketStructure,
  pools: readonly LiquidityPool[],
  symbol: string,
  timeframe: Timeframe,
  cfg: ZoneConfig,
  paramsVersion: string,
  upToIndex?: number,
): ZoneResult {
  const n = candles.length;
  const end = upToIndex === undefined ? n - 1 : Math.min(upToIndex, n - 1);
  const zones: ZoneInternal[] = [];
  const events: DetectionEvent[] = [];
  let forming = 0;
  const rejected = { base: 0, leg: 0, departure: 0, displacement: 0 };

  if (end < 0) {
    return {
      zones,
      events,
      diagnostics: { zones: 0, demand: 0, supply: 0, forming: 0 },
    };
  }

  /** Mean TR over [a,b] — causal, uses closes ≤ b. */
  const meanTr = (a: number, b: number): number => {
    let sum = 0;
    let cnt = 0;
    for (let i = Math.max(1, a); i <= b; i += 1) {
      const c = candles[i];
      const pc = candles[i - 1].close;
      sum += Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
      cnt += 1;
    }
    return cnt > 0 ? sum / cnt : 0;
  };

  const usableSwings = structure.swings.filter(
    (s) => s.confirmedIndex !== undefined && s.status !== "developing" && s.status !== "superseded",
  );
  const protectedPrices = new Set((structure.keyLevels ?? []).map((k) => k.price));

  // -------------------------------------------------------------------------
  // Pass A — zone discovery. Left-to-right base scan; a qualifying base evaluates a
  // departure window; the zone materialises only at its confirmation bar d ≤ end.
  // -------------------------------------------------------------------------

  const tryZone = (type: ZoneType, i: number, j: number, atr: number, eff: Eff, legMove: number): void => {
    const demand = type === "demand";
    const pattern: ZonePattern = demand ? (legMove < 0 ? "DBR" : "RBR") : legMove > 0 ? "RBD" : "DBD";
    const continuation = demand ? pattern === "RBR" : pattern === "DBD";

    const baseBars = candles.slice(i, j + 1);
    const baseTop = Math.max(...baseBars.map((c) => c.high));
    const baseBottom = Math.min(...baseBars.map((c) => c.low));

    // Departure: first close ≥/≤ the base edge ± depMinAtr, within depMaxBars.
    let d = -1;
    for (let k = j + 1; k <= Math.min(j + eff.depMaxBars, end); k += 1) {
      if (demand ? candles[k].close >= baseTop + eff.depMinAtr * atr : candles[k].close <= baseBottom - eff.depMinAtr * atr) {
        d = k;
        break;
      }
    }
    if (d === -1) {
      // A base whose departure window is truncated by the horizon is still "forming";
      // one with a full window and no qualifying close is rejected.
      if (j + eff.depMaxBars > end) forming += 1;
      else rejected.departure += 1;
      return;
    }

    // Displacement: ≥1 departure candle — body + range + directional close (close > open).
    const displaced = candles
      .slice(j + 1, d + 1)
      .some((c) =>
        Math.abs(c.close - c.open) >= eff.dispBodyAtr * atr &&
        c.high - c.low >= eff.dispRangeAtr * atr &&
        (demand ? c.close > c.open : c.close < c.open));
    if (!displaced) {
      rejected.displacement += 1;
      return;
    }

    const depMove = demand ? candles[d].close - baseTop : baseBottom - candles[d].close;
    // Continuation patterns must out-travel the leg in (05/06).
    if (continuation && depMove <= Math.abs(legMove)) {
      rejected.departure += 1;
      return;
    }

    // Boundaries — same band both sides; which edge is distal differs by type (05/06).
    const upper = eff.bodies ? Math.max(...baseBars.map((c) => Math.max(c.open, c.close))) : baseTop;
    const lower = eff.bodies ? Math.min(...baseBars.map((c) => Math.min(c.open, c.close))) : baseBottom;
    const height = upper - lower;
    if (height <= 0) return;

    // structureImpact — strong: matching-direction BOS/CHOCH inside [j+1, d];
    // minor: departure crossed a confirmed unprotected swing with no break event.
    const dir: Direction = demand ? "bullish" : "bearish";
    const hasBreak = (structure.breaks ?? []).some(
      (b) => b.breakIndex !== undefined && b.breakIndex >= j + 1 && b.breakIndex <= d && b.direction === dir,
    );
    const crossedSwing = usableSwings.some((s) => {
      if (s.confirmedIndex! > d) return false;
      if (protectedPrices.has(s.price)) return false;
      const P = s.price;
      if (demand) return s.kind === "high" && P > baseTop && P < candles[d].close;
      return s.kind === "low" && P < baseBottom && P > candles[d].close;
    });
    const structureImpact = hasBreak ? "strong" : crossedSwing ? "minor" : "none";

    // liquidityContext — formed_on_sweep: a confirmed opposite-side sweep at/just before
    // the base (sweepConfirmedBar within [i − depMaxBars, j]); departure_through_pool:
    // the departure close clears a pool that was still resting at bar d.
    const oppSide = demand ? "sell_side" : "buy_side";
    const thruSide = demand ? "buy_side" : "sell_side";
    const dTime = candles[d].time;
    const formedOnSweep = pools.some((p) => {
      if (p.side !== oppSide) return false;
      const sc = p.metadata?.sweepConfirmedBar;
      return typeof sc === "number" && sc >= i - eff.depMaxBars && sc <= j;
    });
    const restingAt = (p: LiquidityPool): boolean => {
      if (new Date(p.formedAt).getTime() > dTime) return false;
      const after = (iso?: string | number | boolean | null) =>
        typeof iso === "string" && new Date(iso).getTime() > dTime;
      const sweptOk = p.sweptAt === undefined || after(p.sweptAt);
      const expOk = p.expiredAt === undefined || after(p.expiredAt);
      const brkOk = p.metadata?.brokenAt === undefined || after(p.metadata?.brokenAt);
      return sweptOk && expOk && brkOk;
    };
    const throughPool = pools.some((p) => {
      if (p.side !== thruSide || !restingAt(p)) return false;
      const edge = demand ? (p.upperPrice ?? p.price) : (p.lowerPrice ?? p.price);
      return demand ? candles[d].close > edge : candles[d].close < edge;
    });
    const liquidityContext = formedOnSweep ? "formed_on_sweep" : throughPool ? "departure_through_pool" : "none";

    // FVG on the departure leg — spec-05 literal predicate (no FVGConfig here; the full
    // engine is a later phase). Leftmost 3-bar gap inside [j+1, d] with a directional middle.
    let fvgId: string | undefined;
    for (let k = j + 1; k + 2 <= d; k += 1) {
      const a = candles[k];
      const m = candles[k + 1];
      const b = candles[k + 2];
      const bull = b.low > a.high && m.close > m.open;
      const bear = b.high < a.low && m.close < m.open;
      if ((demand && bull) || (!demand && bear)) {
        fvgId = `fvg:${symbol}:${timeframe}:${demand ? "bullish" : "bearish"}:${a.time}`;
        break;
      }
    }

    // Strength — spec 05 weighted features; unavailable features redistribute pro-rata.
    const w = cfg.weights;
    const baseVol = baseBars.reduce((s2, c) => s2 + (c.volume ?? 0), 0) / baseBars.length;
    const depVol = candles.slice(j + 1, d + 1).reduce((s2, c) => s2 + (c.volume ?? 0), 0) / (d - j);
    const hasVolume = candles.slice(i, d + 1).every((c) => typeof c.volume === "number") && baseVol > 0;
    const widthAtr = height / atr;
    const feats: { w: number; f: number }[] = [
      { w: w.departureStrength, f: Math.min(1, depMove / atr / 4) },
      { w: w.structureBreak, f: structureImpact === "strong" ? 1 : structureImpact === "minor" ? 0.5 : 0 },
      { w: w.liquidityInteraction, f: liquidityContext === "formed_on_sweep" ? 1 : liquidityContext === "departure_through_pool" ? 0.5 : 0 },
      { w: w.freshness, f: 1 }, // fresh at creation
      { w: w.fvgAssociation, f: fvgId !== undefined ? 1 : 0 },
      // htfConfluence: no HTF input in the contract — redistributed (documented).
      { w: w.zoneWidth, f: 1 - Math.min(1, widthAtr / 1.5) },
    ];
    if (hasVolume) feats.push({ w: w.volumeExpansion, f: Math.min(1, depVol / (2 * baseVol)) });
    const wSum = feats.reduce((s2, f) => s2 + f.w, 0);
    const strength = wSum > 0 ? Math.round((100 * feats.reduce((s2, f) => s2 + f.w * f.f, 0)) / wSum) : 0;

    const id = zoneId(symbol, timeframe, type, candles[i].time, candles[d].time);
    zones.push({
      id,
      symbol,
      timeframe,
      type,
      pattern,
      upperPrice: upper,
      lowerPrice: lower,
      strength,
      freshness: "fresh",
      retestCount: 0,
      penetrationDepthPct: 0,
      remainingStrength: strength,
      status: "active",
      structureImpact,
      liquidityContext,
      fvgId,
      originAt: toISO(candles[i].time),
      createdAt: toISO(candles[d].time),
      metadata: {
        baseStart: i,
        baseEnd: j,
        createdBar: d,
        atr,
        widthAtr,
        departureAtr: depMove / atr,
        legAtr: legMove / atr,
      },
      atr,
      baseStart: i,
      baseEnd: j,
      createdBar: d,
      lastEntryBar: d,
      inRetest: false,
      height,
    });
    events.push({
      kind: "zone_created",
      refId: id,
      symbol,
      atBar: d,
      at: toISO(candles[d].time),
      metadata: { eventId: `${id}:created:${candles[d].time}`, type, pattern, structureImpact, liquidityContext },
    });
  };

  const effByType = { demand: effective(cfg, "demand"), supply: effective(cfg, "supply") };
  let i = Math.min(cfg.leg.lookbackBars, cfg.sideOverrides?.demand?.["leg.lookbackBars"] ?? cfg.leg.lookbackBars);
  i = Math.max(1, i);
  while (i <= end - 1) {
    // Per-side evaluation shares the same base predicates; evaluate both sides.
    for (const type of ["demand", "supply"] as const) {
      const e = effByType[type];
      if (i < e.legLookback) continue;
      const atr = meanTr(i - e.legLookback, i - 1);
      if (atr <= 0) continue;
      const legMove = candles[i - 1].close - candles[i - e.legLookback].close;
      const legOk = Math.abs(legMove) >= e.legMinAtr * atr;
      if (!legOk) {
        rejected.leg += 1;
        continue;
      }
      // Base: longest qualifying contiguous run ≤ baseMax starting at i.
      let j = -1;
      let mHi = -Infinity;
      let mLo = Infinity;
      let bodySum = 0;
      for (let k = i; k < i + e.baseMax && k <= end; k += 1) {
        const c = candles[k];
        // A wide bar can never sit INSIDE a base — stop extending; any base already
        // found is unaffected (departure legs are supposed to be wide).
        if (c.high - c.low >= e.dispRangeAtr * atr) break;
        mHi = Math.max(mHi, c.high);
        mLo = Math.min(mLo, c.low);
        bodySum += Math.abs(c.close - c.open);
        const len = k - i + 1;
        if (mHi - mLo > e.baseRangeAtr * atr) break; // range fails — terminal (monotone)
        if (bodySum / len > e.baseBodyAtr * atr) continue; // body fails — may recover with more bars
        if (len >= e.baseMin) j = k; // longest qualifying run so far
      }
      if (j === -1) {
        rejected.base += 1;
        continue;
      }
      // A compressed region longer than baseMax is consolidation, not a base.
      if (j === i + e.baseMax - 1 && j + 1 <= end) {
        const c = candles[j + 1];
        // Recompute the window aggregates — mHi/mLo only cover bars the loop touched.
        const ext = candles.slice(i, j + 2);
        const mHi2 = Math.max(...ext.map((x) => x.high));
        const mLo2 = Math.min(...ext.map((x) => x.low));
        const mBody = ext.reduce((s2, x) => s2 + Math.abs(x.close - x.open), 0) / ext.length;
        if (
          c.high - c.low < e.dispRangeAtr * atr &&
          mHi2 - mLo2 <= e.baseRangeAtr * atr &&
          mBody <= e.baseBodyAtr * atr
        ) {
          rejected.base += 1;
          continue;
        }
      }
      tryZone(type, i, j, atr, e, legMove);
    }
    // Advance past the longest base found at i for either side — one candidate per region.
    // (A failed base advances by 1 so a shorter tail base can still start later.)
    i += 1;
  }

  // -------------------------------------------------------------------------
  // Pass B — lifecycle. Per-bar close evaluation strictly after createdBar.
  // Demand: proximal = upperPrice, distal = lowerPrice. Supply mirrors.
  // -------------------------------------------------------------------------

  for (let t = 0; t <= end; t += 1) {
    const bar = candles[t];
    for (const z of zones) {
      if (z.status !== "active" || t <= z.createdBar) continue;
      const e = effective(cfg, z.type);
      const demand = z.type === "demand";
      const proximal = demand ? z.upperPrice : z.lowerPrice;
      const distal = demand ? z.lowerPrice : z.upperPrice;

      // Gap-through invalidation (06): open beyond the distal edge — no close needed.
      if (e.gapInvalidates && (demand ? bar.open < distal : bar.open > distal)) {
        z.status = "invalidated";
        z.metadata = { ...(z.metadata ?? {}), invalidatedAt: toISO(bar.time), invalidatedBar: t, via: "gap" };
        events.push({ kind: "zone_invalidated", refId: z.id, symbol, atBar: t, at: toISO(bar.time), metadata: { eventId: `${z.id}:invalidated:${bar.time}`, via: "gap" } });
        continue;
      }

      const inside = demand ? bar.low <= proximal : bar.high >= proximal;
      if (inside) {
        z.inRetest = true;
        z.lastEntryBar = t;
        // penetrationDepthPct — monotonic, % of zone height from the proximal edge.
        const pen = demand
          ? ((proximal - bar.low) / z.height) * 100
          : ((bar.high - proximal) / z.height) * 100;
        z.penetrationDepthPct = Math.max(z.penetrationDepthPct ?? 0, Math.max(0, pen));

        // Invalidation wins over consumption when a single bar does both (07 edge case).
        const closeThrough = demand
          ? bar.close < distal - e.invalidateAtr * z.atr
          : bar.close > distal + e.invalidateAtr * z.atr;
        if (closeThrough) {
          z.status = "invalidated";
          z.metadata = { ...(z.metadata ?? {}), invalidatedAt: toISO(bar.time), invalidatedBar: t, via: "close" };
          events.push({ kind: "zone_invalidated", refId: z.id, symbol, atBar: t, at: toISO(bar.time), metadata: { eventId: `${z.id}:invalidated:${bar.time}`, via: "close" } });
          continue;
        }
        // Consumed: depth ≥ depthMitigatedPct, or a close inside past the midline.
        const mid = demand ? proximal - 0.5 * z.height : proximal + 0.5 * z.height;
        const insidePastMid = demand ? bar.close <= mid && bar.close >= distal : bar.close >= mid && bar.close <= distal;
        if ((z.penetrationDepthPct ?? 0) >= e.depthPct || insidePastMid) {
          z.status = "mitigated";
          z.metadata = { ...(z.metadata ?? {}), consumedAt: toISO(bar.time), consumedBar: t };
          events.push({ kind: "zone_consumed", refId: z.id, symbol, atBar: t, at: toISO(bar.time), metadata: { eventId: `${z.id}:consumed:${bar.time}`, depthPct: z.penetrationDepthPct ?? 0 } });
          continue;
        }
      } else if (z.inRetest) {
        // Retest block exit — one contiguous in-zone stretch counts once (07).
        z.inRetest = false;
        z.retestCount += 1;
        z.lastRetestAt = toISO(bar.time);
        events.push({ kind: "zone_retested", refId: z.id, symbol, atBar: t, at: toISO(bar.time), metadata: { eventId: `${z.id}:retest:${bar.time}`, retestCount: z.retestCount, depthPct: z.penetrationDepthPct ?? 0 } });
        if (z.retestCount >= e.maxRetests) {
          z.status = "mitigated";
          z.metadata = { ...(z.metadata ?? {}), consumedAt: toISO(bar.time), consumedBar: t, via: "retest_count" };
          events.push({ kind: "zone_consumed", refId: z.id, symbol, atBar: t, at: toISO(bar.time), metadata: { eventId: `${z.id}:consumed:${bar.time}`, via: "retest_count" } });
          continue;
        }
      }

      // Expiry — freshnessMaxBars without re-entry (07).
      if (t - z.lastEntryBar > e.freshMax) {
        z.status = "expired";
        z.metadata = { ...(z.metadata ?? {}), expiredAt: toISO(bar.time), expiredBar: t };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Snapshot: derived freshness, remainingStrength (07 formula), strip internals.
  // -------------------------------------------------------------------------
  const out: Zone[] = zones.map((z) => {
    const e = effective(cfg, z.type);
    const remaining = Math.max(
      0,
      z.strength *
        Math.max(0, 1 - e.retestDecay * z.retestCount) *
        Math.max(0, 1 - (e.depthDecay * (z.penetrationDepthPct ?? 0)) / e.depthPct),
    );
    const copy: Zone = { ...z };
    copy.freshness = z.status === "mitigated" ? "mitigated" : z.retestCount > 0 ? "tested" : "fresh";
    copy.remainingStrength = Math.round(remaining);
    delete (copy as Partial<ZoneInternal>).atr;
    delete (copy as Partial<ZoneInternal>).baseStart;
    delete (copy as Partial<ZoneInternal>).baseEnd;
    delete (copy as Partial<ZoneInternal>).createdBar;
    delete (copy as Partial<ZoneInternal>).lastEntryBar;
    delete (copy as Partial<ZoneInternal>).inRetest;
    delete (copy as Partial<ZoneInternal>).height;
    return copy;
  });
  out.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1));

  return {
    zones: out,
    events,
    diagnostics: {
      zones: out.length,
      demand: out.filter((z) => z.type === "demand").length,
      supply: out.filter((z) => z.type === "supply").length,
      active: out.filter((z) => z.status === "active").length,
      mitigated: out.filter((z) => z.status === "mitigated").length,
      invalidated: out.filter((z) => z.status === "invalidated").length,
      expired: out.filter((z) => z.status === "expired").length,
      forming,
      rejectedBase: rejected.base,
      rejectedLeg: rejected.leg,
      rejectedDeparture: rejected.departure,
      rejectedDisplacement: rejected.displacement,
      volumeFeature: candles.some((c) => typeof c.volume === "number") ? "used" : "redistributed",
    },
  };
}

export function zoneStateAt(
  candles: readonly Candle[],
  structure: MarketStructure,
  pools: readonly LiquidityPool[],
  symbol: string,
  timeframe: Timeframe,
  cfg: ZoneConfig,
  paramsVersion: string,
  atIndex: number,
): Zone[] {
  return analyzeZones(candles, structure, pools, symbol, timeframe, cfg, paramsVersion, atIndex).zones;
}

// ---------------------------------------------------------------------------

export function createZoneEngine(): ZoneEngine {
  return {
    analyze(input) {
      const { series, structure, pools, config } = input;
      const errors: EngineError[] = [];
      const paramsVersion = series.params?.version ?? "unversioned";
      const metaBase = {
        stage: "zones",
        paramsVersion,
        barsConsumed: { from: 0, to: series.candles.length - 1 },
      };
      const fail = (message: string) => {
        errors.push({ code: "invalid_config", message });
        return { ok: false, errors, meta: { ...metaBase, events: [] } };
      };

      const w = config.weights;
      const wSum = Object.values(w).reduce((s, x) => s + x, 0);
      if (Object.values(w).some((x) => x < 0) || Math.abs(wSum - 1) > 1e-9) {
        return fail("zone.weights must be ≥ 0 and sum to 1.0");
      }
      if (config.base.minBars < 1 || config.base.maxBars < config.base.minBars) {
        return fail("zone.base requires 1 ≤ minBars ≤ maxBars");
      }
      if (config.leg.lookbackBars < 1 || config.leg.minMoveAtr < 0) {
        return fail("zone.leg requires lookbackBars ≥ 1, minMoveAtr ≥ 0");
      }
      if (config.departure.maxBars < 1 || config.departure.minMoveAtr < 0) {
        return fail("zone.departure requires maxBars ≥ 1, minMoveAtr ≥ 0");
      }
      if (config.retest.depthMitigatedPct <= 0 || config.retest.depthMitigatedPct > 100) {
        return fail("zone.retest.depthMitigatedPct must be in (0, 100]");
      }
      if (config.retest.retestDecay < 0 || config.retest.retestDecay > 1 || config.retest.depthDecay < 0 || config.retest.depthDecay > 1) {
        return fail("zone.retest decays must be in [0, 1]");
      }
      if (config.retest.maxRetests < 1 || config.freshnessMaxBars < 1) {
        return fail("zone.retest.maxRetests ≥ 1 and zone.freshnessMaxBars ≥ 1");
      }

      const { zones, events, diagnostics } = analyzeZones(
        series.candles,
        structure,
        pools,
        series.symbol,
        series.timeframe,
        config,
        paramsVersion,
      );

      return { ok: true, data: zones, errors, meta: { ...metaBase, events, diagnostics } };
    },
  };
}
