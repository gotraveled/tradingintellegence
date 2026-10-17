"use client";

/**
 * Strategy Comparison Lab — evaluates 2–6 frozen strategy snapshots through
 * the canonical hv1 contract on one uploaded dataset under one shared
 * protocol (comp-v1). Research tool only: no optimization, no parameter
 * search, no execution. Fairness disclosures and the test-cohort honesty note
 * render above the table — results must never read as a decisive ranking.
 */
import { useState } from "react";
import { Download, FileUp, Plus, Trash2 } from "lucide-react";
import type { Timeframe } from "@/lib/types";
import { TIMEFRAME_MS } from "@/lib/market-data/timeframes";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import {
  browserStore,
  buildRecord,
  register,
  type ExperimentRecord,
  type ExposureReport,
} from "@/lib/services/experiment-registry";
import { buildBundle, exportBundle } from "@/lib/services/replay-bundle";
import type { StrategyComparisonResult } from "@/lib/services/strategy-comparison";

const TIMEFRAMES = [...Object.keys(TIMEFRAME_MS), "1M"] as Timeframe[];

const PRESETS = [
  { id: "baseline", label: "Baseline (canonical V1)" },
  { id: "reversal-only", label: "Reversal setups only" },
  { id: "breakout-only", label: "Breakout setups only" },
  { id: "continuation-only", label: "Continuation setups only" },
  { id: "high-conviction", label: "High-conviction (score ≥ 70)" },
] as const;

interface CI { method: string; confidence: number; point: number; lower: number; upper: number; n: number; denominator: string; caveat?: string }
interface Agg {
  scenarioCount: number; filledCount: number;
  realizedCount: number; realizedWins: number; realizedLosses: number; realizedBreakevens: number;
  mtmCount: number;
  realizedWinRate?: number; realizedExpectancyR?: number;
  expectancyR?: number; totalR?: number; medianR?: number; maxDrawdownR?: number;
  uncertainty?: { winRate?: CI; expectancyR?: CI; notes: string[] };
  dependence?: { uniqueAnchors: number; overlappingPairs: number; overlappingWindows: number; clusters: number; largestCluster: number };
}
interface StrategyRow {
  id: string; label: string; configVersion: string;
  selection?: { setupTypes?: string[]; minScore?: number };
  fingerprint: string; scenarioCount: number; filledCount: number;
  counts: Record<string, number>;
  realizedCount: number; realizedWins: number; realizedLosses: number; realizedBreakevens: number;
  mtmCount: number;
  realizedWinRate?: number; realizedExpectancyR?: number;
  expectancyR?: number; totalR?: number; medianR?: number; maxDrawdownR?: number;
  uncertainty?: Agg["uncertainty"]; dependence?: Agg["dependence"];
}
interface SplitRow {
  name: string; aggregate: Agg;
  purged?: { retainedCount: number; purgedCount: number; aggregate?: Agg; unavailableReason?: string };
}
interface Compared {
  id: string; label: string; configVersion: string;
  engineConfig: Record<string, unknown>;
  row: StrategyRow;
  result: { fingerprint: string; aggregate: Agg; splits?: SplitRow[]; sensitivity?: { costs?: { label: string; aggregate: Agg; expectancyDeltaR?: number }[]; horizons?: { horizonBars: number; aggregate: Agg; changedCount: number }[] }; warnings: string[] };
}
interface ComparisonResult {
  protocolVersion: string; contractVersion: string; fingerprint: string;
  datasets: { symbol: string; timeframe: string; bars: number; firstBar: string; lastBar: string }[];
  shared: Record<string, unknown>;
  strategies: Compared[];
  perInstrument: { series: string; rows: { id: string; aggregate: Agg }[] }[];
  testCohort: { evaluated: boolean; enforceable: boolean; note: string };
  fairness: string[];
  warnings: string[];
  methodology: { comparison: string; ranking: string; uncertainty: string };
  evaluatedAt: string;
}

const num = (v: string): number | undefined => (v.trim() === "" ? undefined : Number(v));
const fmt = (v: number | undefined, d = 2) => (v === undefined ? "—" : v.toFixed(d));

