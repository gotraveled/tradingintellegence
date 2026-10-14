/**
 * Phase 9 — System-Level Historical Backtesting & Validation (docs/engine/26).
 *
 * A thin orchestration + recording + aggregation layer — NOT a trade simulator. Per cell it
 * composes the existing causal machinery end-to-end:
 *
 *   batch-detected upstream artifacts → per-bar `*StateAt` providers (+ spec-31
 *   MTF frame providers → `causalAlignAt` at `barCloseTime(t)` when a cell
 *   supplies `frames`) → three detectors
 *   → post-window spec-17 `measureOutcome` + spec-24 decision views (phase A)
 *   → status-at-T from `setup_transition` events → PIT scoring → spec-28 plan →
 *   spec-30 statistical evidence (confirmBar-anchored, resolution-gated) →
 *   spec-25 scanner at `asOf = candle.time[t]` → frozen records (phase B)
 *   → outcomeRef attachment → aggregation.
 *
 * Model B: the evaluation window bounds observation generation; outcome measurement may
 * consume candles through the series end — post-endIndex data can only ever touch
 * `SetupOutcome`/`outcomeRef`/outcome aggregates, never an evaluation-time field.
 */
import type {
  BacktestAggregate,
  BacktestCell,
  BacktestDeveloping,
  BacktestOpportunity,
  BacktestSelection,
  BacktestWindow,
  Direction,
  EngineConfig,
  RegimeLabel,
  ScanCandidate,
  ScanFilters,
  ScanPlan,
  ScoreContribution,
  Setup,
  SetupOutcome,
  SetupStatus,
  SetupType,
  StatisticalDecision,
  StatisticalEvidence,
  SystemBacktestResult,
  Timeframe,
} from "@/lib/types";
import type { EngineError, EngineResult, BacktestEngine } from "@/lib/services/engine";
import { validateBars } from "@/lib/market-data/validation";
import { detectSwings } from "./swing";
import { analyzeStructure, structureStateAt } from "./structure";
import { analyzeLiquidity, liquidityStateAt } from "./liquidity";
import { analyzeZones, zoneStateAt, type ZoneHtfProvider } from "./zones";
import { analyzeImbalances, imbalanceStateAt } from "./imbalances";
import { momentumStateAt } from "./momentum";
import { detectReversals } from "./reversal";
import { detectBreakouts } from "./breakout";
import { detectContinuations } from "./continuation";
import { regimeStateAt } from "./regime";
import { barCloseTime, causalAlignAt, causalFramesAt, closedIndexAt, type FrameRole, type FrameSource } from "./mtf";
import { scoreOpportunity } from "./scoring";
import { measureOutcome, type OutcomeFeatureBundle } from "./outcomes";
import { planStateAt, toScanPlan } from "./trade-plan";
import { estimateProbability } from "./statistics";
import { scanUniverse } from "./scanner";

/** Canonical `Timeframe` declaration order — mirrors spec-25's ordering. */
const TF_ORDER: Record<Timeframe, number> = {
  "1m": 0, "3m": 1, "5m": 2, "15m": 3, "30m": 4, "1h": 5, "2h": 6, "4h": 7,
  "6h": 8, "12h": 9, "1D": 10, "1W": 11, "1M": 12,
};

const SCOREABLE: ReadonlySet<SetupStatus> = new Set(["confirmed", "active", "partial_target"]);

