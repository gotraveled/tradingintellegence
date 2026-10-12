import type {
  Candle,
  DetectionEvent,
  Direction,
  Momentum,
  MomentumConfig,
  MomentumFeatures,
  MomentumState,
  Timeframe,
} from "@/lib/types";
import type { EngineError, MomentumEngine } from "@/lib/services/engine";

/**
 * Momentum / Displacement Engine (docs/engine/09-momentum.md).
 *
 * Two related feature sets, both ATR-normalised and computed on closed bars only:
 *   Part B — `MomentumFeatures` per bar: directionalMove, rateOfChange, atrTrend,
 *            bodyStrength, consecDirection, volumeRatio (+ optional rsi14, secondary only —
 *            no rule depends on it). Features are `undefined` until their window is fully
 *            available — no fabricated warm-up values.
 *   Part A — displacement score (0–100) for the trailing `disp.bars` leg ending at each bar;
 *            a `displacement` event fires on the rising edge of `score ≥ disp.threshold`.
 *
 * ATR convention (established across engines): mean true range of the last `atrLength`
 * bars ending at the measured bar — causal. `atrTrend` compares ATR now vs `trendShift`
 * bars ago, so the current bar never enters its own baseline.
 *
 * Contract limits (documented in spec-09 notes): the engine receives `{ series, config }`
 * only — no structure/pools/zones — so legs are evaluated as trailing windows (not
 * event-anchored departures) and `f_struct` is capped at the price-only "minor" value 0.5
 * (a leg close through the prior lookback extreme); 1.0 requires a BOS/CHOCH input the
 * contract lacks.
 */

const toISO = (ms: number): string => new Date(ms).toISOString();

export function displacementId(
  symbol: string,
  timeframe: Timeframe,
  direction: Direction,
  formedMs: number,
): string {
  return `disp:${symbol}:${timeframe}:${direction}:${formedMs}`;
}

/** Canonical candle decomposition — deterministic, zero-range safe. */
export interface CandleMetrics {
  range: number;
  body: number;
  upperWick: number;
  lowerWick: number;
  /** (close − low) / range; 0.5 for a zero-range bar — never NaN. */
  closeLoc: number;
  /** +1 bullish, −1 bearish, 0 doji. */
  dir: -1 | 0 | 1;
}

export function candleMetrics(c: Candle): CandleMetrics {
  const range = c.high - c.low;
  const top = Math.max(c.open, c.close);
  const bot = Math.min(c.open, c.close);
  return {
    range,
    body: Math.abs(c.close - c.open),
    upperWick: c.high - top,
    lowerWick: bot - c.low,
    closeLoc: range > 0 ? (c.close - c.low) / range : 0.5,
    dir: c.close > c.open ? 1 : c.close < c.open ? -1 : 0,
  };
}

export interface MomentumResult {
  momentum: Momentum;
  features: MomentumFeatures;
  /** Per-bar feature sets — full history, for replay/testing and downstream consumers. */
  featuresByBar: (MomentumFeatures | undefined)[];
  /** Displacement score of the leg ending at each bar (undefined during warm-up). */
  scoreByBar: (number | undefined)[];
  events: DetectionEvent[];
  diagnostics: Record<string, number | string | boolean>;
}

