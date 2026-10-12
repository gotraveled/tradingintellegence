import type {
  Candle,
  DetectionEvent,
  Imbalance,
  LiquidityPool,
  MarketStructure,
  Momentum,
  MtfAlignmentState,
  MtfVote,
  MultiTimeframeAlignment,
  Timeframe,
  Zone,
} from "@/lib/types";
import type { EngineError, MultiTimeframeEngine } from "@/lib/services/engine";
import { TIMEFRAME_MS } from "@/lib/market-data";

/**
 * Multi-Timeframe Alignment Engine (docs/engine/10-multi-timeframe.md).
 *
 * Combines per-timeframe pipeline outputs into a signed-vote alignment context. Three roles —
 * HTF (context), ITF (structure), ETF (confirmation) — never averaged into a mush: the 27
 * vote combinations map to named confluence/conflict states. Context, never a signal.
 *
 * Temporal join (spec Point-in-time): "HTF state at bar t is the HTF output as of the last
 * HTF bar whose close precedes t." `closedIndexAt`/`barCloseTime` implement that rule —
 * a bar is visible only once its close time ≤ asOf. `1M` uses UTC month boundaries via
 * `alignFloor` semantics (calendar, not milliseconds).
 */

/** Bar close time — fixed timeframes add TIMEFRAME_MS; "1M" closes at the next UTC month start. */
export function barCloseTime(candle: Candle, tf: Timeframe): number {
  const ms = tf === "1M" ? undefined : TIMEFRAME_MS[tf as Exclude<Timeframe, "1M">];
  if (ms !== undefined) return candle.time + ms;
  const d = new Date(candle.time);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * Last bar index whose CLOSE time ≤ `asOf` — the only bars a consumer may legally see.
 * Binary search over close times; candles must be sorted ascending. Returns -1 when none.
 */
export function closedIndexAt(candles: readonly Candle[], tf: Timeframe, asOf: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (barCloseTime(candles[mid], tf) <= asOf) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export type VoteSource = "structure" | "momentum" | "none";

/**
 * Signed vote per frame (spec: "+1: bias = bullish (structure trend or momentum bias — the
 * stage that defined it is recorded as source)"). Structure bias is primary; momentum bias
 * supplies the vote only when structure is neutral/insufficient — recorded either way.
 */
export function voteOf(structure: MarketStructure, momentum: Momentum): { vote: MtfVote; source: VoteSource } {
  if (structure.bias === "bullish") return { vote: 1, source: "structure" };
  if (structure.bias === "bearish") return { vote: -1, source: "structure" };
  if (momentum.bias === "bullish") return { vote: 1, source: "momentum" };
  if (momentum.bias === "bearish") return { vote: -1, source: "momentum" };
  return { vote: 0, source: "none" };
}

/**
 * Truth table (spec 10). Rows the spec names cover the 8 full-vote combos + htf_dominant
 * (HTF±, ITF 0) + ltf_directed (HTF 0, ITF±) + no_context + neutral. The four remaining
 * rows — ETF silent — follow spec rule 2 (ETF confirms, never sets direction): they resolve
 * to the HTF/ITF-only class (aligned_*, countertrend_*) — documented, not silently merged.
 */
export function classifyVotes(h: MtfVote, i: MtfVote, e: MtfVote): MtfAlignmentState {
  if (h === 0) {
    if (i !== 0) return "ltf_directed";
    if (e !== 0) return "no_context";
    return "neutral";
  }
  if (i === 0) return "htf_dominant";
  if (i === h) {
    // HTF/ITF agree — an opposing ETF is a pullback inside the trend; silent/same ETF keeps alignment.
    if (e === -h) return h > 0 ? "pullback_in_trend_bull" : "pullback_in_trend_bear";
    return h > 0 ? "aligned_bull" : "aligned_bear";
  }
  // HTF vs ITF conflict — ETF re-aligning with HTF → realigning_*; else countertrend_*.
  if (e === h) return h > 0 ? "realigning_bull" : "realigning_bear";
  return h > 0 ? "countertrend_bear" : "countertrend_bull";
}

interface Frame {
  timeframe: Timeframe;
  structure: MarketStructure;
  momentum: Momentum;
}

// ---------------------------------------------------------------------------
// Canonical causal temporal join.
//
// At execution timestamp T every timeframe may expose only information legally
// knowable at T: bars whose `barCloseTime ≤ T`. This module is the canonical
// path — callers supply a snapshot provider per role (`at(idx)` = the
// `*StateAt` functions of phases 4B–4F) and the join enforces the boundary
// internally, so the visibility rule cannot be miswired.
// ---------------------------------------------------------------------------

/** All per-timeframe pipeline outputs knowable at a closed bar — context for downstream consumers. */
export interface FrameSnapshot {
  structure?: MarketStructure;
  momentum?: Momentum;
  liquidity?: LiquidityPool[];
  zones?: Zone[];
  imbalances?: Imbalance[];
  /** Stage events knowable at the joined bar (e.g. `sweep_developing` — pools alone only retain confirmed sweeps). */
  events?: DetectionEvent[];
}

/** One role's candles + snapshot provider. `at` receives only indices ≤ the last closed bar. */
export interface FrameSource {
  timeframe: Timeframe;
  candles: readonly Candle[];
  /** Snapshot knowable at closed-bar `idx`; null when unavailable (insufficient data). */
  at(idx: number): FrameSnapshot | null;
}

export type FrameRole = "htf" | "itf" | "etf";

export interface JoinedFrame {
  timeframe: Timeframe;
  /** Index of the last bar whose close ≤ asOf — the causal boundary that produced this snapshot. */
  barIndex: number;
  snapshot: FrameSnapshot;
}

/**
 * Temporal join: for each role, the snapshot of the last bar closed by `asOf`.
 * `null` = no legally closed bar (insufficient history) — never fabricated.
 */
export function causalFramesAt(
  roles: Record<FrameRole, FrameSource>,
  asOf: number,
): Record<FrameRole, JoinedFrame | null> {
  const out = {} as Record<FrameRole, JoinedFrame | null>;
  for (const role of ["htf", "itf", "etf"] as const) {
    const src = roles[role];
    const idx = closedIndexAt(src.candles, src.timeframe, asOf);
    const snapshot = idx < 0 ? null : src.at(idx);
    out[role] = snapshot === null ? null : { timeframe: src.timeframe, barIndex: idx, snapshot };
  }
  return out;
}

function snapshotVote(snap: FrameSnapshot | null): { vote: MtfVote; source: VoteSource } {
  const s = snap?.structure;
  const m = snap?.momentum;
  if (s?.bias === "bullish" || s?.bias === "bearish") return { vote: s.bias === "bullish" ? 1 : -1, source: "structure" };
  if (m?.bias === "bullish" || m?.bias === "bearish") return { vote: m.bias === "bullish" ? 1 : -1, source: "momentum" };
  return { vote: 0, source: "none" };
}

/**
 * Canonical MTF path: execution timestamp → causal join → legally-visible snapshots →
 * alignment. Missing frames vote 0 (insufficient data → the named no-context states).
 */
export function causalAlignAt(
  symbol: string,
  roles: Record<FrameRole, FrameSource>,
  weights: { htf: number; itf: number; etf: number },
  asOf: number,
): { alignment: MultiTimeframeAlignment; diagnostics: Record<string, number | string | boolean> } {
  const joined = causalFramesAt(roles, asOf);
  const h = snapshotVote(joined.htf?.snapshot ?? null);
  const i = snapshotVote(joined.itf?.snapshot ?? null);
  const e = snapshotVote(joined.etf?.snapshot ?? null);
  const state = classifyVotes(h.vote, i.vote, e.vote);
  const alignmentScore = weights.htf * h.vote + weights.itf * i.vote + weights.etf * e.vote;
  const computedAt =
    [joined.htf, joined.itf, joined.etf]
      .map((f) => f?.snapshot.structure?.updatedAt)
      .filter((u): u is string => u !== undefined)
      .sort()
      .pop() ?? new Date(asOf).toISOString(); // asOf is an input — deterministic, never wall-clock

  const available = [joined.htf, joined.itf, joined.etf].filter(Boolean).length;
  return {
    alignment: {
      symbol,
      timeframes: { htf: roles.htf.timeframe, itf: roles.itf.timeframe, etf: roles.etf.timeframe },
      votes: { htf: h.vote, itf: i.vote, etf: e.vote },
      sources: {
        ...(h.source !== "none" ? { htf: h.source } : {}),
        ...(i.source !== "none" ? { itf: i.source } : {}),
        ...(e.source !== "none" ? { etf: e.source } : {}),
      },
      alignmentScore,
      state,
      computedAt,
    },
    diagnostics: {
      votes: `${h.vote},${i.vote},${e.vote}`,
      state,
      alignmentScore,
      framesAvailable: available,
      barIndex: `${joined.htf?.barIndex ?? -1},${joined.itf?.barIndex ?? -1},${joined.etf?.barIndex ?? -1}`,
      conflict: state.startsWith("countertrend") || state.startsWith("realigning") || state.startsWith("pullback"),
    },
  };
}

export function alignFrames(
  symbol: string,
  frames: { htf: Frame; itf: Frame; etf: Frame },
  weights: { htf: number; itf: number; etf: number },
): { alignment: MultiTimeframeAlignment; diagnostics: Record<string, number | string | boolean> } {
  const h = voteOf(frames.htf.structure, frames.htf.momentum);
  const i = voteOf(frames.itf.structure, frames.itf.momentum);
  const e = voteOf(frames.etf.structure, frames.etf.momentum);
  const state = classifyVotes(h.vote, i.vote, e.vote);
  const alignmentScore = weights.htf * h.vote + weights.itf * i.vote + weights.etf * e.vote;
  // computedAt = latest upstream snapshot timestamp — deterministic, never wall-clock.
  const computedAt = [
    frames.htf.structure.updatedAt,
    frames.itf.structure.updatedAt,
    frames.etf.structure.updatedAt,
  ].reduce((a, b) => (a > b ? a : b));

  return {
    alignment: {
      symbol,
      timeframes: { htf: frames.htf.timeframe, itf: frames.itf.timeframe, etf: frames.etf.timeframe },
      votes: { htf: h.vote, itf: i.vote, etf: e.vote },
      sources: {
        ...(h.source !== "none" ? { htf: h.source } : {}),
        ...(i.source !== "none" ? { itf: i.source } : {}),
        ...(e.source !== "none" ? { etf: e.source } : {}),
      },
      alignmentScore,
      state,
      computedAt,
    },
    diagnostics: {
      votes: `${h.vote},${i.vote},${e.vote}`,
      state,
      alignmentScore,
      conflict: state.startsWith("countertrend") || state.startsWith("realigning") || state.startsWith("pullback"),
    },
  };
}

// ---------------------------------------------------------------------------

export function createMultiTimeframeEngine(): MultiTimeframeEngine {
  return {
    align(input) {
      const { symbol, frames, config } = input;
      const errors: EngineError[] = [];
      const paramsVersion = "mtf-v1";
      const metaBase = {
        stage: "mtf",
        paramsVersion,
        barsConsumed: { from: -1, to: -1 },
      };
      const fail = (message: string) => {
        errors.push({ code: "invalid_config", message });
        return { ok: false, errors, meta: { ...metaBase, events: [] } };
      };

      const w = config.weights;
      const wSum = w.htf + w.itf + w.etf;
      if (w.htf < 0 || w.itf < 0 || w.etf < 0 || Math.abs(wSum - 1) > 1e-9) {
        return fail("mtf.weights must be ≥ 0 and sum to 1.0");
      }
      // Role set must match the frames actually supplied — mismatch is a caller bug.
      if (config.set.htf !== frames.htf.timeframe || config.set.itf !== frames.itf.timeframe || config.set.etf !== frames.etf.timeframe) {
        return fail("mtf.set must match the supplied frames' timeframes");
      }

      const { alignment, diagnostics } = alignFrames(symbol, frames, config.weights);
      return { ok: true, data: alignment, errors, meta: { ...metaBase, events: [], diagnostics } };
    },
  };
}