interface StrategyDraft { id: string; preset: string }

export function StrategyComparisonWorkspace() {
  const [files, setFiles] = useState<File[]>([]);
  const [symbol, setSymbol] = useState("");
  const [anchor, setAnchor] = useState<Timeframe>("1h");
  const [metas, setMetas] = useState<({ timeframe?: Timeframe; is24x7?: boolean })[]>([]);
  const [drafts, setDrafts] = useState<StrategyDraft[]>([
    { id: "baseline", preset: "baseline" },
    { id: "high-conviction", preset: "high-conviction" },
  ]);
  const [horizon, setHorizon] = useState("20");
  const [deadline, setDeadline] = useState("");
  const [feeBps, setFeeBps] = useState("0");
  const [slipBps, setSlipBps] = useState("0");
  const [slipPts, setSlipPts] = useState("0");
  const [useSplit, setUseSplit] = useState(false);
  const [usePurge, setUsePurge] = useState(false);
  const [horizonsRaw, setHorizonsRaw] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [record, setRecord] = useState<ExperimentRecord | undefined>();
  const [result, setResult] = useState<ComparisonResult | undefined>();
  const [exposure, setExposure] = useState<ExposureReport | undefined>();
  const [view, setView] = useState<"raw" | "purged">("raw");

  const pick = (list: FileList | null) => {
    const fs = Array.from(list ?? []);
    setFiles(fs);
    setMetas(fs.map(() => ({})));
    setResult(undefined);
    setExposure(undefined);
  };

  const setDraft = (i: number, patch: Partial<StrategyDraft>) =>
    setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const run = async () => {
    setRunning(true);
    setError(undefined);
    try {
      const config: Record<string, unknown> = { horizonBars: Number(horizon) };
      const dl = num(deadline); if (dl !== undefined) config.entryDeadlineBars = dl;
      const costs = { feeBps: Number(feeBps), slippageBps: Number(slipBps), slippagePoints: Number(slipPts) };
      if (costs.feeBps || costs.slippageBps || costs.slippagePoints) config.costs = costs;
      if (useSplit) config.split = { trainPct: 0.6, validationPct: 0.2 };
      if (useSplit && usePurge) config.purgeBoundaries = true;
      const hs = horizonsRaw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 1);
      if (hs.length > 0) config.horizonSensitivity = hs;

      const form = new FormData();
      for (const f of files) form.append("files", f);
      form.set("meta", JSON.stringify(metas));
      form.set("symbol", symbol.trim().toUpperCase());
      form.set("anchor", anchor);
      form.set("config", JSON.stringify(config));
      form.set("strategies", JSON.stringify(
        drafts.map((d) => ({ id: d.id.trim(), preset: d.preset })),
      ));

      const res = await fetch("/api/compare/strategies", { method: "POST", body: form });
      const body = (await res.json()) as { result?: ComparisonResult; error?: { message?: string } };
      if (!res.ok || !body.result) {
        setError(body.error?.message ?? `comparison failed (HTTP ${res.status})`);
        setResult(undefined);
        setExposure(undefined);
        return;
      }
      setResult(body.result);
      // Registry is additive bookkeeping — a storage failure must never break
      // the comparison display or touch the result.
      try {
        const store = browserStore();
        const serviceResult = body.result as unknown as StrategyComparisonResult;
        const rec = buildRecord({
          result: serviceResult,
          strategies: serviceResult.strategies,
          createdAt: new Date().toISOString(),
        });
        const { record, history } = register(store.load(), rec);
        store.save(history);
        setExposure(record.exposure);
        setRecord(record);
        window.dispatchEvent(new Event("ti-registry-changed"));
      } catch {
        setExposure(undefined);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "comparison request failed");
    } finally {
      setRunning(false);
    }
  };

  const download = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `comparison-${result.fingerprint.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportReplay = async () => {
    if (!result || !record) return;
    const texts = await Promise.all(files.map(async (f, i) => ({
      name: f.name, text: await f.text(),
      ...(metas[i]?.timeframe !== undefined ? { timeframe: metas[i].timeframe } : {}),
      ...(metas[i]?.is24x7 === true ? { is24x7: true } : {}),
    })));
    const bundle = buildBundle({
      record,
      inputs: { symbol: symbol.trim().toUpperCase(), anchor },
      files: texts,
    });
    const blob = new Blob([exportBundle(bundle)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `replay-bundle-${record.recordId.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const field = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm";
  const draftsValid = drafts.length >= 2 && drafts.every((d) => d.id.trim() !== "");

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
        <CardHeader title="2 · Strategies (2–6 frozen snapshots)" className="pb-2" />
        <CardContent className="space-y-2 text-sm">
          {drafts.map((d, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className={`${field} w-40`} value={d.id} placeholder="strategy id"
                onChange={(e) => setDraft(i, { id: e.target.value })} />
              <select className={`${field} flex-1`} value={d.preset}
                onChange={(e) => setDraft(i, { preset: e.target.value })}>
                {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <Button variant="ghost" size="icon" disabled={drafts.length <= 2}
                onClick={() => setDrafts((x) => x.filter((_, j) => j !== i))}
                aria-label="remove strategy">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" disabled={drafts.length >= 6}
            onClick={() => setDrafts((d) => [...d, { id: `s${d.length + 1}`, preset: "baseline" }])}>
            <Plus className="mr-1 h-4 w-4" /> Add strategy
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Presets are definitional variants of the canonical V1 configuration — never tuned
            against outcomes. Identical snapshots are rejected; different opportunity counts are
            reported, not reconciled.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="3 · Shared protocol (identical for every strategy)" className="pb-2" />
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
          <label className="col-span-2 flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={useSplit} onChange={(e) => setUseSplit(e.target.checked)} />
            Chronological split (60/20/20)
          </label>
          <label className="col-span-2 flex items-center gap-2" title="Exclude earlier-cohort scenarios whose consumed window reaches a later cohort — labelled purged metrics only">
            <input type="checkbox" checked={usePurge} disabled={!useSplit} onChange={(e) => setUsePurge(e.target.checked)} />
            Purged boundary evaluation
          </label>
          <div className="col-span-2">
            <label className="mb-1 block text-xs text-muted-foreground">Horizon sensitivity (optional)</label>
            <input className={field} value={horizonsRaw} onChange={(e) => setHorizonsRaw(e.target.value)}
              placeholder="comma-separated bars, e.g. 5,15,40" />
          </div>
          <div className="col-span-2 flex items-end justify-end">
            <Button onClick={run} disabled={running || files.length === 0 || !symbol.trim() || !draftsValid}>
              {running ? "Comparing…" : "Run comparison"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && <Notice tone="error" title="Comparison failed">{error}</Notice>}

      {result && (
        <>
          <Notice tone="warning" title="Fairness — read before interpreting rows">
            <ul className="list-disc space-y-1 pl-4">
              <li>{result.testCohort.note}</li>
              {result.fairness.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </Notice>
          {exposure !== undefined && (
            <Notice
              tone={exposure.status === "repeat" || exposure.status === "exposed" || exposure.status === "consumed-window-overlap" ? "warning" : "info"}
              title={`Test-set exposure — ${
                exposure.status === "repeat" ? "exact repeat of a recorded experiment" :
                exposure.status === "exposed" ? "previously exposed test period" :
                exposure.status === "consumed-window-overlap" ? "verifiable consumed-window overlap" :
                exposure.status === "overlap" ? "overlapping prior evaluation" :
                exposure.status === "no-prior-exposure" ? "no prior exposure recorded in this registry" :
                "exposure unknown"
              }${exposure.coverage === "partial" ? " (partial coverage)" : ""}`}>
              {exposure.note}
              {exposure.matched.length > 0 && (
                <div className="mt-1 text-[11px]">
                  matched: {exposure.matched.map((m) => `${m.fingerprint.slice(0, 8)}… (${m.relation})`).join(", ")}
                </div>
              )}
            </Notice>
          )}
          {result.warnings.length > 0 && (
            <Notice tone="warning" title="Warnings">
              <ul className="list-disc space-y-1 pl-4">
                {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </Notice>
          )}

          <Card>
            <CardHeader className="pb-2"
              title={`4 · Comparison — ${result.strategies.length} strategies · protocol ${result.protocolVersion} · fingerprint ${result.fingerprint.slice(0, 12)}…`} />
            <CardContent className="overflow-x-auto text-sm">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">Strategy</th>
                    <th className="py-1 pr-3 font-medium">Scenarios</th>
                    <th className="py-1 pr-3 font-medium">Filled</th>
                    <th className="py-1 pr-3 font-medium">Realized n</th>
                    <th className="py-1 pr-3 font-medium">M2M n</th>
                    <th className="py-1 pr-3 font-medium">Realized W/L/BE</th>
                    <th className="py-1 pr-3 font-medium">Realized win rate</th>
                    <th className="py-1 pr-3 font-medium">Realized exp. R</th>
                    <th className="py-1 pr-3 font-medium">Total net R (mixed)</th>
                    <th className="py-1 pr-3 font-medium">Max DD R</th>
                    <th className="py-1 pr-3 font-medium">Dependence</th>
                    <th className="py-1 font-medium">Uncertainty</th>
                  </tr>
                </thead>
                <tbody>
                  {result.strategies.map((c) => {
                    const r = c.row;
                    return (
                      <tr key={c.id} className="border-b border-border/50 align-top">
                        <td className="py-1.5 pr-3">
                          <div className="font-medium">{r.label}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {r.id} · {r.configVersion}
                            {r.selection?.setupTypes ? ` · ${r.selection.setupTypes.join("+")}` : ""}
                            {r.selection?.minScore !== undefined ? ` · score≥${r.selection.minScore}` : ""}
                          </div>
                        </td>
                        <td className="py-1.5 pr-3">{r.scenarioCount}</td>
                        <td className="py-1.5 pr-3">{r.filledCount}</td>
                        <td className="py-1.5 pr-3">{r.realizedCount}</td>
                        <td className="py-1.5 pr-3">{r.mtmCount}</td>
                        <td className="py-1.5 pr-3">{r.realizedWins}/{r.realizedLosses}/{r.realizedBreakevens}</td>
                        <td className="py-1.5 pr-3">{fmt(r.realizedWinRate, 3)}</td>
                        <td className="py-1.5 pr-3">{fmt(r.realizedExpectancyR, 3)}</td>
                        <td className="py-1.5 pr-3">{fmt(r.totalR, 2)}</td>
                        <td className="py-1.5 pr-3">{fmt(r.maxDrawdownR, 2)}</td>
                        <td className="py-1.5 pr-3 text-[11px]">{r.dependence
                          ? `${r.dependence.uniqueAnchors} anchors · ${r.dependence.overlappingPairs} pairs · ${r.dependence.clusters} clusters`
                          : "—"}</td>
                        <td className="py-1.5 text-[11px]">
                          {r.uncertainty?.winRate
                            ? `WR ${fmt(r.uncertainty.winRate.point, 2)} [${fmt(r.uncertainty.winRate.lower, 2)}…${fmt(r.uncertainty.winRate.upper, 2)}] ${r.uncertainty.winRate.method}`
                            : "WR refused"}
                          <br />
                          {r.uncertainty?.expectancyR
                            ? `E[R] ${fmt(r.uncertainty.expectancyR.point, 2)} [${fmt(r.uncertainty.expectancyR.lower, 2)}…${fmt(r.uncertainty.expectancyR.upper, 2)}] ${r.uncertainty.expectancyR.method}`
                            : "E[R] refused"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Descriptive rows only — win rate and expectancy divide by REALIZED counts;
                censored mark-to-market rows are reported separately. {result.methodology.ranking}
              </p>
            </CardContent>
          </Card>

          {result.perInstrument.length > 1 && (
            <Card>
              <CardHeader title="Per-instrument (pooled rows above are NOT instrument-specific)" className="pb-2" />
              <CardContent className="overflow-x-auto text-xs">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="py-1 pr-3 font-medium">Series</th>
                      <th className="py-1 pr-3 font-medium">Strategy</th>
                      <th className="py-1 pr-3 font-medium">Scenarios</th>
                      <th className="py-1 pr-3 font-medium">Realized n</th>
                      <th className="py-1 pr-3 font-medium">Realized win rate</th>
                      <th className="py-1 font-medium">Realized exp. R</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.perInstrument.flatMap((p) =>
                      p.rows.map((row) => (
                        <tr key={`${p.series}-${row.id}`} className="border-b border-border/50">
                          <td className="py-1 pr-3">{p.series}</td>
                          <td className="py-1 pr-3">{row.id}</td>
                          <td className="py-1 pr-3">{row.aggregate.scenarioCount}</td>
                          <td className="py-1 pr-3">{row.aggregate.realizedCount}</td>
                          <td className="py-1 pr-3">{fmt(row.aggregate.realizedWinRate, 3)}</td>
                          <td className="py-1">{fmt(row.aggregate.realizedExpectancyR, 3)}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {result.strategies.some((c) => c.result.splits !== undefined) && (
            <Card>
              <CardHeader className="pb-2" title="5 · Per-cohort — raw vs purged" />
              <CardContent className="space-y-3 text-xs">
                <div className="flex gap-2">
                  {(["raw", "purged"] as const).map((v) => (
                    <Button key={v} size="sm" variant={view === v ? "primary" : "outline"}
                      onClick={() => setView(v)}>{v === "raw" ? "Raw" : "Purged"}</Button>
                  ))}
                </div>
                {result.strategies.map((c) => (
                  <div key={c.id} className="overflow-x-auto">
                    <div className="mb-1 font-medium">{c.label}</div>
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className="border-b border-border text-left text-muted-foreground">
                          <th className="py-1 pr-3 font-medium">Cohort</th>
                          <th className="py-1 pr-3 font-medium">Scenarios</th>
                          <th className="py-1 pr-3 font-medium">Realized n</th>
                          <th className="py-1 pr-3 font-medium">Realized win rate</th>
                          <th className="py-1 pr-3 font-medium">Realized exp. R</th>
                          <th className="py-1 font-medium">Purged</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(c.result.splits ?? []).map((s) => {
                          const agg = view === "purged" && s.purged?.aggregate ? s.purged.aggregate : s.aggregate;
                          return (
                            <tr key={s.name} className="border-b border-border/50">
                              <td className="py-1 pr-3">{s.name}</td>
                              <td className="py-1 pr-3">{agg.scenarioCount}</td>
                              <td className="py-1 pr-3">{agg.realizedCount}</td>
                              <td className="py-1 pr-3">{fmt(agg.realizedWinRate, 3)}</td>
                              <td className="py-1 pr-3">{fmt(agg.realizedExpectancyR, 3)}</td>
                              <td className="py-1">
                                {s.purged
                                  ? s.purged.unavailableReason
                                    ? `unavailable — ${s.purged.unavailableReason}`
                                    : `${s.purged.purgedCount} purged / ${s.purged.retainedCount} retained`
                                  : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader title="Methodology & limitations" className="pb-2" />
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              <p>{result.methodology.comparison}</p>
              <p>{result.methodology.uncertainty}</p>
              <p>Evaluation range: the full supplied dataset — {result.datasets.map((d) => `${d.symbol}@${d.timeframe} ${d.bars} bars`).join(", ")}.</p>
              <p>Fingerprint <code>{result.fingerprint.slice(0, 16)}…</code> binds dataset content, all strategy snapshots, shared protocol, engine and contract versions. It establishes input identity — not data authenticity or statistical validity.</p>
              <Button size="sm" variant="outline" onClick={download}>
                <Download className="mr-1 h-4 w-4" /> Export comparison (JSON)
              </Button>
              <Button size="sm" variant="outline" onClick={() => void exportReplay()} disabled={!record}>
                <Download className="mr-1 h-4 w-4" /> Export replay bundle
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
