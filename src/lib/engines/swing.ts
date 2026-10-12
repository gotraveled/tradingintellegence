import type {
  Candle,
  DetectionEvent,
  SwingConfig,
  SwingKind,
  SwingPoint,
  SwingStatus,
  Timeframe,
} from "@/lib/types";
import type { EngineError, SwingEngine } from "@/lib/services/engine";
import { timeframeMs } from "@/lib/market-data";

/**
 * Swing Detection Engine (docs/engine/02-swing-detection.md) — the only implemented piece.
 * Pure, deterministic, provider-agnostic: candles + SwingConfig in, SwingPoint[] out.
 *
 * Look-ahead contract: a pivot at bar p can only be `confirmed` at confirmedIndex = p + rightBars.
 * `swingStateAt` gives the point-in-time snapshot; consumers filter by `confirmedIndex <= t`.
 */

// ---------------------------------------------------------------------------
// ATR — Wilder smoothing (swing.atrLength). Causal: atr[i] uses bars ≤ i only.
// Spec-undefined startup is documented: for i < atrLength, atr[i] is the mean of the
// available true ranges TR[1..i]; from i = atrLength onward, standard Wilder smoothing.
export function wilderAtr(candles: readonly Candle[], length: number): (number | undefined)[] {
  const atr: (number | undefined)[] = new Array(candles.length).fill(undefined);
  if (candles.length === 0 || length < 1) return atr;

  const tr: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i];
    const prev = candles[i - 1].close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  }

  let sum = 0;
  let prevAtr: number | undefined;
  for (let i = 1; i < candles.length; i += 1) {
    if (i < length) {
      // Seeding: cumulative mean of available TRs (documented implementation choice).
      sum += tr[i];
      atr[i] = sum / i;
    } else if (i === length) {
      sum += tr[i];
      prevAtr = sum / length;
      atr[i] = prevAtr;
    } else {
      prevAtr = ((prevAtr ?? 0) * (length - 1) + tr[i]) / length;
      atr[i] = prevAtr;
    }
  }
  return atr;
}

// ---------------------------------------------------------------------------
// Candidate collection — pure windowed test, O(n × (leftBars + rightBars)).

interface Candidate {
  kind: SwingKind;
  pivotIndex: number;
  price: number;
  /** close of bar p+rightBars when it exists in this series, else undefined → developing. */
  confirmedIndex?: number;
  atrAtPivot: number;
}

function isCandidate(
  candles: readonly Candle[],
  p: number,
  kind: SwingKind,
  cfg: SwingConfig,
  atr: (number | undefined)[],
): Candidate | undefined {
  const a = atr[p];
  if (a === undefined) return undefined;
  const extreme = (i: number) => (kind === "high" ? candles[i].high : candles[i].low);
  const tol = cfg.equalToleranceAtr * a;
  const pivot = extreme(p);

  // Left window: every bar must be inside pivot ± tol on the correct side.
  let leftExtreme = kind === "high" ? -Infinity : Infinity;
  for (let i = p - cfg.leftBars; i < p; i += 1) {
    const d = kind === "high" ? extreme(i) - pivot : pivot - extreme(i);
    if (d > tol) return undefined; // neighbour beyond the pivot — not a swing
    leftExtreme =
      kind === "high" ? Math.max(leftExtreme, extreme(i)) : Math.min(leftExtreme, extreme(i));
  }

  // Significance: pivot must clear its left-window extreme by ≥ minSignificanceAtr × ATR.
  const margin = kind === "high" ? pivot - leftExtreme : leftExtreme - pivot;
  if (margin < cfg.minSignificanceAtr * a) return undefined;

  // Right window: only bars that exist; a violation on an existing bar kills the candidate.
  const rightEnd = p + cfg.rightBars;
  const last = Math.min(rightEnd, candles.length - 1);
  for (let i = p + 1; i <= last; i += 1) {
    const d = kind === "high" ? extreme(i) - pivot : pivot - extreme(i);
    if (d > tol) return undefined;
  }

  return {
    kind,
    pivotIndex: p,
    price: pivot,
    confirmedIndex: rightEnd <= candles.length - 1 ? rightEnd : undefined,
    atrAtPivot: a,
  };
}

// ---------------------------------------------------------------------------
// Ordered resolution — mergeEqual runs, dominance, and the isolation rule.
// Candidates are processed in pivot order; supersession is a STATUS change only
// (spec: confirmed history never rewrites — a superseded swing keeps its pivot data
// but is excluded from the emitted set and counted in diagnostics).

interface Resolved extends Candidate {
  status: SwingStatus;
  equalCount: number;
  invalidatedIndex?: number;
}