export function analyzeMomentum(
  candles: readonly Candle[],
  symbol: string,
  timeframe: Timeframe,
  cfg: MomentumConfig,
  paramsVersion: string,
  upToIndex?: number,
): MomentumResult {
  const n = candles.length;
  const end = upToIndex === undefined ? n - 1 : Math.min(upToIndex, n - 1);
  const events: DetectionEvent[] = [];
  const L = cfg.lookback;

  const featuresByBar: (MomentumFeatures | undefined)[] = new Array<MomentumFeatures | undefined>(n);
  const scoreByBar: (number | undefined)[] = new Array<number | undefined>(n);
  const stateByBar: MomentumState[] = new Array<MomentumState>(n).fill("neutral");
  const dmSeries: (number | undefined)[] = new Array<number | undefined>(n);

  if (end < 0) {
    return {
      momentum: { state: "neutral", bias: "neutral" },
      features: {},
      featuresByBar,
      scoreByBar,
      events,
      diagnostics: { bars: 0, displacementEvents: 0 },
    };
  }

  // ATR[i] = mean TR of the last atrLength bars ending at i (i ≥ 1 — TR needs prev close).
  const atr: (number | undefined)[] = new Array<number | undefined>(n);
  let trSum = 0;
  const tr = (i: number): number =>
    i === 0
      ? candles[0].high - candles[0].low
      : Math.max(
          candles[i].high - candles[i].low,
          Math.abs(candles[i].high - candles[i - 1].close),
          Math.abs(candles[i].low - candles[i - 1].close),
        );
  for (let i = 0; i <= end; i += 1) {
    trSum += tr(i);
    if (i - cfg.atrLength >= 0) trSum -= tr(i - cfg.atrLength);
    atr[i] = i >= 1 ? trSum / Math.min(i, cfg.atrLength) : undefined;
  }

  // Wilder RSI(atrLength) — secondary feature only, spec 09.
  const rsi: (number | undefined)[] = new Array<number | undefined>(n);
  if (end >= cfg.atrLength) {
    let g = 0;
    let l = 0;
    for (let i = 1; i <= cfg.atrLength; i += 1) {
      const d = candles[i].close - candles[i - 1].close;
      if (d > 0) g += d;
      else l -= d;
    }
    let avgG = g / cfg.atrLength;
    let avgL = l / cfg.atrLength;
    rsi[cfg.atrLength] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    for (let i = cfg.atrLength + 1; i <= end; i += 1) {
      const d = candles[i].close - candles[i - 1].close;
      avgG = (avgG * (cfg.atrLength - 1) + Math.max(0, d)) / cfg.atrLength;
      avgL = (avgL * (cfg.atrLength - 1) + Math.max(0, -d)) / cfg.atrLength;
      rsi[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
  }

  // ---------------------------------------------------------------------
  // Per-bar Part B features + Part A displacement score.
  // ---------------------------------------------------------------------
  const w = cfg.disp.weights;
  let prevQualified = false;
  let dispEvents = 0;

  for (let t = 0; t <= end; t += 1) {
    const a = atr[t];
    const f: MomentumFeatures = {};

    if (t >= 1) {
      // consecDirection — current signed run of same-direction closes (doji resets).
      let run = 0;
      for (let i = t; i >= 0; i -= 1) {
        const d = candleMetrics(candles[i]).dir;
        if (d === 0) break;
        if (i === t) run = d;
        else if (Math.sign(d) === Math.sign(run)) run += d;
        else break;
      }
      f.consecDirection = run;
    }

    if (a !== undefined) {
      if (t >= L - 1) {
        let signed = 0;
        let bodySum = 0;
        for (let i = t - L + 1; i <= t; i += 1) {
          signed += candles[i].close - candles[i].open;
          bodySum += Math.abs(candles[i].close - candles[i].open);
        }
        f.directionalMove = signed / a;
        f.bodyStrength = bodySum / L / a;
        dmSeries[t] = f.directionalMove;
      }
      if (t >= L) f.rateOfChange = (candles[t].close - candles[t - L].close) / a;
      if (t - cfg.trendShift >= 1) {
        const base = atr[t - cfg.trendShift];
        if (base !== undefined && base > 0) f.atrTrend = a / base;
      }
      // volumeRatio — only when every bar in the slow window reports volume.
      if (t >= cfg.vol.slow - 1) {
        const win = candles.slice(t - cfg.vol.slow + 1, t + 1);
        if (win.every((c) => typeof c.volume === "number")) {
          const slow = win.reduce((s, c) => s + (c.volume ?? 0), 0) / cfg.vol.slow;
          const fast =
            candles.slice(t - cfg.vol.fast + 1, t + 1).reduce((s, c) => s + (c.volume ?? 0), 0) /
            cfg.vol.fast;
          if (slow > 0) f.volumeRatio = fast / slow;
        }
      }
      if (rsi[t] !== undefined) f.rsi14 = rsi[t];
      featuresByBar[t] = f;

      // Part A — trailing-leg displacement score.
      if (t >= cfg.disp.bars - 1) {
        const s = t - cfg.disp.bars + 1;
        const leg = candles.slice(s, t + 1);
        const move = candles[t].close - candles[s].close;
        if (move !== 0) {
          const bull = move > 0;
          let maxBody = 0;
          let maxRange = 0;
          let locSum = 0;
          let dirBars = 0;
          for (const c of leg) {
            const cm = candleMetrics(c);
            if (cm.body > maxBody) maxBody = cm.body;
            if (cm.range > maxRange) maxRange = cm.range;
            locSum += bull ? cm.closeLoc : 1 - cm.closeLoc;
            if (cm.dir === (bull ? 1 : -1)) dirBars += 1;
          }
          const fBody = Math.min(1, maxBody / a / 2.0);
          const fRange = Math.min(1, maxRange / a / 3.0);
          const fClose = locSum / leg.length;
          const fDir = dirBars / leg.length;
          const fMove = Math.min(1, Math.abs(move) / a / 4.0);
          // f_struct — price-only "minor" proxy: leg-end close through the pre-leg
          // lookback extreme. 1.0 (BOS/CHOCH) needs structure input — documented.
          let fStruct = 0;
          if (s - 1 >= 0) {
            const pre = candles.slice(Math.max(0, s - L), s);
            const extreme = bull
              ? Math.max(...pre.map((c) => c.high))
              : Math.min(...pre.map((c) => c.low));
            if (bull ? candles[t].close > extreme : candles[t].close < extreme) fStruct = 0.5;
          }
          const parts: { w: number; f: number }[] = [
            { w: w.body, f: fBody },
            { w: w.range, f: fRange },
            { w: w.close, f: fClose },
            { w: w.dir, f: fDir },
            { w: w.move, f: fMove },
            { w: w.struct, f: fStruct },
          ];
          // volume — pro-rata redistribution when unavailable (spec 09 / zone convention).
          if (leg.every((c) => typeof c.volume === "number") && t >= cfg.vol.slow - 1) {
            const win = candles.slice(t - cfg.vol.slow + 1, t + 1);
            if (win.every((c) => typeof c.volume === "number")) {
              const vs = win.map((c) => c.volume ?? 0).sort((x, y) => x - y);
              const median = (vs[Math.floor((vs.length - 1) / 2)] + vs[Math.ceil((vs.length - 1) / 2)]) / 2;
              const legVol = leg.reduce((x, c) => x + (c.volume ?? 0), 0) / leg.length;
              if (median > 0) parts.push({ w: w.vol, f: Math.min(1, legVol / median / 2.0) });
            }
          }
          const wSum = parts.reduce((x, p) => x + p.w, 0);
          const score = wSum > 0 ? (100 * parts.reduce((x, p) => x + p.w * p.f, 0)) / wSum : 0;
          scoreByBar[t] = score;

          const qualified = score >= cfg.disp.threshold;
          if (qualified && !prevQualified) {
            dispEvents += 1;
            const id = displacementId(symbol, timeframe, bull ? "bullish" : "bearish", candles[t].time);
            events.push({
              kind: "displacement",
              refId: id,
              symbol,
              atBar: t,
              at: toISO(candles[t].time),
              metadata: { eventId: id, direction: bull ? "bullish" : "bearish", score: Math.round(score), legStart: s },
            });
          }
          prevQualified = qualified;
        } else {
          prevQualified = false;
        }
      }
    }

    // Derived state — precedence: diverging > weakening > strengthening > neutral.
    const dm = f.directionalMove;
    if (dm !== undefined) {
      const dmWindow = dmSeries.slice(Math.max(0, t - L + 1), t + 1).filter((x): x is number => x !== undefined);
      const dmMean = dmWindow.length > 0 ? dmWindow.reduce((x, y) => x + y, 0) / dmWindow.length : 0;
      const closes = candles.slice(Math.max(0, t - L + 1), t);
      const newHigh = closes.length > 0 && candles[t].close > Math.max(...closes.map((c) => c.close));
      const newLow = closes.length > 0 && candles[t].close < Math.min(...closes.map((c) => c.close));
      const dmHistory = dmSeries.slice(Math.max(0, t - L + 1), t).filter((x): x is number => x !== undefined);
      const diverging =
        dmHistory.length > 0 &&
        ((newHigh && dm < Math.max(...dmHistory)) || (newLow && dm > Math.min(...dmHistory)));
      const weakening =
        dmWindow.length >= 2 &&
        (Math.abs(dm) < cfg.state.weakenFactor * Math.abs(dmMean) ||
          (dmMean !== 0 && Math.sign(dm) !== Math.sign(dmMean)));
      const strengthening =
        f.rateOfChange !== undefined &&
        Math.sign(dm) === Math.sign(f.rateOfChange) &&
        dm !== 0 &&
        Math.abs(dm) >= cfg.state.strengthMoveAtr &&
        (f.bodyStrength ?? 0) >= cfg.state.strengthBodyAtr;
      stateByBar[t] = diverging ? "diverging" : weakening ? "weakening" : strengthening ? "strengthening" : "neutral";
    }
  }

  const last = featuresByBar[end] ?? {};
  const lastDm = last.directionalMove;
  const bias =
    lastDm !== undefined && lastDm > cfg.state.biasMoveAtr
      ? ("bullish" as const)
      : lastDm !== undefined && lastDm < -cfg.state.biasMoveAtr
        ? ("bearish" as const)
        : ("neutral" as const);

  const momentum: Momentum = {
    state: stateByBar[end],
    bias,
    displacementScore: scoreByBar[end] !== undefined ? Math.round(scoreByBar[end]!) : undefined,
    features: last,
  };

  return {
    momentum,
    features: last,
    featuresByBar,
    scoreByBar,
    events,
    diagnostics: {
      bars: end + 1,
      barsWithFeatures: featuresByBar.filter((x) => x !== undefined).length,
      displacementEvents: dispEvents,
      lastScore: scoreByBar[end] ?? -1,
      volumeFeature: candles.some((c) => typeof c.volume === "number") ? "used" : "redistributed",
      state: stateByBar[end],
      bias,
    },
  };
}

export function momentumStateAt(
  candles: readonly Candle[],
  symbol: string,
  timeframe: Timeframe,
  cfg: MomentumConfig,
  paramsVersion: string,
  atIndex: number,
): Momentum {
  return analyzeMomentum(candles, symbol, timeframe, cfg, paramsVersion, atIndex).momentum;
}

// ---------------------------------------------------------------------------

export function createMomentumEngine(): MomentumEngine {
  return {
    analyze(input) {
      const { series, config } = input;
      const errors: EngineError[] = [];
      const paramsVersion = series.params?.version ?? "unversioned";
      const metaBase = {
        stage: "momentum",
        paramsVersion,
        barsConsumed: { from: 0, to: series.candles.length - 1 },
      };
      const fail = (message: string) => {
        errors.push({ code: "invalid_config", message });
        return { ok: false, errors, meta: { ...metaBase, events: [] } };
      };

      const w = config.disp.weights;
      const wSum = Object.values(w).reduce((s, x) => s + x, 0);
      if (Object.values(w).some((x) => x < 0) || Math.abs(wSum - 1) > 1e-9) {
        return fail("momentum.disp.weights must be ≥ 0 and sum to 1.0");
      }
      if (config.lookback < 1 || config.atrLength < 1 || config.trendShift < 1) {
        return fail("momentum lookback/atrLength/trendShift must be ≥ 1");
      }
      if (config.vol.fast < 1 || config.vol.slow < config.vol.fast) {
        return fail("momentum.vol requires 1 ≤ fast ≤ slow");
      }
      if (config.disp.bars < 1 || config.disp.threshold < 0 || config.disp.threshold > 100) {
        return fail("momentum.disp requires bars ≥ 1 and threshold in [0, 100]");
      }
      if (config.state.weakenFactor < 0 || config.state.weakenFactor > 1) {
        return fail("momentum.state.weakenFactor must be in [0, 1]");
      }

      const { momentum, features, events, diagnostics } = analyzeMomentum(
        series.candles,
        series.symbol,
        series.timeframe,
        config,
        paramsVersion,
      );

      return { ok: true, data: { momentum, features }, errors, meta: { ...metaBase, events, diagnostics } };
    },
  };
}