/** Spec-10 role order — fixed iteration, no reliance on caller key order (spec 31 §8). */
const FRAME_ROLES = ["htf", "itf", "etf"] as const satisfies readonly FrameRole[];

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Spec-11 terminal status → spec-26 outcome bucket (the setup's status IS the outcome). */
const outcomeBucket = (s: Setup): keyof BacktestAggregate["outcomeCounts"] | undefined =>
  s.status === "target_reached" ? "target"
  : s.status === "invalidated" ? "stop"
  : s.status === "expired" ? "expired"
  : s.status === "cancelled" ? "cancelled"
  : undefined;

/** Selection dims — spec-25 membership semantics; absent dim = unconstrained. */
const passesFilters = (o: { symbol: string; timeframe: Timeframe; setupType: SetupType; direction: Direction; status: SetupStatus; score: number }, f?: ScanFilters): boolean => {
  if (!f) return true;
  const allow = <T>(dims: T[] | undefined, v: T) => dims === undefined || dims.includes(v);
  return (
    allow(f.symbols, o.symbol) &&
    allow(f.timeframes, o.timeframe) &&
    allow(f.setupTypes, o.setupType) &&
    allow(f.directions, o.direction) &&
    allow(f.statuses, o.status) &&
    (f.minScore === undefined || o.score >= f.minScore)
  );
};

export function runBacktest(input: {
  cells: BacktestCell[];
  window?: BacktestWindow;
  selection?: BacktestSelection;
  runId?: string;
  config: EngineConfig;
}): EngineResult<SystemBacktestResult> {
  const { cells, window, selection, runId, config } = input;
  const methodVersion = config.backtest?.methodVersion ?? "";
  const scannerCfg = config.scanner ?? { topK: 0, includeDeveloping: false, methodVersion: "v1-scan" };
  /** Spec-24 documented defaults when `stats` is absent — mirrors the scanner fallback. */
  const statsCfg = config.stats ?? { minSamples: 30, scoreBands: [0, 50, 70, 85], methodVersion: "v1-empirical" };
  /** Approved grammar — scanner-owned params only. */
  const paramsVersion = `sel${selection?.filters ? "f" : "nof"}|tk${selection?.topK ?? "*"}`;

  const fail = (code: EngineError["code"], message: string): EngineResult<SystemBacktestResult> => ({
    ok: false,
    errors: [{ code, message }],
    meta: {
      stage: "system-backtest", paramsVersion,
      barsConsumed: { from: -1, to: -1 }, events: [],
    },
  });
  if (!methodVersion) return fail("invalid_config", "config.backtest.methodVersion required");

  const pv = config.version; // paramsVersion stamp threaded into every engine call
  const opportunities: BacktestOpportunity[] = [];
  const developing: BacktestDeveloping[] = [];
  const outcomes: SetupOutcome[] = [];
  /** setupId → terminal Setup used for measurement (detection emits final-state setups). */
  const measuredSetupById = new Map<string, Setup>();
  const observedSetupIds = new Set<string>();
  /** Diagnostics counters. */
  const cellsSkipped: string[] = [];
  /** Spec-31: aux frames rejected by validation/timetrame-contract — counted, never fabricated. */
  const mtfFramesSkipped: string[] = [];
  let evaluationsSkipped = 0;
  let evaluationsEmpty = 0;
  let scoreFailures = 0;
  let statsFailures = 0;
  /** Spec-30: spec-24 decision views collected in phase A — one per confirmed setup,
   *  anchored at `confirmBar` (`decisionTime = candles[confirmBar].time`). */
  const decisionById = new Map<string, StatisticalDecision>();
  /** Memoized per-setup evidence — a fixed fact once the decision view exists. */
  const evidenceById = new Map<string, StatisticalEvidence | undefined>();

  /** Spec-30: estimate each setup's evidence once over the GLOBAL resolved-outcome
   *  dataset (spec-24 history is symbol/timeframe-agnostic; global input is required for
   *  cell-order determinism). E1/E2 inside `estimateProbability` do the temporal gating —
   *  rows resolving at/after `decisionTime` (incl. the setup's own) can never enter the
   *  cohort. `insufficient_data` maps to the type-native `unavailable` marker; any other
   *  failure is an honest absence plus a diagnostics count — never fabricated. */
  const evidenceFor = (setupId: string): StatisticalEvidence | undefined => {
    if (evidenceById.has(setupId)) return evidenceById.get(setupId);
    const dec = decisionById.get(setupId);
    let ev: StatisticalEvidence | undefined;
    if (dec !== undefined) {
      const r = estimateProbability({ decision: dec, outcomes, config: statsCfg });
      if (r.ok && r.data !== undefined) ev = { decisionTime: dec.decisionTime, estimate: r.data };
      else if (r.errors.some((e) => e.code === "insufficient_data"))
        ev = { decisionTime: dec.decisionTime, unavailable: "insufficient_data" };
      else statsFailures++; // invalid_config / invalid_input — loud diagnostics, honest absence
    }
    evidenceById.set(setupId, ev);
    return ev;
  };

  // ---- Cells: canonical order symbol ASC → timeframe canonical. ----
  const orderedCells = [...cells].sort(
    (a, b) => a.symbol.localeCompare(b.symbol) || TF_ORDER[a.timeframe] - TF_ORDER[b.timeframe],
  );

  // ---- PHASE A — causal preparation + Model-B outcome measurement (spec 30). Runs
  //      strictly before the evaluation pass so each setup's spec-24 decision view
  //      (confirmBar-anchored) and the resolved-outcome dataset exist when frozen
  //      candidates are emitted (spec-26 freeze rule). E2 (`resolvedAt < τ`) inside the
  //      estimator is the temporal gate — full-series measurement cannot leak future
  //      outcomes into an earlier decision. ----
  const prepareCell = (cell: BacktestCell) => {
    const { symbol, timeframe, series } = cell;
    const candles = series.candles;
    const key = `${symbol}:${timeframe}`;

    // Series validation — spec-01 conventions; malformed → cell skipped, run continues.
    const issues = validateBars([...candles], timeframe).filter((i) => i.severity === "error");
    if (candles.length === 0 || issues.length > 0) { cellsSkipped.push(key); return undefined; }
    const n = candles.length;

    // Batch upstream artifacts once — `*StateAt(t)` reconstructs PIT views from them.
    const swingsRes = detectSwings(candles, symbol, timeframe, config.swing, pv);
    const structureRes = analyzeStructure(candles, swingsRes.swings, symbol, timeframe, config.structure, pv);
    const poolsRes = analyzeLiquidity(candles, structureRes.structure, symbol, timeframe, config.liquidity, pv);

    // Spec-31/33 — MTF frame pre-pass: validate + batch each supplied frame BEFORE the
    // cell's zone batch, because zones consume the HTF context provider (spec-05
    // confluence / spec-10 "HTF elements consumed"). Each aux frame gets the full
    // upstream chain so its FrameSource.at supplies a complete FrameSnapshot
    // (structure/momentum/liquidity/zones/imbalances/events). Analysis is eager over the
    // full frame series; causality is enforced by closedIndexAt inside the join (spec-10
    // closed-bar rule), never by truncation. Skips keep the spec-31 diagnostic grammar.
    const auxSrc: Partial<Record<FrameRole, FrameSource>> = {};
    let auxValid = 0;
    for (const role of FRAME_ROLES) {
      const roleTf = config.mtf.set[role] as Timeframe;
      if (!(roleTf in TF_ORDER)) {
        mtfFramesSkipped.push(`${key}:${role}`); // unknown timeframe in config.mtf.set
        continue;
      }
      if (roleTf === timeframe) {
        // The cell's own series is authoritative for its role — a frame supplied for
        // the same role is a caller error (spec-31 R2): ignored with a diagnostic.
        if (cell.frames?.[role] !== undefined) mtfFramesSkipped.push(`${key}:${role}`);
        continue;
      }
      const f = cell.frames?.[role];
      if (f === undefined) continue;
      // Frame contract: declared timeframe must match the role's configured timeframe
      // and the series must pass spec-01 validation — else skipped + counted.
      const bad =
        f.timeframe !== roleTf ||
        f.candles.length === 0 ||
        validateBars([...f.candles], roleTf).some((i) => i.severity === "error");
      if (bad) { mtfFramesSkipped.push(`${key}:${role}`); continue; }
      const fSwings = detectSwings(f.candles, symbol, roleTf, config.swing, pv);
      const fStructure = analyzeStructure(f.candles, fSwings.swings, symbol, roleTf, config.structure, pv);
      const fPools = analyzeLiquidity(f.candles, fStructure.structure, symbol, roleTf, config.liquidity, pv);
      const fZones = analyzeZones(f.candles, fStructure.structure, fPools.pools, symbol, roleTf, config.zone, pv);
      const fImbs = analyzeImbalances(f.candles, symbol, roleTf, config.fvg, pv);
      const fEvents = [
        ...fSwings.events, ...fStructure.events, ...fPools.events,
        ...fZones.events, ...fImbs.events,
      ];
      auxSrc[role] = {
        timeframe: roleTf,
        candles: f.candles,
        at: (idx) => ({
          structure: structureStateAt(f.candles, fSwings.swings, symbol, roleTf, config.structure, pv, idx),
          momentum: momentumStateAt(f.candles, symbol, roleTf, config.momentum, pv, idx),
          liquidity: liquidityStateAt(f.candles, fStructure.structure, symbol, roleTf, config.liquidity, pv, idx),
          zones: zoneStateAt(f.candles, fStructure.structure, fPools.pools, symbol, roleTf, config.zone, pv, idx),
          imbalances: imbalanceStateAt(f.candles, symbol, roleTf, config.fvg, pv, idx),
          events: fEvents.filter((e) => e.atBar <= idx),
        }),
      };
      auxValid++;
    }

    // Spec-33 — HTF context for the cell's zones (spec-05 `htfConfluence`, spec-10
    // `htfAligned`/`htfConflict`). Only an aux-supplied HTF frame counts: when the cell
    // itself serves the htf role there is no higher timeframe — the provider stays absent
    // and the feature redistributes. `undefined` on insufficient history = honest absence.
    const htfSrc = auxSrc.htf;
    const htfAt: ZoneHtfProvider | undefined =
      htfSrc === undefined ? undefined : (() => {
        const ctxCache = new Map<number, ReturnType<ZoneHtfProvider>>();
        return (asOfMs) => {
          const idx = closedIndexAt(htfSrc.candles, htfSrc.timeframe, asOfMs);
          if (idx < 0) return undefined;
          if (ctxCache.has(idx)) return ctxCache.get(idx);
          const snap = htfSrc.at(idx);
          const ctx = snap === null || (snap.zones === undefined && snap.structure === undefined)
            ? undefined
            : { zones: snap.zones, structure: snap.structure };
          ctxCache.set(idx, ctx);
          return ctx;
        };
      })();

    const zonesRes = analyzeZones(
      candles, structureRes.structure, poolsRes.pools, symbol, timeframe, config.zone, pv,
      undefined, htfAt,
    );
    const imbsRes = analyzeImbalances(candles, symbol, timeframe, config.fvg, pv);
    const upstreamEvents = [
      ...swingsRes.events, ...structureRes.events, ...poolsRes.events,
      ...zonesRes.events, ...imbsRes.events,
    ];

    // The cell's own role frame supplies only the vote slice — its element slots are
    // already delivered to consumers via `snap.pools/zones/imbalances` (same objects),
    // so duplicating them inside the frame view would be unobserved and quadratically
    // expensive (spec-33: slots optional; consumers read OTHER roles' elements).
    // `cellFrameAt` deliberately does NOT reuse `at` — the join calls `FrameSource.at`;
    // reusing `at` would recurse (spec-31).
    const cellFrameAt = (idx: number) => ({
      structure: structureStateAt(candles, swingsRes.swings, symbol, timeframe, config.structure, pv, idx),
      momentum: momentumStateAt(candles, symbol, timeframe, config.momentum, pv, idx),
    });
    const emptyFrame = (tf: Timeframe): FrameSource => ({ timeframe: tf, candles: [], at: () => null });
    const mtfRoles = (() => {
      const roles = {} as Record<FrameRole, FrameSource>;
      for (const role of FRAME_ROLES) {
        const roleTf = config.mtf.set[role] as Timeframe;
        if (!(roleTf in TF_ORDER)) { roles[role] = emptyFrame(roleTf); continue; }
        if (roleTf === timeframe) { roles[role] = { timeframe, candles, at: cellFrameAt }; continue; }
        roles[role] = auxSrc[role] ?? emptyFrame(roleTf);
      }
      // No valid supplied frame ⇒ no alignment at all — absent `frames` must be
      // bit-identical to baseline (spec-31 §8); a missing role inside a composed run
      // degrades through the producer's honest vote-0 path instead.
      return auxValid > 0 ? roles : undefined;
    })();

    /** The causal join — every field strictly at closed bar `t`. Spec-29: `regime` is
     *  part of the join (spec 27 producer over the t-snapshots) — it flows into
     *  `ScoringSnapshot.regime` via the `...at(t)` spread and into `SetupOutcome.regime`
     *  at `confirmBar`. Spec-31: `alignment` is the spec-10 producer over per-role
     *  causal providers, anchored at `barCloseTime(candles[t])` — it flows into the
     *  declared detector-input and `ScoringSnapshot` slots via the same spread. */
    const at = (t: number) => {
      const structure = structureStateAt(candles, swingsRes.swings, symbol, timeframe, config.structure, pv, t);
      const momentum = momentumStateAt(candles, symbol, timeframe, config.momentum, pv, t);
      return {
        structure,
        pools: liquidityStateAt(candles, structureRes.structure, symbol, timeframe, config.liquidity, pv, t),
        zones: zoneStateAt(candles, structureRes.structure, poolsRes.pools, symbol, timeframe, config.zone, pv, t, htfAt),
        imbalances: imbalanceStateAt(candles, symbol, timeframe, config.fvg, pv, t),
        momentum,
        regime: regimeStateAt(structure, momentum.features, config.regime),
        events: upstreamEvents.filter((e) => e.atBar <= t),
        ...(mtfRoles !== undefined
          ? {
              // Spec-33: the join itself is the consumer-facing payload — joined frames
              // carry pools/zones/imbalances/events for spec-10 consumers (scoring reads
              // htf pools via ScoringSnapshot.frames). causalAlignAt keeps its internal
              // join — the producer contract is unchanged.
              alignment: causalAlignAt(symbol, mtfRoles, config.mtf.weights, barCloseTime(candles[t], timeframe)).alignment,
              frames: causalFramesAt(mtfRoles, barCloseTime(candles[t], timeframe)),
            }
          : {}),
      };
    };

    // Detection — three families over the full cell series; causality is internal via `at`.
    const detInputs = { candles, symbol, timeframe, at };
    const rev = detectReversals({ ...detInputs, config: { lifecycle: config.lifecycle, reversal: config.reversal } });
    const brk = detectBreakouts({ ...detInputs, config: { lifecycle: config.lifecycle, breakout: config.breakout } });
    const cnt = detectContinuations({ ...detInputs, config: { lifecycle: config.lifecycle, continuation: config.continuation } });
    const setups = [...rev.setups, ...brk.setups, ...cnt.setups];
    const transitions = [...rev.events, ...brk.events, ...cnt.events]
      .filter((e) => e.kind === "setup_transition")
      .sort((a, b) => a.atBar - b.atBar);

    // setupId → transitions (ascending) for status-at-T derivation.
    const transById = new Map<string, { atBar: number; to: SetupStatus }[]>();
    for (const e of transitions) {
      const to = (e.metadata as { to?: SetupStatus } | undefined)?.to;
      if (to === undefined) continue;
      (transById.get(e.refId) ?? transById.set(e.refId, []).get(e.refId)!).push({ atBar: e.atBar, to });
    }
    /** Exists at t: candidateBar stamped, else first transition, else createdAt ≤ close. */
    const existsAt = (s: Setup, t: number): boolean => {
      const cb = num(s.metadata?.candidateBar);
      if (cb !== undefined) return cb <= t;
      const ev = transById.get(s.id);
      if (ev !== undefined && ev.length > 0) return ev[0].atBar <= t;
      const created = Date.parse(s.createdAt);
      return Number.isFinite(created) && created <= candles[t].time;
    };
    /** Status at t: last `setup_transition` ≤ t, else `developing` (initial state). */
    const statusAt = (s: Setup, t: number): SetupStatus => {
      const ev = transById.get(s.id);
      if (!ev) return "developing";
      let st: SetupStatus = "developing";
      for (const tr of ev) { if (tr.atBar > t) break; st = tr.to; }
      return st;
    };

    // ---- Evaluation window (spec-18 clamping semantics). ----
    const t0 = Math.max(0, window?.startIndex ?? 0);
    const t1 = Math.min(n - 1, window?.endIndex ?? n - 1);
    if (t0 > t1) { cellsSkipped.push(key); return undefined; }

    for (const s of setups) {
      if (existsAt(s, Math.min(t1, n - 1))) observedSetupIds.add(s.id);
      measuredSetupById.set(s.id, s);
    }

    // ---- OUTCOME PASS (Model B) — full-series measurement; spec-17 eligibility is
    //      measureOutcome's own gate: never-confirmed → not-ok → no row, no fabrication.
    //      The spec-24 decision view is collected alongside — same confirmBar anchors
    //      spec-29 already established, nothing recomputed. ----
    for (const s of setups) {
      if (!observedSetupIds.has(s.id)) continue; // only setups the system actually observed
      const cb = num(s.metadata?.confirmBar);
      const db = num(s.metadata?.candidateBar);
      let scoreAtConfirmation: number | undefined;
      let contributions: ScoreContribution[] | undefined;
      let confirmedRegime: RegimeLabel | undefined;
      let scoreAtDetection: number | undefined;
      let features: OutcomeFeatureBundle | undefined;
      if (cb !== undefined && cb >= 0 && cb < n) {
        const cbJoin = at(cb); // single causal join per setup — scoring, regime, features
        const r = scoreOpportunity({
          setup: { ...s, status: "confirmed" }, atBar: cb, atMs: candles[cb].time,
          snap: { provenance: "at_bar", ...cbJoin },
          config: config.scoring,
        });
        if (r.ok && r.data !== undefined) { scoreAtConfirmation = r.data.score; contributions = r.data.contributions; }
        confirmedRegime = cbJoin.regime; // outcome row anchors regime at confirmBar (spec 29)
        // Spec-35 — the spec-17 featureVector classes, all resolved from the same
        // confirmBar join (no recompute). Anchor zone via the scoring convention
        // (zoneIds[0] → metadata.zoneId) against the cb-visible zone set; absent
        // anchor (breakout) or absent slice ⇒ honest key omission downstream.
        const anchorZoneId = s.zoneIds?.[0] ?? (s.metadata?.zoneId as string | undefined);
        features = {
          swing: {
            leftBars: config.swing.leftBars,
            rightBars: config.swing.rightBars,
            atrLength: config.swing.atrLength,
            minSignificanceAtr: config.swing.minSignificanceAtr,
            equalToleranceAtr: config.swing.equalToleranceAtr,
            mergeEqual: config.swing.mergeEqual,
          },
          zone: anchorZoneId === undefined ? undefined : cbJoin.zones?.find((z) => z.id === anchorZoneId),
          momentum: cbJoin.momentum,
          alignment: cbJoin.alignment,
        };
      }
      if (db !== undefined && db >= 0 && db < n) {
        // spec-17 `scoreAtDetection`: the causal scoring path at candidateBar — same
        // scoreable-status convention as scoreAtConfirmation; a gate → undefined.
        const r = scoreOpportunity({
          setup: { ...s, status: "confirmed" }, atBar: db, atMs: candles[db].time,
          snap: { provenance: "at_bar", ...at(db) },
          config: config.scoring,
        });
        if (r.ok && r.data !== undefined) scoreAtDetection = r.data.score;
      }
      // Spec-30 decision view — what was knowable at confirmBar; a gated confirmation
      // score leaves the view incomplete → no decision → evidence stays honestly absent.
      if (cb !== undefined && cb >= 0 && cb < n && scoreAtConfirmation !== undefined) {
        decisionById.set(s.id, {
          setupType: s.type,
          direction: s.direction,
          regime: confirmedRegime,
          scoreAtConfirmation,
          decisionTime: candles[cb].time,
          paramsVersion: pv,
        });
      }
      const res = measureOutcome({
        setup: s,
        candles, // unbounded below endIndex — full historical outcome (Model B)
        scoreAtConfirmation,
        scoreAtDetection,
        contributions,
        regime: confirmedRegime,
        features,
        paramsVersion: pv,
      });
      if (!res.ok || res.data === undefined) continue; // spec-17 declined → no row
      outcomes.push(res.data);
    }
    return { symbol, timeframe, candles, setups, at, existsAt, statusAt, t0, t1, hasMtf: mtfRoles !== undefined };
  };

  const cellCtxs: NonNullable<ReturnType<typeof prepareCell>>[] = [];
  for (const cell of orderedCells) {
    const ctx = prepareCell(cell);
    if (ctx !== undefined) cellCtxs.push(ctx); // skipped cells produce no context at all
  }

  // ---- PHASE B — EVALUATION PASS: records frozen per t; nothing later may touch them. ----
  for (const ctx of cellCtxs) {
    const { symbol, timeframe, candles, setups, at, existsAt, statusAt, t0, t1, hasMtf } = ctx;
    for (let t = t0; t <= t1; t++) {
      const asOf = candles[t].time; // asOf = Candle.time[t] — UnixMs, never the index
      /** Spec-34: one causal join per bar, shared by scoring and record emission —
       *  `alignment` on a record is the same `at(t)` object the scorer consumed. */
      let join: ReturnType<typeof at> | undefined;
      const joinAt = () => (join ??= at(t));
      const candidates: ScanCandidate[] = [];
      for (const s of setups) {
        if (!existsAt(s, t)) continue;
        const st = statusAt(s, t);
        const setupAtT: Setup = { ...s, status: st };
        let score = {};
        let plan: ScanPlan | undefined;
        if (SCOREABLE.has(st)) {
          const r = scoreOpportunity({
            setup: setupAtT, atBar: t, atMs: asOf,
            snap: { provenance: "at_bar", ...joinAt() },
            config: config.scoring,
          });
          if (r.ok && r.data !== undefined) {
            score = r.data;
            // Spec-16 plan exists only for scoreable statuses; a gated/empty score
            // degrades to absent — the scanner receives it as a pass-through artifact.
            const tp = planStateAt(setupAtT, r.data, t, config.lifecycle);
            if (tp !== undefined) plan = toScanPlan(tp);
          } else scoreFailures++;
        }
        candidates.push({
          setup: setupAtT,
          score,
          plan,
          // Spec-30: confirmBar-anchored evidence — only meaningful for scoreable
          // statuses (developing candidates carry no decision view).
          statisticalEvidence: SCOREABLE.has(st) ? evidenceFor(s.id) : undefined,
          cell: { symbol, timeframe },
          provenance: { evaluatedAt: asOf, evaluatedBar: t },
        });
      }
      if (candidates.length === 0) { evaluationsEmpty++; continue; }
      const scan = scanUniverse({
        asOf,
        universe: { symbols: [symbol], timeframes: [timeframe] },
        candidates,
        config: scannerCfg,
      });
      if (!scan.ok || scan.data === undefined) { evaluationsSkipped++; continue; }
      // Spec-34: the frozen PIT alignment observation - the same `at(t)` object the
      // scorer consumed, stamped at emit. `hasMtf` gates the join on framed cells only;
      // unframed records omit the key entirely (parity - absence, never null).
      const recAlignment = hasMtf ? joinAt().alignment : undefined;
      for (const o of scan.data.ranked) {
        const rec: BacktestOpportunity = {
          setupId: o.setupId,
          symbol: o.symbol,
          timeframe: o.timeframe,
          setupType: o.setupType,
          direction: o.direction,
          status: o.status,
          evaluatedAt: asOf,
          evaluatedIndex: t,
          rank: o.rank,
          score: o.score,
          scoreContributions: o.scoreContributions,
          plan: o.entry !== undefined || o.stopLoss !== undefined || o.targets !== undefined
            ? { entry: o.entry, stopLoss: o.stopLoss, targets: o.targets, riskReward: o.riskReward }
            : undefined,
          statisticalEvidence: o.statisticalEvidence,
          ...(recAlignment !== undefined ? { alignment: recAlignment } : {}),
        };
        if (selection !== undefined) {
          rec.selected =
            (selection.topK === undefined || rec.rank <= selection.topK) &&
            passesFilters(rec, selection.filters);
        }
        opportunities.push(rec);
      }
      for (const d of scan.data.developing) {
        developing.push({
          setupId: d.setupId,
          symbol: d.symbol,
          timeframe: d.timeframe,
          setupType: d.setupType,
          direction: d.direction,
          evaluatedAt: asOf,
          evaluatedIndex: t,
          reasons: d.reasons,
          ...(recAlignment !== undefined ? { alignment: recAlignment } : {}),
        });
      }
    }
  }

  // ---- outcomeRef — the ONLY post-emit field (spec 26); rows were measured in phase A,
  //      records in phase B, so the join stamps afterwards. Identical observable result. ----
  for (const row of outcomes) {
    for (const o of opportunities) if (o.setupId === row.setupId) o.outcomeRef = row.setupId;
    for (const d of developing) if (d.setupId === row.setupId) d.outcomeRef = row.setupId;
  }

  // ---- Canonical record ordering: (symbol, timeframe, evaluatedIndex, rank / setupId). ----
  const cellOrder = (a: { symbol: string; timeframe: Timeframe; evaluatedIndex: number }) =>
    `${a.symbol}:${TF_ORDER[a.timeframe]}:${a.evaluatedIndex}`;
  opportunities.sort(
    (a, b) =>
      a.symbol.localeCompare(b.symbol) ||
      TF_ORDER[a.timeframe] - TF_ORDER[b.timeframe] ||
      a.evaluatedIndex - b.evaluatedIndex ||
      a.rank - b.rank,
  );
  developing.sort(
    (a, b) => cellOrder(a).localeCompare(cellOrder(b)) || a.setupId.localeCompare(b.setupId),
  );
  outcomes.sort((a, b) => a.setupId.localeCompare(b.setupId));

  // ---- Aggregation — populations keyed on unique setups for outcome metrics. ----
  const outcomeBySetup = new Map<string, SetupOutcome>();
  for (const o of outcomes) outcomeBySetup.set(o.setupId, o);
  const aggregateFor = (setupFilter?: (s: Setup) => boolean): BacktestAggregate => {
    const ids = new Set(
      [...opportunities, ...developing]
        .filter((r) => {
          const s = measuredSetupById.get(r.setupId);
          return s !== undefined && (setupFilter === undefined || setupFilter(s));
        })
        .map((r) => r.setupId),
    );
    const counts = { target: 0, stop: 0, expired: 0, cancelled: 0, unresolved: 0 };
    const rs: number[] = [];
    let resolved = 0;
    for (const id of ids) {
      const row = outcomeBySetup.get(id);
      if (row === undefined) { counts.unresolved++; continue; }
      const bucket = outcomeBucket(measuredSetupById.get(id)!);
      if (row.unresolved === true || bucket === undefined) { counts.unresolved++; continue; }
      counts[bucket]++;
      resolved++;
      if (row.rMultiple !== undefined) rs.push(row.rMultiple);
    }
    const obs = opportunities.filter((r) => {
      const s = measuredSetupById.get(r.setupId);
      return s !== undefined && (setupFilter === undefined || setupFilter(s));
    });
    const devs = developing.filter((r) => {
      const s = measuredSetupById.get(r.setupId);
      return s !== undefined && (setupFilter === undefined || setupFilter(s));
    });
    const rate = (x: number) => (resolved > 0 ? x / resolved : undefined);
    const sortedR = [...rs].sort((a, b) => a - b);
    const agg: BacktestAggregate = {
      observationCount: obs.length,
      developingObservationCount: devs.length,
      uniqueSetupCount: ids.size,
      selectedObservationCount: obs.filter((r) => r.selected === true).length,
      resolvedOutcomeCount: resolved,
      outcomeCounts: counts,
      targetOutcomeRate: rate(counts.target),
      stopRate: rate(counts.stop),
      expiredRate: rate(counts.expired),
      expectancyR: rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : undefined,
      medianR:
        sortedR.length === 0 ? undefined
        : sortedR.length % 2 === 1 ? sortedR[(sortedR.length - 1) / 2]
        : (sortedR[sortedR.length / 2 - 1] + sortedR[sortedR.length / 2]) / 2,
      totalR: rs.length > 0 ? rs.reduce((a, b) => a + b, 0) : undefined,
    };
    return agg;
  };
  const aggregate = aggregateFor();
  const types = new Set([...measuredSetupById.values()].map((s) => s.type));
  if (types.size > 0) {
    aggregate.bySetupType = {};
    for (const ty of types) aggregate.bySetupType[ty] = aggregateFor((s) => s.type === ty);
  }
  const dirs = new Set([...measuredSetupById.values()].map((s) => s.direction));
  if (dirs.size > 0) {
    aggregate.byDirection = {};
    for (const d of dirs) aggregate.byDirection[d] = aggregateFor((s) => s.direction === d);
  }

  const result: SystemBacktestResult = {
    runId,
    cells: orderedCells.map((c) => ({ symbol: c.symbol, timeframe: c.timeframe })),
    window,
    opportunities,
    developing,
    outcomes,
    aggregate,
    versions: { methodVersion, paramsVersion, configVersion: config.version },
  };
  return {
    ok: true,
    data: result,
    errors: [],
    meta: {
      stage: "system-backtest",
      paramsVersion,
      barsConsumed: { from: window?.startIndex ?? 0, to: window?.endIndex ?? -1 },
      events: [],
      diagnostics: {
        cellsIn: cells.length,
        cellsSkipped: cellsSkipped.join(","),
        mtfFramesSkipped: mtfFramesSkipped.join(","),
        evaluationsSkipped,
        evaluationsEmpty,
        scoreFailures,
        statsFailures,
        opportunities: opportunities.length,
        developing: developing.length,
        outcomes: outcomes.length,
        evaluationsAllEmpty: opportunities.length === 0 && developing.length === 0,
      },
    },
  };
}

/** Contract adapter (spec 20 `BacktestEngine`). */
export function createBacktestEngine(): BacktestEngine {
  return { run: (input) => runBacktest(input) };
}
