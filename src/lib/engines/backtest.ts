/**
 * Phase 9 — System-Level Historical Backtesting & Validation (docs/engine/26).
 *
 * A thin orchestration + recording + aggregation layer — NOT a trade simulator. Per cell it
 * composes the existing causal machinery end-to-end:
 *
 *   batch-detected upstream artifacts → per-bar `*StateAt` providers → three detectors
 *   → status-at-T from `setup_transition` events → PIT scoring → spec-25 scanner at
 *   `asOf = candle.time[t]` → frozen records → post-window spec-17 `measureOutcome`
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
  ScanCandidate,
  ScanFilters,
  ScoreContribution,
  Setup,
  SetupOutcome,
  SetupStatus,
  SetupType,
  SystemBacktestResult,
  Timeframe,
} from "@/lib/types";
import type { EngineError, EngineResult, BacktestEngine } from "@/lib/services/engine";
import { validateBars } from "@/lib/market-data/validation";
import { detectSwings } from "./swing";
import { analyzeStructure, structureStateAt } from "./structure";
import { analyzeLiquidity, liquidityStateAt } from "./liquidity";
import { analyzeZones, zoneStateAt } from "./zones";
import { analyzeImbalances, imbalanceStateAt } from "./imbalances";
import { momentumStateAt } from "./momentum";
import { detectReversals } from "./reversal";
import { detectBreakouts } from "./breakout";
import { detectContinuations } from "./continuation";
import { scoreOpportunity } from "./scoring";
import { measureOutcome } from "./outcomes";
import { scanUniverse } from "./scanner";

/** Canonical `Timeframe` declaration order — mirrors spec-25's ordering. */
const TF_ORDER: Record<Timeframe, number> = {
  "1m": 0, "3m": 1, "5m": 2, "15m": 3, "30m": 4, "1h": 5, "2h": 6, "4h": 7,
  "6h": 8, "12h": 9, "1D": 10, "1W": 11, "1M": 12,
};

const SCOREABLE: ReadonlySet<SetupStatus> = new Set(["confirmed", "active", "partial_target"]);

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
  let evaluationsSkipped = 0;
  let evaluationsEmpty = 0;
  let scoreFailures = 0;

  // ---- Cells: canonical order symbol ASC → timeframe canonical. ----
  const orderedCells = [...cells].sort(
    (a, b) => a.symbol.localeCompare(b.symbol) || TF_ORDER[a.timeframe] - TF_ORDER[b.timeframe],
  );

  for (const cell of orderedCells) {
    const { symbol, timeframe, series } = cell;
    const candles = series.candles;
    const key = `${symbol}:${timeframe}`;

    // Series validation — spec-01 conventions; malformed → cell skipped, run continues.
    const issues = validateBars([...candles], timeframe).filter((i) => i.severity === "error");
    if (candles.length === 0 || issues.length > 0) { cellsSkipped.push(key); continue; }
    const n = candles.length;

    // Batch upstream artifacts once — `*StateAt(t)` reconstructs PIT views from them.
    const swingsRes = detectSwings(candles, symbol, timeframe, config.swing, pv);
    const structureRes = analyzeStructure(candles, swingsRes.swings, symbol, timeframe, config.structure, pv);
    const poolsRes = analyzeLiquidity(candles, structureRes.structure, symbol, timeframe, config.liquidity, pv);
    const zonesRes = analyzeZones(candles, structureRes.structure, poolsRes.pools, symbol, timeframe, config.zone, pv);
    const imbsRes = analyzeImbalances(candles, symbol, timeframe, config.fvg, pv);
    const upstreamEvents = [
      ...swingsRes.events, ...structureRes.events, ...poolsRes.events,
      ...zonesRes.events, ...imbsRes.events,
    ];

    /** The causal join — every field strictly at closed bar `t`. */
    const at = (t: number) => ({
      structure: structureStateAt(candles, swingsRes.swings, symbol, timeframe, config.structure, pv, t),
      pools: liquidityStateAt(candles, structureRes.structure, symbol, timeframe, config.liquidity, pv, t),
      zones: zoneStateAt(candles, structureRes.structure, poolsRes.pools, symbol, timeframe, config.zone, pv, t),
      imbalances: imbalanceStateAt(candles, symbol, timeframe, config.fvg, pv, t),
      momentum: momentumStateAt(candles, symbol, timeframe, config.momentum, pv, t),
      events: upstreamEvents.filter((e) => e.atBar <= t),
    });

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
    if (t0 > t1) { cellsSkipped.push(key); continue; }

    // ---- EVALUATION PASS — records frozen per t; nothing later may touch them. ----
    for (let t = t0; t <= t1; t++) {
      const asOf = candles[t].time; // asOf = Candle.time[t] — UnixMs, never the index
      const candidates: ScanCandidate[] = [];
      for (const s of setups) {
        if (!existsAt(s, t)) continue;
        const st = statusAt(s, t);
        const setupAtT: Setup = { ...s, status: st };
        let score = {};
        if (SCOREABLE.has(st)) {
          const r = scoreOpportunity({
            setup: setupAtT, atBar: t, atMs: asOf,
            snap: { provenance: "at_bar", ...at(t) },
            config: config.scoring,
          });
          if (r.ok && r.data !== undefined) score = r.data; else scoreFailures++;
        }
        candidates.push({
          setup: setupAtT,
          score,
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
        });
      }
    }
    for (const s of setups) {
      if (existsAt(s, Math.min(t1, n - 1))) observedSetupIds.add(s.id);
      measuredSetupById.set(s.id, s);
    }

    // ---- OUTCOME PASS (Model B) — strictly after evaluation; spec-17 eligibility is
    //      measureOutcome's own gate: never-confirmed → not-ok → no row, no fabrication. ----
    for (const s of setups) {
      if (!observedSetupIds.has(s.id)) continue; // only setups the system actually observed
      const cb = num(s.metadata?.confirmBar);
      let scoreAtConfirmation: number | undefined;
      let contributions: ScoreContribution[] | undefined;
      if (cb !== undefined && cb >= 0 && cb < n) {
        const r = scoreOpportunity({
          setup: { ...s, status: "confirmed" }, atBar: cb, atMs: candles[cb].time,
          snap: { provenance: "at_bar", ...at(cb) },
          config: config.scoring,
        });
        if (r.ok && r.data !== undefined) { scoreAtConfirmation = r.data.score; contributions = r.data.contributions; }
      }
      const res = measureOutcome({
        setup: s,
        candles, // unbounded below endIndex — full historical outcome (Model B)
        scoreAtConfirmation,
        contributions,
        paramsVersion: pv,
      });
      if (!res.ok || res.data === undefined) continue; // spec-17 declined → no row
      outcomes.push(res.data);
      const ref = res.data.setupId;
      for (const o of opportunities) if (o.setupId === s.id) o.outcomeRef = ref;
      for (const d of developing) if (d.setupId === s.id) d.outcomeRef = ref;
    }
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
        evaluationsSkipped,
        evaluationsEmpty,
        scoreFailures,
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
