"use client";

/**
 * Historical Validation workspace — evaluates canonical engine scenarios
 * against subsequent candles from user-uploaded OHLC data. Zero-budget: no
 * external data services, no persistence, honest result framing throughout.
 *
 * The warnings panel deliberately renders ABOVE the metrics: incomplete or
 * biased results must never read as validated performance.
 */
import { useState } from "react";
import { FileUp, Download } from "lucide-react";
import type { Timeframe } from "@/lib/types";
import { TIMEFRAME_MS } from "@/lib/market-data/timeframes";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";

const TIMEFRAMES = [...Object.keys(TIMEFRAME_MS), "1M"] as Timeframe[];

// Mirror of the API contract — kept local so the UI can never drift silently.
interface ScenarioRow {
  setupId: string; setupType: string; direction: string;
  anchorBar: number; anchorTime: string;
  scenario: { entryBandLow: number; entryBandHigh: number; invalidation: number; targets: number[] };
  scoreAtConfirmation?: number;
  status: string; statusReason?: string;
  entryPrice?: number; initialRisk?: number;
  resolvedAt?: string; barsToActive?: number | null; targetsReached?: number;
  grossR?: number; costR?: number; netR?: number; mfeR?: number; maeR?: number;
  baselineR?: number; overlapsNext?: boolean;
}
interface CI { method: string; confidence: number; point: number; lower: number; upper: number; n: number; denominator: string; dependenceHandling?: string; bootstrap?: { resamples: number; blockLen: number; seed: number; resamplingUnit: string }; caveat?: string }
interface Agg {
  scenarioCount: number; excludedCount: number;
  counts: Record<string, number>;
  filledCount: number; wins: number; losses: number; breakevens: number;
  realizedCount: number; realizedWins: number; realizedLosses: number; realizedBreakevens: number;
  mtmCount: number; mtmWins: number; mtmLosses: number; mtmBreakevens: number;
  realizedWinRate?: number; realizedExpectancyR?: number; mtmMeanR?: number;
  expectancyR?: number; grossExpectancyR?: number; medianR?: number;
  totalR?: number; maxDrawdownR?: number; meanBaselineR?: number;
  uncertainty?: { winRate?: CI; expectancyR?: CI; notes: string[] };
  dependence?: { uniqueAnchors: number; overlappingPairs: number; overlappingWindows: number; clusters: number; largestCluster: number };
  overlappingWindows?: number;
}
interface CostCase {
  label: string; costs?: { feeBps?: number; slippageBps?: number; slippagePoints?: number };
  aggregate: Agg; expectancyDeltaR?: number; signFlips: number; expectancySignChange: boolean;
}
interface HorizonCase {
  horizonBars: number; aggregate: Agg;
  statusTransitions: Record<string, number>; changedCount: number;
}
interface PurgedCohort {
  rule: string; retainedCount: number; purgedCount: number; purgedSetupIds: string[];
  purgeReasons?: { setupId: string; intoCohort: string; barsIntoLaterCohort: number }[];
  aggregate?: Agg; unavailableReason?: string;
}
interface BoundaryReport {
  boundaryIndex: number; toCohort: string;
  /** Verbatim boundary definition — never infer it in the UI. */
  basis?: string;
  boundaryAnchorBar?: number; boundaryBar?: number; boundaryTime?: string;
  perSeries?: { series: string; boundaryAnchorBar: number; boundaryTime?: string; laterScenarioCount: number }[];
  earlierEvaluableCount: number; unverifiableCount?: number;
  contaminatedCount: number; contaminatedPct?: number;
  affectedAnchors: number; laterBarsTouched?: number;
  contamination: { setupId: string; scenarioIndex: number; fromCohort: string; series?: string; anchorBar: number; resolvedBar: number; boundaryAnchorBar?: number; barsIntoLaterCohort: number }[];
  status: "clean" | "leakage_detected" | "indeterminate"; note?: string;
}
interface Result {
  contractVersion: string; fingerprint: string;
  datasets: { symbol: string; timeframe: string; bars: number; firstBar: string; lastBar: string }[];
  scenarioCount: number; scenarios: ScenarioRow[];
  aggregate: Agg;
  splits?: { name: string; anchorFrom?: string; anchorTo?: string; aggregate: Agg; purged?: PurgedCohort }[];
  walkForward?: { boundaries: BoundaryReport[]; status: "clean" | "purged" | "leakage_detected" | "indeterminate"; notes: string[] };
  sensitivity?: { costs?: CostCase[]; horizons?: HorizonCase[] };
  methodology?: { metricDefinitions: Record<string, string>; uncertaintyMethod: string; cohortBoundaries: string; boundaryPolicy?: string };
  warnings: string[]; assumptions: string[]; evaluatedAt: string;
  configVersion?: string;
  config?: Record<string, unknown>;
}

