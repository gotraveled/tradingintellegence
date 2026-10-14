/**
 * Phase 6 — Historical outcome measurement (docs/engine/17).
 *
 * The OutcomeEngine turns each `confirmed` setup into one `SetupOutcome` row by measuring the
 * price path AFTER confirmation. It does not re-run detection or the lifecycle state machine:
 * the setup engines (11–14) already replayed the lifecycle causally and stamped bar-indexed
 * transition markers on `setup.metadata` (confirmBar, activeBar, partialTargetBar,
 * targetReachedBar, invalidatedBar, expiredBar, cancelledBar, targetBars CSV). Measurement
 * trusts those stamps — they ARE the authoritative timeline — and derives excursion/entry/R
 * metrics from the candles in the observation window.
 *
 * Causality contract:
 * - Observation opens at `confirmBar + 1` — the confirmation bar's close is evidence, not
 *   outcome (spec 17).
 * - Outcome information (entry/targets/invalidation/exit) is by definition post-confirmation
 *   data. It never feeds back into detection or scoring — this file is the end of the pipe.
 * - The only inputs are the setup's frozen stamps + candles + caller-supplied causal scores —
 *   no live state, no clocks, no randomness. Replaying a longer/prefix series produces the
 *   identical row because the stamps came from the causal detection replay (spec 18 prefix
 *   property, proven by the 4H–4J suites).
 *
 * Same-bar semantics (spec 11, mirrored here via the stamps): the lifecycle resolves
 * invalidation (close-through, wicks never invalidate) BEFORE same-bar target touches — the
 * stamps therefore already encode canonical ordering; the engine never assumes intrabar
 * OHLC sequencing. MFE/MAE use bar extremes by definition (spec 17).
 */
import type {
  Candle,
  ID,
  Momentum,
  MultiTimeframeAlignment,
  RegimeLabel,
  ScoreContribution,
  Setup,
  SetupOutcome,
  Zone,
} from "@/lib/types";
import type { EngineError, EngineMeta, EngineResult, OutcomeEngine } from "@/lib/services/engine";
import { atrAt } from "./reversal";

const toISO = (ms: number) => new Date(ms).toISOString();
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const round4 = (x: number) => Number(x.toFixed(4));
const sign = (dir: Setup["direction"]) => (dir === "bullish" ? 1 : -1);

/** Spec-19 label universe in canonical declaration order (structure.ts) — the fixed
 *  order `regime.*` indicator keys are emitted in. */
const REGIME_LABELS: readonly RegimeLabel[] = [
  "trending_bullish",
  "trending_bearish",
  "ranging",
  "high_volatility",
  "low_volatility",
  "transition",
];

/**
 * Spec-35 decision-time feature bundle (docs/engine/17 featureVector schema closure).
 * The caller resolves each slice from the causal `at(confirmBar)` join — nothing here
 * is recomputed or measured by the outcome engine. Every field optional: an absent
 * slice emits no keys (honest absence — never fabricated zeros/neutrals).
 */
export interface OutcomeFeatureBundle {
  /** Swing-detection params in force — spec-17 "swing params context". */
  swing?: {
    leftBars?: number;
    rightBars?: number;
    atrLength?: number;
    minSignificanceAtr?: number;
    equalToleranceAtr?: number;
    mergeEqual?: boolean;
  };
  /** The setup's anchor zone as causally visible at confirmBar (caller resolves
   *  `zoneIds[0]`/`metadata.zoneId` through the per-bar provider). */
  zone?: Zone;
  /** Momentum snapshot at confirmBar — features + `displacementScore` (`disp.score`). */
  momentum?: Momentum;
  /** Spec-34 frozen alignment at confirmBar — framed cells only; absent ⇒ no `mtf.*`. */
  alignment?: MultiTimeframeAlignment;
}

/**
 * Flatten the spec-17 feature classes into namespaced numeric keys (spec-35 grammar).
 * Emitted classes, in canonical order: `swing.*` params context, `zone.*` anchor-zone
 * numerics, `disp.score` (the contract-exposed displacement composite — the spec's
 * `f_i` internals are not surfaced by the momentum contract), `momentum.*` features,
 * `mtf.*` votes + `mtf.score`, `regime.<label>` indicators (no canonical ordinal
 * exists — indicator keys are the non-arbitrary numeric encoding of an unordered
 * categorical; all six emitted 0/1 when the label is present). `score.*` keys are
 * merged by the caller block, not here.
 */
