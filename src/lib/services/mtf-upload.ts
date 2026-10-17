/**
 * Multi-timeframe composition for user-uploaded datasets (Phase P3).
 *
 * This module owns NO engine semantics. It translates a set of validated
 * UploadedSeries into the spec-31 `BacktestCell.frames` transport and the
 * spec-10 `config.mtf.set` role map, then reports which uploads composed and
 * which did not. Causality is enforced inside the engine by `closedIndexAt` /
 * `barCloseTime` — a frame bar is visible only once its CLOSE is ≤ the anchor.
 * Nothing here duplicates that join; this layer only guarantees the inputs
 * honor its contract:
 *
 *   - one instrument identity across every dataset (declared, enforced);
 *   - one dataset per timeframe (duplicates are rejected, never merged);
 *   - role assignment respects canonical ordering — htf > itf > etf or the
 *     role is left absent (empty frame → honest vote-0, never fabricated);
 *   - per-frame closed-bar visibility at the anchor is reported so the UI can
 *     explain exactly what the engine saw.
 */
import type {
  AssetIdentifier,
  BacktestCell,
  Candle,
  CandleSeries,
  EngineConfig,
  Timeframe,
} from "@/lib/types";
import type { FrameRole } from "@/lib/engines/mtf";
import { barCloseTime, closedIndexAt } from "@/lib/engines/mtf";
import { TIMEFRAME_MS } from "@/lib/market-data/timeframes";
import type { UploadedSeries } from "./uploaded-provider";

/** Canonical timeframe ordering — mirrors the spec-25 declaration order the
 *  engine encodes in its private TF_ORDER. Kept here so role arithmetic never
 *  imports engine internals beyond the public causal join. */
const CANONICAL_ORDER: readonly Timeframe[] = [
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1D", "1W", "1M",
];

const rank = (tf: Timeframe): number => CANONICAL_ORDER.indexOf(tf);

export const isCanonicalTimeframe = (v: unknown): v is Timeframe =>
  typeof v === "string" && (v === "1M" || v in TIMEFRAME_MS);

// ---------------------------------------------------------------------------
// Role assignment — spec-10 htf/itf/etf grammar over the uploaded set.
// ---------------------------------------------------------------------------

export interface MtfRoleAssignment {
  /** Role → timeframe actually bound to an uploaded dataset. itf == anchor. */
  roles: { htf?: Timeframe; itf: Timeframe; etf?: Timeframe };
  /** Uploaded timeframes that could not be bound to a role — surfaced, never
   *  silently dropped. */
  unused: Timeframe[];
  /** Full `config.mtf.set` — absent roles carry a non-colliding canonical
   *  placeholder so the engine's own `roleTf === timeframe` cell-series rule
   *  can never misbind the cell to an unintended role. */
  set: { htf: Timeframe; itf: Timeframe; etf: Timeframe };
}

export type MtfAssignResult =
  | { ok: true; assignment: MtfRoleAssignment }
  | { ok: false; error: string };

/**
 * Assign spec-10 roles over the uploaded timeframe set.
 * - `anchor` must be an uploaded timeframe — it is the cell/structure series.
 * - Defaults: htf = nearest timeframe strictly above the anchor,
 *   etf = nearest strictly below. Callers may override either; overrides are
 *   validated for ordering and membership, never trusted.
 * - Extra uploads beyond the three roles are reported as `unused`.
 */
