import type {
  Candle,
  DetectionEvent,
  StructureBreak,
  StructureConfig,
  SwingKind,
  SwingPoint,
  SwingType,
  Timeframe,
  TrendState,
  MarketStructure,
} from "@/lib/types";
import type { EngineError, MarketStructureEngine } from "@/lib/services/engine";

/**
 * Market Structure Engine (docs/engine/03-market-structure.md).
 * Consumes CONFIRMED swings from the Swing Engine — never recomputes them.
 *
 * Processing model (deterministic, look-ahead safe): bars are visited in order; at each bar
 * the engine (1) applies swing invalidations known at that bar, (2) ingests swings whose
 * confirmedIndex == t and classifies them, (3) evaluates BOS/CHOCH against the post-confirmation
 * state — spec 03: "swing confirmation takes priority". Breaks are close-only, wick-immune.
 */

const toISO = (ms: number): string => new Date(ms).toISOString();

/** Deterministic event id — stable attributes only (spec §18). */
export function structureBreakId(
  symbol: string,
  timeframe: Timeframe,
  type: "BOS" | "CHOCH",
  direction: "bullish" | "bearish",
  refSwingId: string,
  breakTime: number,
): string {
  return `sb:${symbol}:${timeframe}:${type}:${direction}:${refSwingId}:${breakTime}`;
}

const atrOf = (s: SwingPoint): number =>
  typeof s.metadata?.atrAtPivot === "number" ? s.metadata.atrAtPivot : 0;

// ---------------------------------------------------------------------------

interface WorkingState {
  confirmed: SwingPoint[]; // ingested, in confirmation order
  /** Latest non-invalidated confirmed swing per kind — the comparison reference. */
  prevByKind: Partial<Record<SwingKind, SwingPoint>>;
  /** Classification of the most recent confirmed swing of each kind. */
  lastHighClass?: SwingType;
  lastLowClass?: SwingType;
  /** Most recent confirmed HL / LH — the protected-level candidates. */
  lastHL?: SwingPoint;
  lastLH?: SwingPoint;
  trend: TrendState;
  breaks: StructureBreak[];
  /** Refs already broken — a level emits at most one BOS (first qualifying close only). */
  brokenHighId?: string;
  brokenLowId?: string;
  /** Open breaks still inside their failedBreakBars assessment window. */
  openBreaks: StructureBreak[];
}

function classify(
  swing: SwingPoint,
  prev: SwingPoint | undefined,
  cfg: StructureConfig,
): SwingType | undefined {
  if (!prev) return undefined; // first of kind — nothing to compare
  const tol = cfg.classifyToleranceAtr * atrOf(swing);
  const d = swing.price - prev.price;
  if (swing.kind === "high") {
    if (d > tol) return "HH";
    if (d < -tol) return "LH";
    return "EH";
  }
  if (d < -tol) return "LL";
  if (d > tol) return "HL";
  return "EL";
}

function trendOf(s: WorkingState, cfg: StructureConfig): TrendState {
  if (s.confirmed.length < cfg.minSwingsForTrend) return "transition";
  const h = s.lastHighClass;
  const l = s.lastLowClass;
  if (h === undefined || l === undefined) return "transition";
  if (h === "EH" || l === "EL") return "range"; // EH/EL dominant — documented interpretation
  if (h === "HH" && l === "HL") return "uptrend";
  if (h === "LH" && l === "LL") return "downtrend";
  return "transition"; // honest "between regimes" — never forced
}

export interface StructureResult {
  structure: MarketStructure;
  swings: SwingPoint[]; // confirmed/invalidated, classified
  breaks: StructureBreak[];
  events: DetectionEvent[];
  diagnostics: Record<string, number | string | boolean>;
}

/**
 * Analyze a candle series + its detected swings. `upToIndex` truncates processing — used by
 * `structureStateAt` for point-in-time snapshots (spec §14: no future information).
 */