const flag01 = (b: boolean) => (b ? 1 : 0);

const flattenFeatures = (fx: OutcomeFeatureBundle, regime: RegimeLabel | undefined, into: Record<string, number>) => {
  const p = fx.swing;
  if (p) {
    if (p.leftBars !== undefined) into["swing.leftBars"] = p.leftBars;
    if (p.rightBars !== undefined) into["swing.rightBars"] = p.rightBars;
    if (p.atrLength !== undefined) into["swing.atrLength"] = p.atrLength;
    if (p.minSignificanceAtr !== undefined) into["swing.minSignificanceAtr"] = p.minSignificanceAtr;
    if (p.equalToleranceAtr !== undefined) into["swing.equalToleranceAtr"] = p.equalToleranceAtr;
    if (p.mergeEqual !== undefined) into["swing.mergeEqual"] = flag01(p.mergeEqual);
  }
  const z = fx.zone;
  if (z) {
    into["zone.strength"] = z.strength;
    if (z.remainingStrength !== undefined) into["zone.remainingStrength"] = z.remainingStrength;
    into["zone.retestCount"] = z.retestCount;
    if (z.penetrationDepthPct !== undefined) into["zone.penetrationDepthPct"] = z.penetrationDepthPct;
    if (z.htfAligned !== undefined) into["zone.htfAligned"] = flag01(z.htfAligned);
  }
  const m = fx.momentum;
  if (m) {
    if (m.displacementScore !== undefined) into["disp.score"] = m.displacementScore;
    const f = m.features;
    if (f) {
      if (f.directionalMove !== undefined) into["momentum.directionalMove"] = f.directionalMove;
      if (f.rateOfChange !== undefined) into["momentum.rateOfChange"] = f.rateOfChange;
      if (f.atrTrend !== undefined) into["momentum.atrTrend"] = f.atrTrend;
      if (f.bodyStrength !== undefined) into["momentum.bodyStrength"] = f.bodyStrength;
      if (f.consecDirection !== undefined) into["momentum.consecDirection"] = f.consecDirection;
      if (f.volumeRatio !== undefined) into["momentum.volumeRatio"] = f.volumeRatio;
      if (f.rsi14 !== undefined) into["momentum.rsi14"] = f.rsi14;
    }
  }
  const a = fx.alignment;
  if (a) {
    into["mtf.votes.htf"] = a.votes.htf;
    into["mtf.votes.itf"] = a.votes.itf;
    into["mtf.votes.etf"] = a.votes.etf;
    into["mtf.score"] = a.alignmentScore;
  }
  if (regime !== undefined) {
    for (const label of REGIME_LABELS) into[`regime.${label}`] = flag01(regime === label);
  }
};

/**
 * Measure one confirmed setup's outcome over the post-confirmation window.
 * Pure: identical (setup, candles, scores) → identical row, always.
 */