const num = (v: string): number | undefined => (v.trim() === "" ? undefined : Number(v));
const fmt = (v: number | undefined, d = 2) => (v === undefined ? "—" : v.toFixed(d));

export function HistoricalValidationWorkspace() {
  const [files, setFiles] = useState<File[]>([]);
  const [symbol, setSymbol] = useState("");
  const [anchor, setAnchor] = useState<Timeframe>("1h");
  const [metas, setMetas] = useState<({ timeframe?: Timeframe; is24x7?: boolean })[]>([]);
  const [horizon, setHorizon] = useState("20");
  const [deadline, setDeadline] = useState("");
  const [feeBps, setFeeBps] = useState("0");
  const [slipBps, setSlipBps] = useState("0");
  const [slipPts, setSlipPts] = useState("0");
  const [minScore, setMinScore] = useState("");
  const [useSplit, setUseSplit] = useState(false);
  const [usePurge, setUsePurge] = useState(false);
  const [costCasesRaw, setCostCasesRaw] = useState("");   // "fee,slipBps,slipPts; …"
  const [horizonsRaw, setHorizonsRaw] = useState("");      // "5,15"
  const [comparison, setComparison] = useState<Result | undefined>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<Result | undefined>();

  const pick = (list: FileList | null) => {
    if (!list) return;
    const fs = [...list].slice(0, 4);
    setFiles(fs);
    setMetas(fs.map(() => ({})));
    setResult(undefined);
  };

  const run = async () => {
    if (files.length === 0 || !symbol.trim()) return;
    setRunning(true);
    setError(undefined);
    const form = new FormData();
    for (const f of files) form.append("files", f);
    form.set("meta", JSON.stringify(metas));
    form.set("symbol", symbol.trim().toUpperCase());
    form.set("anchor", anchor);
    const config: Record<string, unknown> = { horizonBars: num(horizon) ?? 20 };
    const dl = num(deadline);
    if (dl !== undefined) config.entryDeadlineBars = dl;
    const costs = { feeBps: num(feeBps), slippageBps: num(slipBps), slippagePoints: num(slipPts) };
    if (Object.values(costs).some((v) => (v ?? 0) > 0)) config.costs = costs;
    const ms = num(minScore);
    if (ms !== undefined) config.minScore = ms;
    if (useSplit) config.split = { trainPct: 0.6, validationPct: 0.2 };
    if (useSplit && usePurge) config.purgeBoundaries = true;
    // Sensitivity grids — user-supplied assumptions only; nothing is invented.
    const costCases = costCasesRaw.split(";").map((s) => s.trim()).filter(Boolean)
      .map((s) => {
        const [f, b, p] = s.split(",").map((x) => Number(x.trim()));
        return { feeBps: f, slippageBps: b, slippagePoints: p };
      })
      .filter((c) => [c.feeBps, c.slippageBps, c.slippagePoints].every((v) => Number.isFinite(v) && v >= 0));
    if (costCases.length > 0) config.costSensitivity = costCases.slice(0, 4);
    const horizons = horizonsRaw.split(",").map((s) => Number(s.trim()))
      .filter((h) => Number.isInteger(h) && h >= 1 && h !== (config.horizonBars as number));
    if (horizons.length > 0) config.horizonSensitivity = [...new Set(horizons)].slice(0, 5);
    form.set("config", JSON.stringify(config));

    try {
      const res = await fetch("/api/import/historical-validation", { method: "POST", body: form });
      const body = (await res.json()) as { result?: Result; error?: { message?: string } };
      if (!res.ok || !body.result) {
        setError(body.error?.message ?? `validation failed (HTTP ${res.status})`);
        setResult(undefined);
        return;
      }
      setResult(body.result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "validation request failed");
    } finally {
      setRunning(false);
    }
  };

  const download = (kind: "json" | "csv") => {
    if (!result) return;
    let blob: Blob;
    let name: string;
    if (kind === "json") {
      blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      name = `validation-${result.fingerprint.slice(0, 8)}.json`;
    } else {
      const head = "setupId,type,direction,anchorTime,status,entryPrice,initialRisk,grossR,costR,netR,mfeR,maeR,baselineR,targetsReached,resolvedAt\n";
      const rows = result.scenarios.map((s) =>
        [s.setupId, s.setupType, s.direction, s.anchorTime, s.status,
          s.entryPrice ?? "", s.initialRisk ?? "", s.grossR ?? "", s.costR ?? "",
          s.netR ?? "", s.mfeR ?? "", s.maeR ?? "", s.baselineR ?? "",
          s.targetsReached ?? "", s.resolvedAt ?? ""].join(","),
      );
      blob = new Blob([head + rows.join("\n")], { type: "text/csv" });
      name = `validation-${result.fingerprint.slice(0, 8)}.csv`;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };

  const agg = result?.aggregate;
  const field = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="1 · Dataset" className="pb-2" />
        <CardContent className="space-y-3 text-sm">
          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-border p-3 text-muted-foreground hover:border-foreground/40">
            <FileUp className="h-4 w-4" />
            {files.length === 0 ? "Choose 1–4 OHLC CSV files…" : files.map((f) => f.name).join(", ")}
            <input type="file" accept=".csv,text/csv" multiple className="hidden"
              onChange={(e) => pick(e.target.files)} />
          </label>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Symbol (required)</label>
              <input className={field} value={symbol} placeholder="BTCUSD"
                onChange={(e) => setSymbol(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Anchor timeframe</label>
              <select className={field} value={anchor}
                onChange={(e) => setAnchor(e.target.value as Timeframe)}>
                {TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
              </select>
            </div>
            {files.map((f, i) => (
              <div key={f.name}>
                <label className="mb-1 block text-xs text-muted-foreground">{f.name} timeframe</label>
                <select className={field} value={metas[i]?.timeframe ?? ""}
                  onChange={(e) => setMetas((m) => m.map((x, j) => j === i
                    ? { ...x, timeframe: (e.target.value || undefined) as Timeframe | undefined } : x))}>
                  <option value="">auto-detect</option>
                  {TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
                </select>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="2 · Evaluation configuration" className="pb-2" />
        <CardContent className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Horizon (bars)</label>
            <input className={field} type="number" min={1} value={horizon} onChange={(e) => setHorizon(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Entry deadline (bars, optional)</label>
            <input className={field} type="number" min={1} value={deadline} onChange={(e) => setDeadline(e.target.value)} placeholder="none" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Fees (bps, round trip)</label>
            <input className={field} type="number" min={0} step="0.1" value={feeBps} onChange={(e) => setFeeBps(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Slippage (bps / points)</label>
            <div className="flex gap-1">
              <input className={field} type="number" min={0} step="0.1" value={slipBps} onChange={(e) => setSlipBps(e.target.value)} />
              <input className={field} type="number" min={0} step="0.01" value={slipPts} onChange={(e) => setSlipPts(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Min score filter (optional)</label>
            <input className={field} type="number" min={0} max={100} value={minScore} onChange={(e) => setMinScore(e.target.value)} placeholder="off" />
          </div>
          <label className="col-span-2 flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={useSplit} onChange={(e) => setUseSplit(e.target.checked)} />
            Chronological split (60/20/20)
          </label>
          <label className="col-span-2 flex items-center gap-2" title="Exclude earlier-cohort scenarios whose consumed window reaches the next cohort — labelled purged metrics only">
            <input type="checkbox" checked={usePurge} disabled={!useSplit} onChange={(e) => setUsePurge(e.target.checked)} />
            Purged boundary evaluation
          </label>
          <div className="col-span-2">
            <label className="mb-1 block text-xs text-muted-foreground">Cost sensitivity (optional)</label>
            <input className={field} value={costCasesRaw} onChange={(e) => setCostCasesRaw(e.target.value)}
              placeholder="feeBps,slipBps,slipPts; e.g. 5,3,0.1; 15,8,0.3" />
            <p className="mt-0.5 text-[11px] text-muted-foreground">semicolon-separated cases; these are YOUR assumptions — illustrative values are never implied</p>
          </div>
          <div className="col-span-2">
            <label className="mb-1 block text-xs text-muted-foreground">Horizon sensitivity (optional)</label>
            <input className={field} value={horizonsRaw} onChange={(e) => setHorizonsRaw(e.target.value)}
              placeholder="comma-separated bars, e.g. 5,15,40" />
          </div>
          <div className="col-span-2 flex items-end justify-end">
            <Button onClick={run} disabled={running || files.length === 0 || !symbol.trim()}>
              {running ? "Evaluating…" : "Run validation"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && <Notice tone="error" title="Validation failed">{error}</Notice>}

      {result && (
        <>
          {/* Warnings first — incomplete/biased results must never read as validated performance. */}
          {result.warnings.length > 0 && (
            <Notice tone="warning" title="Warnings — read before interpreting results">
              <ul className="list-disc space-y-1 pl-4">
                {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </Notice>
          )}

          <Card>
            <CardHeader className="pb-2"
              title={`3 · Aggregate — ${agg!.filledCount} filled / ${result.scenarioCount} scenarios${agg!.excludedCount > 0 ? ` (+${agg!.excludedCount} excluded)` : ""}`} />
            <CardContent className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <Stat label="Realized W / L / BE" value={`${agg!.realizedWins} / ${agg!.realizedLosses} / ${agg!.realizedBreakevens}  (n=${agg!.realizedCount})`} />
              <Stat label="Mark-to-market W / L / BE" value={`${agg!.mtmWins} / ${agg!.mtmLosses} / ${agg!.mtmBreakevens}  (n=${agg!.mtmCount}, unrealized)`} />
              <Stat label="Realized win rate" value={fmt(agg!.realizedWinRate, 3)} />
              <Stat label="Realized expectancy R" value={fmt(agg!.realizedExpectancyR, 4)} />
              <Stat label="M2M mean R (unrealized)" value={fmt(agg!.mtmMeanR, 3)} />
              <Stat label="Net expectancy R (mixed)" value={fmt(agg!.expectancyR, 4)} />
              <Stat label="Total net R (mixed)" value={fmt(agg!.totalR, 3)} />
              <Stat label="Max drawdown R" value={fmt(agg!.maxDrawdownR, 3)} />
              <Stat label="Baseline mean R (hold)" value={fmt(agg!.meanBaselineR, 3)} />
              <Stat
                label="Statuses"
                value={Object.entries(agg!.counts).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(" · ") || "—"}
              />
              <Stat label="Dependence" value={agg!.dependence
                ? `${agg!.dependence.uniqueAnchors} unique anchors · ${agg!.dependence.overlappingPairs} overlapping pairs · ${agg!.dependence.clusters} clusters`
                : "—"} />
              <Stat label="Realized win-rate 95% CI" value={agg!.uncertainty?.winRate
                ? `${fmt(agg!.uncertainty.winRate.point, 3)} [${fmt(agg!.uncertainty.winRate.lower, 3)}…${fmt(agg!.uncertainty.winRate.upper, 3)}] (${agg!.uncertainty.winRate.method})`
                : "—"} />
              <Stat label="Realized expectancy 95% CI" value={agg!.uncertainty?.expectancyR
                ? `${fmt(agg!.uncertainty.expectancyR.point, 3)} [${fmt(agg!.uncertainty.expectancyR.lower, 3)}…${fmt(agg!.uncertainty.expectancyR.upper, 3)}] (${agg!.uncertainty.expectancyR.method})`
                : "—"} />
            </CardContent>
            {(agg!.uncertainty?.notes.length ?? 0) > 0 && (
              <CardContent className="border-t border-border/50 pt-2 text-xs text-muted-foreground">
                {agg!.uncertainty!.notes.map((n, i) => <p key={i}>· {n}</p>)}
              </CardContent>
            )}
          </Card>

          {result.splits && (
            <Card>
              <CardHeader title="Chronological cohorts" className="pb-2" />
              <CardContent className="overflow-x-auto text-xs">
                <table className="w-full min-w-[560px]">
                  <thead><tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1 pr-3">cohort</th><th className="pr-3">anchors</th><th className="pr-3">scenarios</th><th className="pr-3">realized</th>
                    <th className="pr-3">M2M</th><th className="pr-3">ambig.</th><th className="pr-3">realized W/L</th><th className="pr-3">realized exp. R</th><th className="pr-3">95% CI</th>
                    <th className="pr-3">purged n</th><th className="pr-3">purged exp. R</th><th className="pr-3">purged CI (method)</th><th>total R (mixed)</th>
                  </tr></thead>
                  <tbody>
                    {result.splits.map((s) => {
                      const pAgg = s.purged?.aggregate;
                      const pCi = pAgg?.uncertainty?.expectancyR;
                      return (
                        <tr key={s.name} className="border-b border-border/50">
                          <td className="py-1 pr-3 font-medium">{s.name}</td>
                          <td className="pr-3 text-muted-foreground">{(s.anchorFrom ?? "—").slice(0, 10)}→{(s.anchorTo ?? "—").slice(0, 10)}</td>
                          <td className="pr-3">{s.aggregate.scenarioCount}</td>
                          <td className="pr-3">{s.aggregate.realizedCount}{s.aggregate.realizedCount > 0 && s.aggregate.realizedCount < 10 ? " ⚠" : ""}</td>
                          <td className="pr-3">{s.aggregate.mtmCount}</td>
                          <td className="pr-3">{s.aggregate.counts.ambiguous ?? 0}</td>
                          <td className="pr-3">{s.aggregate.realizedWins}/{s.aggregate.realizedLosses}</td>
                          <td className="pr-3">{fmt(s.aggregate.realizedExpectancyR, 3)}</td>
                          <td className="pr-3">{s.aggregate.uncertainty?.expectancyR ? `[${fmt(s.aggregate.uncertainty.expectancyR.lower, 2)}…${fmt(s.aggregate.uncertainty.expectancyR.upper, 2)}]` : "—"}</td>
                          <td className="pr-3" title={s.purged?.purgeReasons?.map((r) => `${r.setupId} → ${r.intoCohort} (+${r.barsIntoLaterCohort}b)`).join("\n")}>
                            {s.purged === undefined ? "—" : `${s.purged.retainedCount} (−${s.purged.purgedCount})`}
                          </td>
                          <td className="pr-3">{s.purged === undefined ? "—" : s.purged.unavailableReason !== undefined ? "indeterminate" : fmt(pAgg?.realizedExpectancyR, 3)}</td>
                          <td className="pr-3">{s.purged === undefined ? "—" : s.purged.unavailableReason !== undefined ? "—" : pCi !== undefined ? `[${fmt(pCi.lower, 2)}…${fmt(pCi.upper, 2)}] (${pCi.method}, n=${pCi.n})` : "refused"}</td>
                          <td>{fmt(s.aggregate.totalR, 3)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {result.walkForward && (
            <Card>
              <CardHeader className="pb-2"
                title={`Boundary diagnostics — walk-forward status: ${result.walkForward.status}`} />
              <CardContent className="overflow-x-auto text-xs">
                {result.walkForward.boundaries[0]?.basis !== undefined && (
                  <p className="mb-2 text-[11px] text-muted-foreground">
                    boundary basis — {result.walkForward.boundaries[0].basis}
                  </p>
                )}
                <table className="w-full min-w-[560px]">
                  <thead><tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1 pr-3">boundary →</th><th className="pr-3">first held-out bar</th><th className="pr-3">boundary time</th>
                    <th className="pr-3">per-series boundaries</th><th className="pr-3">examined</th><th className="pr-3">contaminated</th>
                    <th className="pr-3">% of earlier</th><th className="pr-3">anchors hit</th><th className="pr-3">later bars touched</th>
                    <th className="pr-3">unverifiable</th><th>status</th>
                  </tr></thead>
                  <tbody>
                    {result.walkForward.boundaries.map((b) => (
                      <tr key={`${b.toCohort}-${b.boundaryIndex}`} className="border-b border-border/50">
                        <td className="py-1 pr-3 font-medium">→ {b.toCohort}</td>
                        <td className="pr-3">{b.boundaryBar ?? "—"}</td>
                        <td className="pr-3 text-muted-foreground">{(b.boundaryTime ?? "—").slice(0, 16)}</td>
                        <td className="pr-3 text-muted-foreground">
                          {(b.perSeries ?? []).map((p) => `${p.series}:${p.boundaryAnchorBar + 1}`).join(" · ") || "—"}
                        </td>
                        <td className="pr-3">{b.earlierEvaluableCount}</td>
                        <td className="pr-3">{b.contaminatedCount}</td>
                        <td className="pr-3">{b.contaminatedPct !== undefined ? `${(b.contaminatedPct * 100).toFixed(0)}%` : "—"}</td>
                        <td className="pr-3">{b.affectedAnchors}</td>
                        <td className="pr-3">{b.laterBarsTouched ?? "—"}</td>
                        <td className="pr-3">{b.unverifiableCount ?? 0}</td>
                        <td>{b.status === "clean" ? "absent (clean)" : b.status === "leakage_detected" ? "present (leakage)" : "indeterminate"}{b.note ? ` — ${b.note}` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.walkForward.boundaries.some((b) => b.contamination.length > 0) && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    contaminated scenarios: {result.walkForward.boundaries
                      .flatMap((b) => b.contamination.map((c) => `${c.setupId}(${c.series ?? "?"}, ${c.fromCohort}, +${c.barsIntoLaterCohort}b)`))
                      .join(" · ")}
                  </p>
                )}
                {result.splits?.some((s) => (s.purged?.purgeReasons?.length ?? 0) > 0) && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    purged rows: {result.splits.flatMap((s) =>
                      (s.purged?.purgeReasons ?? []).map((r) => `${r.setupId}(${s.name} → ${r.intoCohort}, +${r.barsIntoLaterCohort}b)`))
                      .join(" · ")}
                  </p>
                )}
                {result.walkForward.notes.map((n, i) => <p key={i} className="mt-1 text-[11px] text-muted-foreground">· {n}</p>)}
              </CardContent>
            </Card>
          )}

          {result.sensitivity?.costs && (
            <Card>
              <CardHeader title="Cost sensitivity — same scenarios, repriced" className="pb-2" />
              <CardContent className="overflow-x-auto text-xs">
                <table className="w-full min-w-[620px]">
                  <thead><tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1 pr-3">case</th><th className="pr-3">assumption (fee bps, slip bps, slip pts)</th>
                    <th className="pr-3">net exp. R</th><th className="pr-3">Δ vs base</th><th className="pr-3">sign flips</th><th>classification</th>
                  </tr></thead>
                  <tbody>
                    <tr className="border-b border-border/50 font-medium">
                      <td className="py-1 pr-3">base</td>
                      <td className="pr-3">{result.config?.costs ? JSON.stringify(result.config.costs) : "none configured"}</td>
                      <td className="pr-3">{fmt(agg!.expectancyR, 3)}</td><td className="pr-3">—</td><td className="pr-3">—</td><td>reference</td>
                    </tr>
                    {result.sensitivity.costs.map((c) => (
                      <tr key={c.label} className="border-b border-border/50">
                        <td className="py-1 pr-3">{c.label}</td>
                        <td className="pr-3">{JSON.stringify(c.costs)}</td>
                        <td className="pr-3">{fmt(c.aggregate.expectancyR, 3)}</td>
                        <td className="pr-3">{fmt(c.expectancyDeltaR, 3)}</td>
                        <td className="pr-3">{c.signFlips}</td>
                        <td className={c.expectancySignChange ? "font-medium text-amber-500" : ""}>
                          {c.expectancySignChange ? "EXPECTANCY SIGN FLIPPED" : "unchanged"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {result.sensitivity?.horizons && (
            <Card>
              <CardHeader title="Horizon sensitivity — same scenarios, re-windowed" className="pb-2" />
              <CardContent className="overflow-x-auto text-xs">
                <table className="w-full min-w-[620px]">
                  <thead><tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1 pr-3">horizon</th><th className="pr-3">filled</th><th className="pr-3">net exp. R</th>
                    <th className="pr-3">statuses</th><th>changes vs base</th>
                  </tr></thead>
                  <tbody>
                    <tr className="border-b border-border/50 font-medium">
                      <td className="py-1 pr-3">{result.config?.horizonBars as number} (base)</td>
                      <td className="pr-3">{agg!.filledCount}</td><td className="pr-3">{fmt(agg!.expectancyR, 3)}</td>
                      <td className="pr-3">{Object.entries(agg!.counts).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(" ")}</td>
                      <td>reference</td>
                    </tr>
                    {result.sensitivity.horizons.map((h) => (
                      <tr key={h.horizonBars} className="border-b border-border/50">
                        <td className="py-1 pr-3">{h.horizonBars}</td>
                        <td className="pr-3">{h.aggregate.filledCount}{h.aggregate.filledCount !== agg!.filledCount ? " ⚠" : ""}</td>
                        <td className="pr-3">{fmt(h.aggregate.expectancyR, 3)}</td>
                        <td className="pr-3">{Object.entries(h.aggregate.counts).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(" ")}</td>
                        <td className="text-muted-foreground">
                          {h.changedCount === 0 ? "none" : Object.entries(h.statusTransitions).map(([k, v]) => `${k}×${v}`).join(", ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader title="4 · Scenarios" className="pb-2"
              action={
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => download("csv")}>
                    <Download className="mr-1 h-3.5 w-3.5" /> CSV
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => download("json")}>
                    <Download className="mr-1 h-3.5 w-3.5" /> JSON
                  </Button>
                </div>
              } />
            <CardContent className="overflow-x-auto text-xs">
              <table className="w-full min-w-[880px]">
                <thead><tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1 pr-2">anchor</th><th className="pr-2">type/dir</th><th className="pr-2">status</th>
                  <th className="pr-2">entry</th><th className="pr-2">risk</th><th className="pr-2">gross R</th>
                  <th className="pr-2">cost R</th><th className="pr-2">net R</th><th className="pr-2">MFE/MAE</th>
                  <th className="pr-2">targets</th><th>resolved</th>
                </tr></thead>
                <tbody>
                  {result.scenarios.map((s) => (
                    <tr key={s.setupId} className="border-b border-border/50" title={s.statusReason}>
                      <td className="py-1 pr-2">{s.anchorTime.slice(0, 16).replace("T", " ")}</td>
                      <td className="pr-2">{s.setupType} {s.direction === "bullish" ? "↑" : "↓"}{s.overlapsNext ? " ⧉" : ""}</td>
                      <td className={`pr-2 font-medium ${s.status === "target" ? "text-emerald-500" : s.status === "stop" ? "text-red-500" : s.status === "unevaluable" || s.status === "ambiguous" ? "text-amber-500" : ""}`}>
                        {s.status}
                      </td>
                      <td className="pr-2">{fmt(s.entryPrice)}</td>
                      <td className="pr-2">{fmt(s.initialRisk)}</td>
                      <td className="pr-2">{fmt(s.grossR, 3)}</td>
                      <td className="pr-2">{fmt(s.costR, 3)}</td>
                      <td className="pr-2 font-medium">{fmt(s.netR, 3)}</td>
                      <td className="pr-2">{fmt(s.mfeR, 2)}/{fmt(s.maeR, 2)}</td>
                      <td className="pr-2">{s.targetsReached ?? "—"}</td>
                      <td>{(s.resolvedAt ?? "").slice(0, 16).replace("T", " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader title="Assumptions & provenance" className="pb-2" />
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              <ul className="list-disc space-y-0.5 pl-4">
                {result.assumptions.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
              {result.methodology && (
                <div className="space-y-1 border-t border-border/50 pt-2">
                  <p><span className="font-medium text-foreground">Uncertainty:</span> {result.methodology.uncertaintyMethod}</p>
                  <p><span className="font-medium text-foreground">Cohorts:</span> {result.methodology.cohortBoundaries}</p>
                  <details>
                    <summary className="cursor-pointer font-medium text-foreground">Metric denominators</summary>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {Object.entries(result.methodology.metricDefinitions).map(([k, v]) => (
                        <li key={k}><code>{k}</code> — {v}</li>
                      ))}
                    </ul>
                  </details>
                </div>
              )}
              <div className="pt-1">
                contract <code>{result.contractVersion}</code> · config <code>{result.configVersion ?? "—"}</code> ·
                fingerprint <code className="break-all">{result.fingerprint}</code>
              </div>
              <div className="flex items-center gap-2 border-t border-border/50 pt-2">
                <label className="cursor-pointer text-xs font-medium text-foreground">
                  Compare with an exported run…
                  <input type="file" accept=".json,application/json" className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      f.text().then((t) => { try { setComparison(JSON.parse(t) as Result); } catch { setError("comparison file is not a validation export JSON"); } });
                    }} />
                </label>
                {comparison && <Button variant="outline" size="sm" onClick={() => setComparison(undefined)}>clear</Button>}
              </div>
              {comparison && (
                <div className="space-y-1 text-xs">
                  <p>fingerprint: <code>{comparison.fingerprint.slice(0, 12)}…</code>{" "}
                    {comparison.fingerprint === result.fingerprint
                      ? <span className="text-emerald-500">identical run</span>
                      : <span className="text-amber-500">differs — check assumptions/sample below</span>}</p>
                  <p>config equal: {JSON.stringify(comparison.config) === JSON.stringify(result.config)
                    ? "yes" : <span className="text-amber-500">NO — assumption change, not necessarily an outcome change</span>}</p>
                  <p>scenarios: {comparison.scenarioCount} vs {result.scenarioCount} ·
                     filled: {comparison.aggregate.filledCount} vs {result.aggregate.filledCount} ·
                     net exp: {fmt(comparison.aggregate.expectancyR, 3)} vs {fmt(result.aggregate.expectancyR, 3)}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