export function assignMtfRoles(
  uploaded: readonly Timeframe[],
  anchor: Timeframe,
  overrides?: { htf?: Timeframe; etf?: Timeframe },
): MtfAssignResult {
  if (!isCanonicalTimeframe(anchor) || !uploaded.includes(anchor)) {
    return { ok: false, error: "anchor timeframe must be one of the uploaded datasets." };
  }
  const unique = [...new Set(uploaded)];
  if (unique.length !== uploaded.length) {
    const dups = [...new Set(uploaded.filter((t, i) => uploaded.indexOf(t) !== i))];
    return {
      ok: false,
      error:
        `duplicate uploaded timeframe(s): ${dups.join(", ")} — supply exactly one ` +
        "dataset per timeframe; ambiguous sources are never silently merged or dropped.",
    };
  }
  const above = unique.filter((t) => rank(t) > rank(anchor)).sort((a, b) => rank(a) - rank(b));
  const below = unique.filter((t) => rank(t) < rank(anchor)).sort((a, b) => rank(b) - rank(a));

  const htf = overrides?.htf ?? above[0];
  const etf = overrides?.etf ?? below[0];

  if (htf !== undefined) {
    if (!uploaded.includes(htf)) return { ok: false, error: "htf must be an uploaded timeframe." };
    if (rank(htf) <= rank(anchor)) {
      return { ok: false, error: `htf (${htf}) must be a higher timeframe than the anchor (${anchor}).` };
    }
  }
  if (etf !== undefined) {
    if (!uploaded.includes(etf)) return { ok: false, error: "etf must be an uploaded timeframe." };
    if (rank(etf) >= rank(anchor)) {
      return { ok: false, error: `etf (${etf}) must be a lower timeframe than the anchor (${anchor}).` };
    }
  }

  const bound = new Set<Timeframe>([anchor, ...(htf ? [htf] : []), ...(etf ? [etf] : [])]);
  const unused = unique.filter((t) => !bound.has(t));

  // Absent roles need a canonical placeholder that is neither the anchor nor
  // another bound role — otherwise the engine's `roleTf === timeframe` rule
  // would serve the cell's own series as e.g. its "htf" (fabricated context).
  // Prefer timeframes outside the upload set so the report never conflates a
  // placeholder with an uploaded-but-unused dataset.
  const claimed = new Set<Timeframe>(bound);
  const pick = (): Timeframe => {
    const free = CANONICAL_ORDER.find((t) => !claimed.has(t) && !uploaded.includes(t))
      ?? CANONICAL_ORDER.find((t) => !claimed.has(t));
    const chosen = free ?? "1m"; // unreachable — 13 canonical timeframes, ≤3 claimed
    claimed.add(chosen);
    return chosen;
  };
  const setHtf = htf ?? pick();
  const setEtf = etf ?? pick();

  return {
    ok: true,
    assignment: {
      roles: { ...(htf !== undefined ? { htf } : {}), itf: anchor, ...(etf !== undefined ? { etf } : {}) },
      unused,
      set: { htf: setHtf, itf: anchor, etf: setEtf },
    },
  };
}

// ---------------------------------------------------------------------------
// Frame transport — UploadedSeries → BacktestCell.frames
// ---------------------------------------------------------------------------

/**
 * Resolver matching `AnalysisCompositionDeps.frames`: returns the spec-31
 * frames for a cell only when that cell is the anchor cell of this MTF run.
 * Every other cell receives `undefined` — baseline behavior, bit-identical.
 */
export function mtfFrameResolver(input: {
  symbol: string;
  anchor: Timeframe;
  roles: MtfRoleAssignment["roles"];
  datasets: readonly UploadedSeries[];
}): (asset: AssetIdentifier, timeframe: Timeframe) => BacktestCell["frames"] {
  const byTf = new Map<Timeframe, UploadedSeries>(input.datasets.map((d) => [d.timeframe, d]));
  return (asset, timeframe) => {
    if (asset.symbol !== input.symbol || timeframe !== input.anchor) return undefined;
    const frames: Partial<Record<FrameRole, CandleSeries>> = {};
    for (const role of ["htf", "etf"] as const) {
      const tf = input.roles[role];
      const s = tf !== undefined ? byTf.get(tf) : undefined;
      if (s !== undefined) {
        frames[role] = {
          symbol: s.symbol,
          timeframe: s.timeframe,
          candles: s.candles,
        };
      }
    }
    return Object.keys(frames).length === 0 ? undefined : frames;
  };
}

/** EngineConfig with `mtf.set` bound to the assignment — weights unchanged
 *  from the caller's config (spec-10 caller-owned values). */
export function withMtfSet(
  config: EngineConfig,
  set: MtfRoleAssignment["set"],
): EngineConfig {
  return { ...config, mtf: { ...config.mtf, set } };
}

// ---------------------------------------------------------------------------
// Window & visibility reporting — the "what the engine can see" facts.
// ---------------------------------------------------------------------------