export function analyzeStructure(
  candles: readonly Candle[],
  swings: readonly SwingPoint[],
  symbol: string,
  timeframe: Timeframe,
  cfg: StructureConfig,
  paramsVersion: string,
  upToIndex?: number,
): StructureResult {
  const end =
    upToIndex === undefined ? candles.length - 1 : Math.min(upToIndex, candles.length - 1);
  const events: DetectionEvent[] = [];
  const state: WorkingState = {
    confirmed: [],
    prevByKind: {},
    trend: "transition",
    breaks: [],
    openBreaks: [],
  };

  // Only confirmed swings participate; sort by when they became knowable.
  const usable = swings
    .filter(
      (s) =>
        (s.status === "confirmed" || s.status === "invalidated") && s.confirmedIndex !== undefined,
    )
    .sort((a, b) => a.confirmedIndex! - b.confirmedIndex! || a.pivotIndex! - b.pivotIndex!);
  const confirmAt = new Map<number, SwingPoint[]>();
  for (const s of usable) {
    const c = s.confirmedIndex!;
    if (c <= end) confirmAt.set(c, [...(confirmAt.get(c) ?? []), s]);
  }
  // Invalidations remove a swing from the comparison chain at the bar they are known.
  const invalidateAt = new Map<number, SwingPoint[]>();
  for (const s of usable) {
    const idx =
      typeof s.metadata?.invalidatedIndex === "number" ? s.metadata.invalidatedIndex : undefined;
    if (idx !== undefined && idx <= end)
      invalidateAt.set(idx, [...(invalidateAt.get(idx) ?? []), s]);
  }

  const emitBreak = (
    type: "BOS" | "CHOCH",
    direction: "bullish" | "bearish",
    ref: SwingPoint,
    bar: number,
    before: TrendState,
    after: TrendState,
  ) => {
    const brk: StructureBreak = {
      id: structureBreakId(
        symbol,
        timeframe,
        type,
        direction,
        ref.id ?? `${ref.pivotIndex}`,
        candles[bar].time,
      ),
      type,
      direction,
      price: ref.price,
      refSwingId: ref.id,
      refPrice: ref.price,
      breakIndex: bar,
      time: toISO(candles[bar].time),
      confirmed: true,
      structureBefore: before,
      structureAfter: after,
      // The break margin is derived deterministically from refPrice + atrOf(ref) when needed.
    };
    state.breaks.push(brk);
    state.openBreaks.push(brk);
    events.push({
      kind: "structure_break",
      refId: brk.id!,
      symbol,
      atBar: bar,
      at: brk.time,
      metadata: {
        breakType: type,
        direction,
        refSwingId: ref.id ?? null,
        refPrice: ref.price,
        structureBefore: before,
        structureAfter: after,
      },
    });
    return brk;
  };

  for (let t = 0; t <= end; t += 1) {
    // 1. Invalidations known at t — remove from the comparison chain (spec 03).
    for (const s of invalidateAt.get(t) ?? []) {
      const prev = state.prevByKind[s.kind];
      if (prev?.id === s.id) {
        // Fall back to the earlier member of the kind's chain, if any.
        const earlier = [...state.confirmed]
          .reverse()
          .find((o) => o.kind === s.kind && o.id !== s.id && o.status !== "invalidated");
        state.prevByKind[s.kind] = earlier;
      }
    }

    // 2. Swing confirmations at t — classify, update classes/protected candidates.
    for (const s of confirmAt.get(t) ?? []) {
      const prev = state.prevByKind[s.kind];
      s.classification = classify(s, prev, cfg);
      state.confirmed.push(s);
      state.prevByKind[s.kind] = s;
      if (s.kind === "high") state.lastHighClass = s.classification;
      else state.lastLowClass = s.classification;
      if (s.classification === "HL") state.lastHL = s;
      if (s.classification === "LH") state.lastLH = s;
      state.trend = trendOf(state, cfg);
    }

    // 3. Break tests at this bar's close — close-only, wick-immune, first close only.
    const close = candles[t].close;
    if (state.trend === "uptrend") {
      const ref = state.prevByKind.high;
      if (ref && ref.id !== state.brokenHighId) {
        const margin = cfg.minBreakAtr * atrOf(ref);
        if (close > ref.price + margin) {
          emitBreak("BOS", "bullish", ref, t, "uptrend", "uptrend");
          state.brokenHighId = ref.id;
        }
      }
      const prot = state.lastHL;
      if (prot) {
        const margin = cfg.minBreakAtr * atrOf(prot);
        if (close < prot.price - margin) {
          emitBreak("CHOCH", "bearish", prot, t, "uptrend", "transition");
          state.trend = "transition";
        }
      }
    } else if (state.trend === "downtrend") {
      const ref = state.prevByKind.low;
      if (ref && ref.id !== state.brokenLowId) {
        const margin = cfg.minBreakAtr * atrOf(ref);
        if (close < ref.price - margin) {
          emitBreak("BOS", "bearish", ref, t, "downtrend", "downtrend");
          state.brokenLowId = ref.id;
        }
      }
      const prot = state.lastLH;
      if (prot) {
        const margin = cfg.minBreakAtr * atrOf(prot);
        if (close > prot.price + margin) {
          emitBreak("CHOCH", "bullish", prot, t, "downtrend", "transition");
          state.trend = "transition";
        }
      }
    }

    // 4. Failed-break assessment — close back inside within failedBreakBars.
    state.openBreaks = state.openBreaks.filter((b) => {
      if (b.failed || b.breakIndex === undefined || t <= b.breakIndex) return true;
      if (t > b.breakIndex + cfg.failedBreakBars) return false; // window expired, stands
      const refSwing = state.confirmed.find((s) => s.id === b.refSwingId);
      const margin = cfg.minBreakAtr * atrOf(refSwing ?? ({} as SwingPoint));
      const backInside =
        b.direction === "bullish" ? close < b.refPrice! - margin : close > b.refPrice! + margin;
      if (!backInside) return true;
      b.failed = true;
      b.failedAt = toISO(candles[t].time);
      events.push({
        kind: "break_failed",
        refId: b.id!,
        symbol,
        atBar: t,
        at: b.failedAt,
        metadata: { breakType: b.type, direction: b.direction, refPrice: b.refPrice ?? null },
      });
      // Failed BOS → transition; failed CHOCH → restore the pre-CHOCH trend (spec 03).
      state.trend = b.type === "CHOCH" ? (b.structureBefore ?? "transition") : "transition";
      return false;
    });
  }

  const lastBar = Math.max(0, end);
  const protectedSwing =
    state.trend === "uptrend"
      ? state.lastHL
      : state.trend === "downtrend"
        ? state.lastLH
        : undefined;
  const keyLevels: { label: string; price: number }[] = [];
  if (protectedSwing) keyLevels.push({ label: "protected", price: protectedSwing.price });
  if (state.prevByKind.high)
    keyLevels.push({ label: "lastHigh", price: state.prevByKind.high.price });
  if (state.prevByKind.low) keyLevels.push({ label: "lastLow", price: state.prevByKind.low.price });

  // Only swings actually ingested by `end` appear — a point-in-time snapshot never leaks
  // swings that confirm later.
  const classified = [...state.confirmed];
  const structure: MarketStructure = {
    symbol,
    timeframe,
    trend: state.trend,
    bias:
      state.trend === "uptrend" ? "bullish" : state.trend === "downtrend" ? "bearish" : "neutral",
    swings: classified,
    lastBreak: state.breaks[state.breaks.length - 1],
    keyLevels,
    updatedAt: candles.length > 0 ? toISO(candles[lastBar].time) : new Date(0).toISOString(),
  };

  return {
    structure,
    swings: classified,
    breaks: state.breaks,
    events,
    diagnostics: {
      confirmedSwings: state.confirmed.length,
      classifiedSwings: classified.filter((s) => s.classification !== undefined).length,
      bosCount: state.breaks.filter((b) => b.type === "BOS").length,
      chochCount: state.breaks.filter((b) => b.type === "CHOCH").length,
      failedBreaks: state.breaks.filter((b) => b.failed === true).length,
    },
  };
}