function resolveCandidates(
  candidates: Candidate[],
  cfg: SwingConfig,
): { resolved: Resolved[]; supersededCount: number } {
  const sorted = [...candidates].sort((a, b) => a.pivotIndex - b.pivotIndex);
  const resolved: Resolved[] = [];
  let supersededCount = 0;
  // The most recent emitted swing per kind that has no opposite-kind swing after it.
  const openByKind: Partial<Record<SwingKind, Resolved>> = {};

  const moreExtreme = (a: Resolved | Candidate, b: Resolved | Candidate) =>
    a.kind === "high" ? a.price > b.price : a.price < b.price;

  for (const cand of sorted) {
    const open = openByKind[cand.kind];
    const withinTol =
      open !== undefined &&
      Math.abs(cand.price - open.price) <= cfg.equalToleranceAtr * open.atrAtPivot;

    if (open !== undefined) {
      if (withinTol && cfg.mergeEqual) {
        // Equal run → one swing anchored at the extreme (ties → earliest = keep existing).
        open.equalCount += 1;
        if (moreExtreme(cand, open)) {
          open.pivotIndex = cand.pivotIndex;
          open.price = cand.price;
          open.atrAtPivot = cand.atrAtPivot;
        }
        // The merged swing is knowable only when its latest member resolves.
        open.confirmedIndex =
          cand.confirmedIndex === undefined || open.confirmedIndex === undefined
            ? undefined
            : Math.max(open.confirmedIndex, cand.confirmedIndex);
        open.status = open.confirmedIndex === undefined ? "developing" : "confirmed";
        continue;
      }
      // Dominance/isolation (spec: replacement pre-confirmation; no two confirmed same-kind
      // without an opposite between). A developing open yields to any more-extreme candidate;
      // a confirmed open yields only to a CONFIRMED candidate — a still-developing candidate
      // may die and must never kill confirmed history. Weaker candidates are absorbed.
      const canSupersede = open.status === "developing" || cand.confirmedIndex !== undefined;
      if (canSupersede && moreExtreme(cand, open)) {
        open.status = "superseded";
        supersededCount += 1;
        // fall through — cand becomes the open swing for its kind
      } else {
        supersededCount += 1;
        continue;
      }
    }

    const next: Resolved = {
      ...cand,
      equalCount: 1,
      status: cand.confirmedIndex === undefined ? "developing" : "confirmed",
    };
    resolved.push(next);
    openByKind[cand.kind] = next;
    // An opposite-kind swing closes the "open" interval for this kind.
    openByKind[cand.kind === "high" ? "low" : "high"] = undefined;
  }

  return { resolved, supersededCount };
}

// ---------------------------------------------------------------------------
// Invalidation — a confirmed swing dies on a CLOSE beyond level ± tol × ATR (wick-immune).

function applyInvalidation(
  resolved: Resolved[],
  candles: readonly Candle[],
  atr: (number | undefined)[],
  cfg: SwingConfig,
): number {
  let invalidated = 0;
  for (const s of resolved) {
    if (s.status !== "confirmed" || s.confirmedIndex === undefined) continue;
    for (let i = s.confirmedIndex + 1; i < candles.length; i += 1) {
      const a = atr[i];
      if (a === undefined) continue;
      const tol = cfg.equalToleranceAtr * a;
      const broken =
        s.kind === "high" ? candles[i].close > s.price + tol : candles[i].close < s.price - tol;
      if (broken) {
        s.status = "invalidated";
        s.invalidatedIndex = i;
        invalidated += 1;
        break;
      }
    }
  }
  return invalidated;
}

// ---------------------------------------------------------------------------
// Public API

export interface SwingDetection {
  swings: SwingPoint[];
  events: DetectionEvent[];
  diagnostics: Record<string, number | string | boolean>;
}

const toISO = (ms: number): string => new Date(ms).toISOString();

/** Deterministic identity — symbol/timeframe/kind/pivot time only, never random. */
export function swingId(
  symbol: string,
  timeframe: Timeframe,
  kind: SwingKind,
  pivotTime: number,
): string {
  return `sw:${symbol}:${timeframe}:${kind}:${pivotTime}`;
}

/** True when the swing's window straddles a data gap (>1.5× interval between adjacent bars). */
function spansGap(
  candles: readonly Candle[],
  pivot: number,
  cfg: SwingConfig,
  intervalMs: number | undefined,
): boolean {
  if (intervalMs === undefined) return false;
  const from = Math.max(0, pivot - cfg.leftBars);
  const to = Math.min(candles.length - 1, pivot + cfg.rightBars);
  for (let i = from + 1; i <= to; i += 1) {
    if (candles[i].time - candles[i - 1].time > intervalMs * 1.5) return true;
  }
  return false;
}

/**
 * Core detection on a candle array (already-validated, strictly ordered — validation is the
 * market-data layer's job). Returns swings in pivot order with full lifecycle metadata.
 */