export interface FrameVisibility {
  role: FrameRole | "unused";
  timeframe: Timeframe;
  fileName?: string;
  bars: number;
  firstBarIso: string;
  lastBarIso: string;
  /** Index of the last frame bar whose CLOSE ≤ anchor — −1 when nothing was
   *  legally visible. Computed with the engine's own closedIndexAt. */
  closedIndexAtAnchor: number;
  state: "serves-cell" | "usable" | "no-closed-bar" | "unused";
}

/**
 * Per-dataset visibility report at the anchor timestamp (the cell anchor bar's
 * close). Uses the canonical join so the report cannot disagree with the run.
 */
export function describeFrames(input: {
  roles: MtfRoleAssignment["roles"];
  datasets: readonly UploadedSeries[];
  anchorCloseMs: number;
  fileNames?: ReadonlyMap<Timeframe, string>;
}): FrameVisibility[] {
  const out: FrameVisibility[] = [];
  for (const d of input.datasets) {
    const base = {
      timeframe: d.timeframe,
      ...(input.fileNames?.has(d.timeframe) ? { fileName: input.fileNames.get(d.timeframe) } : {}),
      bars: d.candles.length,
      firstBarIso: new Date(d.candles[0]?.time ?? 0).toISOString(),
      lastBarIso: new Date(d.candles[d.candles.length - 1]?.time ?? 0).toISOString(),
    };
    if (d.timeframe === input.roles.itf) {
      out.push({
        role: "itf",
        ...base,
        closedIndexAtAnchor: closedIndexAt(d.candles, d.timeframe, input.anchorCloseMs),
        state: "serves-cell",
      });
      continue;
    }
    const isBound = d.timeframe === input.roles.htf || d.timeframe === input.roles.etf;
    if (!isBound) {
      out.push({ role: "unused", ...base, closedIndexAtAnchor: -1, state: "unused" });
      continue;
    }
    const idx = closedIndexAt(d.candles, d.timeframe, input.anchorCloseMs);
    out.push({
      role: d.timeframe === input.roles.htf ? "htf" : "etf",
      ...base,
      closedIndexAtAnchor: idx,
      state: idx >= 0 ? "usable" : "no-closed-bar",
    });
  }
  return out;
}

/**
 * Common analysis window: the interval inside which every dataset can
 * contribute. `start` = latest first-open; `end` = earliest last-bar close
 * (via the canonical barCloseTime — calendar-correct for "1M").
 * Returns null when the datasets do not overlap at all.
 */
export function commonWindow(
  datasets: readonly { timeframe: Timeframe; candles: readonly Candle[] }[],
): { start: number; end: number } | null {
  let start = -Infinity;
  let end = Infinity;
  for (const d of datasets) {
    if (d.candles.length === 0) return null;
    start = Math.max(start, d.candles[0].time);
    end = Math.min(end, barCloseTime(d.candles[d.candles.length - 1], d.timeframe));
  }
  return Number.isFinite(start) && Number.isFinite(end) && start < end ? { start, end } : null;
}

// ---------------------------------------------------------------------------
// Timestamp semantics — honest ambiguity reporting.
// ---------------------------------------------------------------------------

export type TimeSemantics =
  | { kind: "epoch_seconds" | "epoch_ms"; assumption: string }
  | { kind: "iso_explicit"; assumption: string }
  | { kind: "iso_naive"; assumption: string }
  | { kind: "unknown"; assumption: string };

/**
 * Classify how a raw timestamp cell will be interpreted — the ambiguity a
 * user must know about before MTF alignment is trusted.
 */
export function classifyTimeSemantics(raw: string | undefined): TimeSemantics {
  const v = (raw ?? "").trim();
  if (v === "") {
    return { kind: "unknown", assumption: "no timestamp sample available." };
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return Math.abs(n) >= 1e12
      ? { kind: "epoch_ms", assumption: "numeric timestamps read as Unix epoch milliseconds (UTC)." }
      : { kind: "epoch_seconds", assumption: "numeric timestamps read as Unix epoch seconds (UTC)." };
  }
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v)) {
    return { kind: "iso_explicit", assumption: "timestamps carry an explicit UTC offset." };
  }
  return {
    kind: "iso_naive",
    assumption:
      "timestamps have no timezone marker — they are interpreted by the server's " +
      "local clock (UTC on most deployments). If the source used a different timezone, " +
      "cross-timeframe alignment will be shifted.",
  };
}
