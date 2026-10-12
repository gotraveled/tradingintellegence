import type {
  Candle,
  DetectionEvent,
  Direction,
  FVGConfig,
  Imbalance,
  Timeframe,
} from "@/lib/types";
import type { EngineError, ImbalanceEngine } from "@/lib/services/engine";

/**
 * FVG / Imbalance Engine (docs/engine/08-imbalances.md) — canonical FVG definition.
 *
 * A bullish FVG is a three-candle gap: `low[i+2] > high[i]` with a displacement middle
 * (bullish close, body ≥ `minMidBodyAtr`×ATR) and a gap ≥ `minGapAtr`×ATR. Bearish mirrors.
 * The imbalance is knowable at the close of candle C (bar i+2) — never earlier.
 *
 * Fill lifecycle (per-bar close, strictly after creation):
 *   open (< partialFillPct) → partially_filled (≥ partialFillPct)
 *   → filled (wick trades through the far boundary)
 *   → invalidated (close through the far boundary by invalidateAtr — stronger than filled)
 *   → expired (expiryBars without fill progress — diagnostic).
 *
 * ATR convention: `ATR[i+1]` = mean TR of the `atrLength` bars ending at the middle
 * candle — frozen at formation and reused for the invalidation margin. Overlapping or
 * consecutive FVGs are separate entities and are never merged (spec 08).
 */

const toISO = (ms: number): string => new Date(ms).toISOString();

export function fvgId(
  symbol: string,
  timeframe: Timeframe,
  direction: Direction,
  formedMs: number,
): string {
  return `fvg:${symbol}:${timeframe}:${direction}:${formedMs}`;
}

interface ImbalanceInternal extends Imbalance {
  /** Frozen formation ATR (mean TR of atrLength bars ending at the middle candle). */
  atr: number;
  createdBar: number;
  /** Latest bar where fillPct increased — expiry reference. */
  lastProgressBar: number;
  height: number;
}

export interface ImbalanceResult {
  imbalances: Imbalance[];
  events: DetectionEvent[];
  diagnostics: Record<string, number | string | boolean>;
}