export function detectSwings(
  candles: readonly Candle[],
  symbol: string,
  timeframe: Timeframe,
  cfg: SwingConfig,
  paramsVersion: string,
): SwingDetection {
  const events: DetectionEvent[] = [];
  if (candles.length === 0) {
    return { swings: [], events, diagnostics: { candidates: 0, superseded: 0, invalidated: 0 } };
  }

  const atr = wilderAtr(candles, cfg.atrLength);
  const interval = timeframeMs(timeframe);

  const candidates: Candidate[] = [];
  for (let p = cfg.leftBars; p < candles.length; p += 1) {
    const hi = isCandidate(candles, p, "high", cfg, atr);
    if (hi) candidates.push(hi);
    const lo = isCandidate(candles, p, "low", cfg, atr);
    if (lo) candidates.push(lo);
  }

  const { resolved, supersededCount } = resolveCandidates(candidates, cfg);
  const invalidatedCount = applyInvalidation(resolved, candles, atr, cfg);

  const swings: SwingPoint[] = resolved
    .filter((s) => s.status !== "superseded")
    .map((s) => {
      const time = candles[s.pivotIndex].time;
      const sp: SwingPoint = {
        id: swingId(symbol, timeframe, s.kind, time),
        symbol,
        timeframe,
        kind: s.kind,
        price: s.price,
        pivotIndex: s.pivotIndex,
        pivotAt: toISO(time),
        status: s.status,
        metadata: {
          equalCount: s.equalCount,
          atrAtPivot: Number(s.atrAtPivot.toFixed(8)),
          paramsVersion,
          barsAroundGap: spansGap(candles, s.pivotIndex, cfg, interval),
          ...(s.invalidatedIndex !== undefined ? { invalidatedIndex: s.invalidatedIndex } : {}),
        },
      };
      if (s.confirmedIndex !== undefined) {
        sp.confirmedIndex = s.confirmedIndex;
        sp.confirmedAt = toISO(candles[s.confirmedIndex].time);
        if (s.status !== "developing") {
          events.push({
            kind: "swing_confirmed",
            refId: sp.id ?? "",
            symbol,
            atBar: s.confirmedIndex,
            at: sp.confirmedAt,
            metadata: { swingKind: s.kind, price: s.price, pivotIndex: s.pivotIndex },
          });
        }
      }
      if (s.status === "invalidated" && s.invalidatedIndex !== undefined) {
        sp.invalidatedAt = toISO(candles[s.invalidatedIndex].time);
        events.push({
          kind: "swing_invalidated",
          refId: sp.id ?? "",
          symbol,
          atBar: s.invalidatedIndex,
          at: sp.invalidatedAt,
          metadata: { swingKind: s.kind, price: s.price },
        });
      }
      return sp;
    });

  return {
    swings,
    events,
    diagnostics: {
      candidates: candidates.length,
      superseded: supersededCount,
      invalidated: invalidatedCount,
      confirmed: resolved.filter((s) => s.status === "confirmed" || s.status === "invalidated")
        .length,
      developing: resolved.filter((s) => s.status === "developing").length,
    },
  };
}

/**
 * `state(atIndex)` per spec: the exact swings knowable at bar `t`. Implemented by re-detection
 * on the 0..t prefix — guaranteed identical to what a live pass would have produced. O(n·w)
 * per call; the hot path for backtests is a single `detect` + `confirmedIndex` filtering.
 */
export function swingStateAt(
  candles: readonly Candle[],
  symbol: string,
  timeframe: Timeframe,
  cfg: SwingConfig,
  paramsVersion: string,
  atIndex: number,
): SwingPoint[] {
  return detectSwings(candles.slice(0, atIndex + 1), symbol, timeframe, cfg, paramsVersion).swings;
}

// ---------------------------------------------------------------------------
// SwingEngine contract (docs/engine/20-engine-interfaces.md)

export function createSwingEngine(): SwingEngine {
  return {
    detect(input) {
      const { series, config } = input;
      const errors: EngineError[] = [];
      const paramsVersion = series.params?.version ?? "unversioned";

      if (config.leftBars < 1 || config.rightBars < 1 || config.atrLength < 1) {
        errors.push({
          code: "invalid_config",
          message: "leftBars/rightBars/atrLength must be ≥ 1",
        });
        return {
          ok: false,
          errors,
          meta: {
            stage: "swing",
            paramsVersion,
            barsConsumed: { from: 0, to: series.candles.length - 1 },
            events: [],
          },
        };
      }

      if (series.candles.length <= config.leftBars) {
        errors.push({
          code: "insufficient_data",
          message: `need > leftBars (${config.leftBars}) bars, got ${series.candles.length}`,
        });
        return {
          ok: false,
          errors,
          meta: {
            stage: "swing",
            paramsVersion,
            barsConsumed: { from: 0, to: series.candles.length - 1 },
            events: [],
          },
        };
      }

      const { swings, events, diagnostics } = detectSwings(
        series.candles,
        series.symbol,
        series.timeframe,
        config,
        paramsVersion,
      );

      return {
        ok: true,
        data: swings,
        errors,
        meta: {
          stage: "swing",
          paramsVersion,
          barsConsumed: { from: 0, to: series.candles.length - 1 },
          events,
          diagnostics,
        },
      };
    },
  };
}