/** Point-in-time snapshot — structure knowable at bar `t` (spec §14). */
export function structureStateAt(
  candles: readonly Candle[],
  swings: readonly SwingPoint[],
  symbol: string,
  timeframe: Timeframe,
  cfg: StructureConfig,
  paramsVersion: string,
  atIndex: number,
): MarketStructure {
  return analyzeStructure(candles, swings, symbol, timeframe, cfg, paramsVersion, atIndex)
    .structure;
}

// ---------------------------------------------------------------------------

export function createMarketStructureEngine(): MarketStructureEngine {
  return {
    analyze(input) {
      const { series, swings, config } = input;
      const errors: EngineError[] = [];
      const paramsVersion = series.params?.version ?? "unversioned";

      if (config.minSwingsForTrend < 1 || config.failedBreakBars < 0) {
        errors.push({
          code: "invalid_config",
          message: "minSwingsForTrend ≥ 1, failedBreakBars ≥ 0",
        });
        return {
          ok: false,
          errors,
          meta: {
            stage: "structure",
            paramsVersion,
            barsConsumed: { from: 0, to: series.candles.length - 1 },
            events: [],
          },
        };
      }

      const { structure, events, diagnostics } = analyzeStructure(
        series.candles,
        swings,
        series.symbol,
        series.timeframe,
        config,
        paramsVersion,
      );

      return {
        ok: true,
        data: structure,
        errors,
        meta: {
          stage: "structure",
          paramsVersion,
          barsConsumed: { from: 0, to: series.candles.length - 1 },
          events,
          diagnostics,
        },
      };
    },
  };
}
