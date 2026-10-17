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
interface Agg {
  scenarioCount: number; excludedCount: number;
  counts: Record<string, number>;
  filledCount: number; wins: number; losses: number; breakevens: number;
  expectancyR?: number; grossExpectancyR?: number; medianR?: number;
  totalR?: number; maxDrawdownR?: number; meanBaselineR?: number;
}
interface Result {
  contractVersion: string; fingerprint: string;
  datasets: { symbol: string; timeframe: string; bars: number; firstBar: string; lastBar: string }[];
  scenarioCount: number; scenarios: ScenarioRow[];
  aggregate: Agg;
  splits?: { name: string; aggregate: Agg }[];
  warnings: string[]; assumptions: string[]; evaluatedAt: string;
  configVersion?: string;
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
            Report chronological train/validation/test cohorts (60/20/20 — descriptive only, no tuning exists)
          </label>
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
              <Stat label="Wins / losses / breakeven" value={`${agg!.wins} / ${agg!.losses} / ${agg!.breakevens}`} />
              <Stat label="Net expectancy R" value={fmt(agg!.expectancyR, 4)} />
              <Stat label="Gross expectancy R" value={fmt(agg!.grossExpectancyR, 4)} />
              <Stat label="Median R" value={fmt(agg!.medianR, 3)} />
              <Stat label="Total net R" value={fmt(agg!.totalR, 3)} />
              <Stat label="Max drawdown R" value={fmt(agg!.maxDrawdownR, 3)} />
              <Stat label="Baseline mean R (hold)" value={fmt(agg!.meanBaselineR, 3)} />
              <Stat
                label="Statuses"
                value={Object.entries(agg!.counts).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(" · ") || "—"}
              />
            </CardContent>
          </Card>

          {result.splits && (
            <Card>
              <CardHeader title="Chronological cohorts" className="pb-2" />
              <CardContent className="overflow-x-auto text-xs">
                <table className="w-full min-w-[560px]">
                  <thead><tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1 pr-3">cohort</th><th className="pr-3">scenarios</th><th className="pr-3">filled</th>
                    <th className="pr-3">wins</th><th className="pr-3">losses</th><th className="pr-3">net exp. R</th><th>total R</th>
                  </tr></thead>
                  <tbody>
                    {result.splits.map((s) => (
                      <tr key={s.name} className="border-b border-border/50">
                        <td className="py-1 pr-3 font-medium">{s.name}</td>
                        <td className="pr-3">{s.aggregate.scenarioCount}</td>
                        <td className="pr-3">{s.aggregate.filledCount}</td>
                        <td className="pr-3">{s.aggregate.wins}</td>
                        <td className="pr-3">{s.aggregate.losses}</td>
                        <td className="pr-3">{fmt(s.aggregate.expectancyR, 3)}</td>
                        <td>{fmt(s.aggregate.totalR, 3)}</td>
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
              <div className="pt-1">
                contract <code>{result.contractVersion}</code> · config <code>{result.configVersion ?? "—"}</code> ·
                fingerprint <code className="break-all">{result.fingerprint}</code>
              </div>
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