export function measureOutcome(input: {
  setup: Setup;
  candles: readonly Candle[];
  /** Score at confirmation (spec 17 `scoreAtConfirmation`) — supplied by the causal scoring
   *  path (`scoreOpportunity(... provenance "at_bar")`); defaults to `setup.score`. */
  scoreAtConfirmation?: number;
  /** Evidence score when the setup first became `developing` — caller computes at
   *  `candidateBar` on the causal path; absent when unknown. */
  scoreAtDetection?: number;
  /** Score contributions at confirmation — flattened into `featureVector`. */
  contributions?: ScoreContribution[];
  /** Regime at `confirmedAt` (spec 19) — caller resolves causally. */
  regime?: RegimeLabel;
  /** Spec-35: confirmBar-anchored feature bundle — flattened into `featureVector`
   *  alongside the `score.*` keys; absent ⇒ the V1 score-only vector is preserved. */
  features?: OutcomeFeatureBundle;
  paramsVersion?: string;
  supersedes?: ID;
}): EngineResult<SetupOutcome> {
  const s = input.setup;
  const candles = input.candles;
  const paramsVersion = input.paramsVersion ?? "1";

  const fail = (code: EngineError["code"], message: string): EngineResult<SetupOutcome> => ({
    ok: false,
    errors: [{ code, message }],
    meta: {
      stage: "outcome-measure", paramsVersion,
      barsConsumed: { from: -1, to: -1 }, events: [],
    },
  });
  if (candles.length === 0) return fail("insufficient_data", "empty series");

  // Spec 17: "every setup that reaches `confirmed` becomes a measurable case" — a developing
  // or pre-confirmation-cancelled setup produces NO row.
  const cb = num(s.metadata?.confirmBar);
  if (cb === undefined || cb < 0 || cb >= candles.length) {
    return fail("insufficient_data", "setup never confirmed — no outcome row (spec 17)");
  }

  const dir = s.direction;
  const sgn = sign(dir);
  const entryLow = num(s.metadata?.entryBandLow);
  const entryHigh = num(s.metadata?.entryBandHigh);
  const invalidation = num(s.metadata?.invalidation);
  if (entryLow === undefined || entryHigh === undefined || invalidation === undefined) {
    return fail("insufficient_data", "confirmed setup missing entry band/invalidation metadata");
  }
  const targets = (typeof s.metadata?.targets === "string" && s.metadata.targets.length > 0
    ? s.metadata.targets.split(",").map(Number).filter(Number.isFinite)
    : []);
  const targetBars = (typeof s.metadata?.targetBars === "string" && s.metadata.targetBars.length > 0
    ? s.metadata.targetBars.split(",").map(Number).filter(Number.isFinite)
    : []);

  // ---- Observation window [confirmBar+1, resolvedBar] (spec 17). ----
  const targetReachedBar = num(s.metadata?.targetReachedBar);
  const invalidatedBar = num(s.metadata?.invalidatedBar);
  const expiredBar = num(s.metadata?.expiredBar);
  const cancelledBar = num(s.metadata?.cancelledBar);
  const terminalBar = [targetReachedBar, invalidatedBar, expiredBar, cancelledBar]
    .filter((x): x is number => x !== undefined)
    .sort((a, b) => a - b)[0];
  const resolvedBar = Math.min(terminalBar ?? candles.length - 1, candles.length - 1);
  const unresolved = terminalBar === undefined;
  const winFrom = Math.min(cb + 1, resolvedBar); // empty window when confirmed on the last bar

  // ---- Activation + entry (spec 17: "first-touched price — conservative: proximal edge"). ----
  // Proximal edge is structural (specs 05/06): band.high for demand-side entries (bullish),
  // band.low for supply-side (bearish). It is unconditional — inferring which edge the bar
  // touched first from its open would be an intrabar-order assumption, which the spec's
  // same-bar rule forbids; the parenthetical makes the fill convention explicit.
  const activeBar = num(s.metadata?.activeBar);
  const activated = activeBar !== undefined && activeBar <= resolvedBar && activeBar > cb;
  let entryPrice: number | undefined;
  let initialRisk: number | undefined;
  let riskAtr: number | undefined;
  if (activated) {
    entryPrice = dir === "bullish" ? entryHigh : entryLow;
    initialRisk = Math.abs(entryPrice - invalidation);
    if (!(initialRisk > 0)) {
      return fail("invalid_input", `activated setup has non-positive risk (|${entryPrice} − ${invalidation}|)`);
    }
    const atr = atrAt(candles, activeBar);
    if (atr > 0) riskAtr = round4(initialRisk / atr);
  }

  // ---- Excursions — extremes, not closes (spec 17). Only when an entry exists (R needs risk). ----
  let mfeR: number | undefined;
  let maeR: number | undefined;
  if (activated && initialRisk !== undefined) {
    const E = entryPrice!;
    let mfe = 0, mae = 0;
    for (let t = winFrom; t <= resolvedBar; t++) {
      const b = candles[t];
      const favorable = dir === "bullish" ? (b.high - E) / initialRisk : (E - b.low) / initialRisk;
      const adverse = dir === "bullish" ? (E - b.low) / initialRisk : (b.high - E) / initialRisk;
      if (favorable > mfe) mfe = favorable;
      if (adverse > mae) mae = adverse;
    }
    mfeR = round4(mfe);
    maeR = round4(mae);
  }

  // ---- Targets: ordered hits recorded by the lifecycle stamps. ----
  const k = targetBars.length;
  const timeToTarget: (number | null)[] = targets.map((_, i) => (i < k ? targetBars[i] - cb : null));

  // ---- rMultiple (spec 17): equal weights (spec's "equal thirds" generalized to n targets);
  // hit targets bank at their prices, the remainder exits at the invalidating close or the
  // last window close. Unactivated → 0 (never filled; spec's 0-for-unactivated branch). ----
  let rMultiple: number | undefined;
  if (activated && initialRisk !== undefined) {
    const E = entryPrice!;
    const n = Math.max(targets.length, 1);
    let r = 0;
    for (let i = 0; i < k && i < targets.length; i++) r += sgn * (targets[i] - E) / initialRisk / n;
    const remW = (n - k) / n;
    if (remW > 0) {
      const exitClose = invalidatedBar !== undefined && invalidatedBar <= resolvedBar
        ? candles[invalidatedBar].close
        : candles[resolvedBar].close;
      r += remW * sgn * (exitClose - E) / initialRisk;
    }
    rMultiple = round4(r);
  } else if (!activated) {
    rMultiple = 0;
  }

  // Spec-35: merge the confirmBar feature classes with the V1 `score.*` keys —
  // frozen at row construction; absence of any slice omits its keys, never 0-fabricates.
  const fv: Record<string, number> = {};
  if (input.features) flattenFeatures(input.features, input.regime, fv);
  if (input.contributions?.length) {
    for (const c of input.contributions) fv[`score.${c.dimension}`] = c.feature;
    fv["score.total"] = input.scoreAtConfirmation ?? s.score;
  }
  const featureVector = Object.keys(fv).length ? fv : undefined;

  const outcome: SetupOutcome = {
    setupId: s.id,
    symbol: s.symbol,
    timeframe: s.timeframe,
    setupType: s.type,
    direction: dir,
    regime: input.regime,
    scoreAtDetection: input.scoreAtDetection,
    scoreAtConfirmation: input.scoreAtConfirmation ?? s.score,
    paramsVersion,
    entryPrice,
    initialRisk,
    riskAtr,
    mfeR,
    maeR,
    rMultiple,
    targetsReached: k,
    timeToTarget,
    timeToInvalidation: invalidatedBar !== undefined ? invalidatedBar - cb : null,
    barsToActive: activated ? activeBar - cb : null,
    stopReached: invalidatedBar !== undefined,
    expired: expiredBar !== undefined,
    unresolved,
    featureVector,
    confirmedAt: toISO(candles[cb].time),
    resolvedAt: toISO(candles[resolvedBar].time),
    supersedes: input.supersedes,
  };

  const meta: EngineMeta = {
    stage: "outcome-measure",
    paramsVersion,
    barsConsumed: { from: winFrom, to: resolvedBar },
    events: [],
    diagnostics: {
      activated,
      targetsReached: k,
      terminalBar: terminalBar ?? -1,
      unresolved,
      resolvedStatus: terminalBar !== undefined
        ? (targetReachedBar === terminalBar ? "target_reached"
          : invalidatedBar === terminalBar ? "invalidated"
          : expiredBar === terminalBar ? "expired" : "cancelled")
        : "unresolved",
    },
  };
  return { ok: true, data: outcome, errors: [], meta };
}

/**
 * Contract adapter (spec 20 `OutcomeEngine`). `opportunity` carries the causal-path score —
 * `opportunity.score` is the confirmation-time score, `scoreAtDetection` may be supplied via
 * the input field or `opportunity.metadata.scoreAtDetection`.
 */
export function createOutcomeEngine(): OutcomeEngine {
  return {
    measure(input) {
      return measureOutcome({
        setup: input.setup,
        candles: input.series.candles,
        scoreAtConfirmation: input.opportunity.score,
        scoreAtDetection: input.scoreAtDetection ?? num(input.opportunity.metadata?.scoreAtDetection),
        contributions: input.opportunity.scoreContributions ?? input.setup.scoreContributions,
        regime: input.regime,
        paramsVersion: input.paramsVersion,
      });
    },
  };
}