export function analyzeImbalances(
  candles: readonly Candle[],
  symbol: string,
  timeframe: Timeframe,
  cfg: FVGConfig,
  paramsVersion: string,
  upToIndex?: number,
): ImbalanceResult {
  const n = candles.length;
  const end = upToIndex === undefined ? n - 1 : Math.min(upToIndex, n - 1);
  const out: ImbalanceInternal[] = [];
  const events: DetectionEvent[] = [];
  const rejected = { noGap: 0, smallGap: 0, flatMid: 0 };

  if (end < 0) {
    return { imbalances: [], events, diagnostics: { imbalances: 0, bullish: 0, bearish: 0 } };
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

  for (let t = 0; t <= end; t += 1) {
    const bar = candles[t];

    // 1. Formation — the triplet (t−2, t−1, t) is fully knowable at t (spec 08).
    if (t >= 2) {
      const a = candles[t - 2];
      const mid = candles[t - 1];
      const atr = meanTr(Math.max(0, t - 1 - cfg.atrLength + 1), t - 1);
      const midBody = Math.abs(mid.close - mid.open);
      const bull = bar.low > a.high && mid.close > mid.open;
      const bear = bar.high < a.low && mid.close < mid.open;
      if (bull || bear) {
        const gap = bull ? bar.low - a.high : a.low - bar.high;
        if (midBody < cfg.minMidBodyAtr * atr) rejected.flatMid += 1;
        else if (gap < cfg.minGapAtr * atr) rejected.smallGap += 1;
        else {
          const direction: Direction = bull ? "bullish" : "bearish";
          const upper = bull ? bar.low : a.low;
          const lower = bull ? a.high : bar.high;
          const spansSession =
            a.sessionId !== undefined && bar.sessionId !== undefined && a.sessionId !== bar.sessionId;
          const id = fvgId(symbol, timeframe, direction, a.time);
          out.push({
            id,
            symbol,
            timeframe,
            direction,
            upperPrice: upper,
            lowerPrice: lower,
            gapAtr: atr > 0 ? gap / atr : 0,
            fillPct: 0,
            status: "open",
            createdAt: toISO(bar.time),
            metadata: {
              createdBar: t,
              gap,
              spansSession,
            },
            atr,
            createdBar: t,
            lastProgressBar: t,
            height: upper - lower,
          });
          events.push({
            kind: "fvg_created",
            refId: id,
            symbol,
            atBar: t,
            at: toISO(bar.time),
            metadata: { eventId: `${id}:created:${bar.time}`, direction, gapAtr: atr > 0 ? gap / atr : 0, upper, lower },
          });
        }
      } else {
        rejected.noGap += 1;
      }
    }

    // 2. Fill lifecycle — closed bars strictly after creation only.
    for (const f of out) {
      if (t <= f.createdBar) continue;
      if (f.status === "filled" || f.status === "invalidated" || f.status === "expired") continue;
      const bullish = f.direction === "bullish";

      // penetration from the entry edge toward the far boundary, % of gap height.
      const pen = bullish
        ? ((f.upperPrice - bar.low) / f.height) * 100
        : ((bar.high - f.lowerPrice) / f.height) * 100;
      if (pen > (f.fillPct ?? 0)) {
        f.fillPct = pen;
        f.lastProgressBar = t;
      }

      // Invalidation is stronger than fill — a close through the far boundary (spec 08).
      const invalidated = bullish
        ? bar.close < f.lowerPrice - cfg.invalidateAtr * f.atr
        : bar.close > f.upperPrice + cfg.invalidateAtr * f.atr;
      if (invalidated) {
        f.status = "invalidated";
        f.fillPct = 100;
        f.invalidatedAt = toISO(bar.time);
        continue;
      }
      const filled = bullish ? bar.low <= f.lowerPrice : bar.high >= f.upperPrice;
      if (filled) {
        f.status = "filled";
        f.fillPct = 100;
        events.push({
          kind: "fvg_filled",
          refId: f.id,
          symbol,
          atBar: t,
          at: toISO(bar.time),
          metadata: { eventId: `${f.id}:filled:${bar.time}`, direction: f.direction },
        });
        continue;
      }
      if ((f.fillPct ?? 0) >= cfg.partialFillPct) {
        f.status = "partially_filled";
      }
      if (t - f.lastProgressBar > cfg.expiryBars) {
        f.status = "expired";
        f.metadata = { ...(f.metadata ?? {}), expiredAt: toISO(bar.time), expiredBar: t };
      }
    }
  }

  const zones: Imbalance[] = out.map((f) => {
    const copy: Imbalance = { ...f };
    delete (copy as Partial<ImbalanceInternal>).atr;
    delete (copy as Partial<ImbalanceInternal>).createdBar;
    delete (copy as Partial<ImbalanceInternal>).lastProgressBar;
    delete (copy as Partial<ImbalanceInternal>).height;
    return copy;
  });
  zones.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1));

  return {
    imbalances: zones,
    events,
    diagnostics: {
      imbalances: zones.length,
      bullish: zones.filter((f) => f.direction === "bullish").length,
      bearish: zones.filter((f) => f.direction === "bearish").length,
      open: zones.filter((f) => f.status === "open").length,
      partial: zones.filter((f) => f.status === "partially_filled").length,
      filled: zones.filter((f) => f.status === "filled").length,
      invalidated: zones.filter((f) => f.status === "invalidated").length,
      expired: zones.filter((f) => f.status === "expired").length,
      rejectedNoGap: rejected.noGap,
      rejectedSmallGap: rejected.smallGap,
      rejectedFlatMid: rejected.flatMid,
      spansSession: zones.filter((f) => f.metadata?.spansSession === true).length,
    },
  };
}

export function imbalanceStateAt(
  candles: readonly Candle[],
  symbol: string,
  timeframe: Timeframe,
  cfg: FVGConfig,
  paramsVersion: string,
  atIndex: number,
): Imbalance[] {
  return analyzeImbalances(candles, symbol, timeframe, cfg, paramsVersion, atIndex).imbalances;
}

// ---------------------------------------------------------------------------

export function createImbalanceEngine(): ImbalanceEngine {
  return {
    analyze(input) {
      const { series, config } = input;
      const errors: EngineError[] = [];
      const paramsVersion = series.params?.version ?? "unversioned";
      const metaBase = {
        stage: "imbalances",
        paramsVersion,
        barsConsumed: { from: 0, to: series.candles.length - 1 },
      };
      const fail = (message: string) => {
        errors.push({ code: "invalid_config", message });
        return { ok: false, errors, meta: { ...metaBase, events: [] } };
      };

      if (config.atrLength < 1) return fail("fvg.atrLength ≥ 1");
      if (config.minGapAtr < 0 || config.minMidBodyAtr < 0) {
        return fail("fvg.minGapAtr and fvg.minMidBodyAtr must be ≥ 0");
      }
      if (config.partialFillPct <= 0 || config.partialFillPct > 100) {
        return fail("fvg.partialFillPct must be in (0, 100]");
      }
      if (config.invalidateAtr < 0 || config.expiryBars < 1) {
        return fail("fvg.invalidateAtr ≥ 0 and fvg.expiryBars ≥ 1");
      }

      const { imbalances, events, diagnostics } = analyzeImbalances(
        series.candles,
        series.symbol,
        series.timeframe,
        config,
        paramsVersion,
      );

      return { ok: true, data: imbalances, errors, meta: { ...metaBase, events, diagnostics } };
    },
  };
}
