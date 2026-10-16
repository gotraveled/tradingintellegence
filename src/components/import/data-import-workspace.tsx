"use client";

/**
 * Data Import workspace (Phase P2) — the zero-subscription data path.
 *
 * Flow: choose CSV → server validates & previews → user confirms with a
 * symbol + timeframe → canonical /api/analysis runs over the uploaded candles
 * (UploadedDatasetProvider, source.kind "file"). No file contents are stored
 * anywhere; nothing is sent to a third party.
 */
import { useRef, useState } from "react";
import { FileUp } from "lucide-react";
import type {
  AnalysisResult,
  MarketSegmentId,
  Timeframe,
} from "@/lib/types";
import { TIMEFRAME_MS } from "@/lib/market-data/timeframes";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";

const TIMEFRAMES = [...Object.keys(TIMEFRAME_MS), "1M"] as Timeframe[];

interface ValidateStats {
  firstBar: number;
  lastBar: number;
  gaps: number;
  duplicates: number;
  outOfOrder: number;
  invalidBars: number;
  firstBarIso: string;
  lastBarIso: string;
}

interface ValidateResult {
  fileName?: string;
  rowCount: number;
  rejectedCount: number;
  delimiter: string;
  mapping: { time: number; open: number; high: number; low: number; close: number; volume?: number };
  stats: ValidateStats;
  intervalHintMs?: number;
  timeframeHint?: Timeframe;
  issues: { row: number; message: string }[];
  validationIssues: { severity: string; message: string }[];
  preview: { headers: string[]; rows: string[][] };
  provenance: string;
}

type Stage = "pick" | "validated" | "analyzing" | "done";

export function DataImportWorkspace() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | undefined>();
  const [mode, setMode] = useState<"single" | "mtf">("single");
  const [stage, setStage] = useState<Stage>("pick");
  const [error, setError] = useState<string | undefined>();
  const [validation, setValidation] = useState<ValidateResult | undefined>();
  const [analysis, setAnalysis] = useState<AnalysisResult | undefined>();
  const [symbol, setSymbol] = useState("");
  const [timeframe, setTimeframe] = useState<Timeframe>("1D");
  const [market, setMarket] = useState<MarketSegmentId | "">("");
  const is24x7 = market === "crypto";

  const reset = () => {
    setStage("pick");
    setError(undefined);
    setValidation(undefined);
    setAnalysis(undefined);
  };

  const validate = async (target?: File) => {
    const targetFile = target ?? file;
    if (!targetFile) return;
    setError(undefined);
    const form = new FormData();
    form.set("file", targetFile);
    const qs = new URLSearchParams();
    if (timeframe) qs.set("timeframe", timeframe);
    if (is24x7) qs.set("is24x7", "true");
    const res = await fetch(`/api/import/validate?${qs}`, { method: "POST", body: form });
    const body = (await res.json()) as { result?: ValidateResult; error?: { message?: string } };
    if (!res.ok || !body.result) {
      setError(body.error?.message ?? `validation failed (HTTP ${res.status})`);
      return;
    }
    setValidation(body.result);
    if (body.result.timeframeHint && !timeframe) setTimeframe(body.result.timeframeHint);
    setStage("validated");
  };

  const analyze = async () => {
    if (!file || !symbol.trim()) return;
    setError(undefined);
    setStage("analyzing");
    const form = new FormData();
    form.set("file", file);
    form.set("symbol", symbol.trim().toUpperCase());
    form.set("timeframe", timeframe);
    if (is24x7) form.set("is24x7", "true");
    const res = await fetch("/api/import/analysis", { method: "POST", body: form });
    const body = (await res.json()) as {
      result?: AnalysisResult;
      error?: { message?: string };
    };
    if (!res.ok || !body.result) {
      setError(body.error?.message ?? `analysis failed (HTTP ${res.status})`);
      setStage("validated");
      return;
    }
    setAnalysis(body.result);
    setStage("done");
  };

  if (mode === "mtf") {
    return <MtfImportPanel onBack={() => setMode("single")} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="secondary" onClick={() => setMode("mtf")}>
          Multi-timeframe upload (2–4 files)
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader
          title="Upload an OHLC dataset"
          description="CSV with time, open, high, low, close (volume optional). The file is parsed in your session only — it is never stored or shared."
        />
        <CardContent className="space-y-4">
          {stage === "pick" ? (
            <EmptyState
              icon={FileUp}
              title="Choose a CSV export"
              description="TradingView, MT4/MT5, Investing.com, broker exports — the importer detects delimiters and column names automatically."
              action={
                <Button onClick={() => fileRef.current?.click()}>Select file</Button>
              }
            />
          ) : (
            <div className="space-y-4">
              {validation ? (
                <>
                  <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                    <Stat label="Rows" value={String(validation.rowCount)} />
                    <Stat label="Rejected" value={String(validation.rejectedCount)} />
                    <Stat label="Gaps" value={String(validation.stats.gaps)} />
                    <Stat label="Range" value={`${validation.stats.firstBarIso.slice(0, 10)} → ${validation.stats.lastBarIso.slice(0, 10)}`} wide />
                  </div>
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="w-full text-xs">
                      <thead className="border-b border-border bg-surface-elevated">
                        <tr>
                          {validation.preview.headers.map((h, i) => (
                            <th key={i} className="px-2 py-1.5 text-left font-medium text-muted-foreground">{h || `col ${i + 1}`}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {validation.preview.rows.map((row, ri) => (
                          <tr key={ri} className="border-b border-border/50 last:border-0">
                            {row.map((cell, ci) => (
                              <td key={ci} className="px-2 py-1 font-mono whitespace-nowrap">{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {validation.issues.length > 0 ? (
                    <Notice tone="warning" title={`${validation.issues.length} row(s) skipped or flagged`}>
                      <ul className="list-disc space-y-0.5 pl-4">
                        {validation.issues.slice(0, 5).map((i, k) => (
                          <li key={k}>line {i.row}: {i.message}</li>
                        ))}
                      </ul>
                    </Notice>
                  ) : null}
                  {validation.validationIssues.length > 0 ? (
                    <Notice tone="info" title={`${validation.validationIssues.length} structural finding(s)`}>
                      <ul className="list-disc space-y-0.5 pl-4">
                        {validation.validationIssues.slice(0, 5).map((i, k) => (
                          <li key={k}>[{i.severity}] {i.message}</li>
                        ))}
                      </ul>
                    </Notice>
                  ) : null}
                </>
              ) : null}

              {stage === "done" && analysis ? (
                <div className="space-y-3">
                  <Notice tone="info" title="Analysis complete — user-uploaded dataset">
                    {analysis.cells.length} cell(s) evaluated at{" "}
                    {analysis.cells[0] ? new Date(analysis.cells[0].evaluatedAt).toISOString() : analysis.asOf},{" "}
                    {analysis.opportunities.length} ranked record(s), {analysis.developing.length} developing.{" "}
                    Source: {analysis.dataSource.label} — {analysis.dataClassification ?? "historical"}.
                  </Notice>
                  {analysis.opportunities.length > 0 ? (
                    <div className="overflow-x-auto rounded-md border border-border">
                      <table className="w-full text-xs">
                        <thead className="border-b border-border bg-surface-elevated">
                          <tr>
                            {["#", "Setup", "Dir", "Score", "Status", "R/R"].map((h) => (
                              <th key={h} className="px-2 py-1.5 text-left font-medium text-muted-foreground">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {analysis.opportunities.slice(0, 12).map((o, i) => (
                            <tr key={o.setupId + i} className="border-b border-border/50 last:border-0">
                              <td className="px-2 py-1 font-mono">{o.rank ?? i + 1}</td>
                              <td className="px-2 py-1">{o.setupType}</td>
                              <td className="px-2 py-1">{o.direction}</td>
                              <td className="px-2 py-1 font-mono">{o.score}</td>
                              <td className="px-2 py-1">{o.status}</td>
                              <td className="px-2 py-1 font-mono">{o.plan?.riskReward ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No ranked setups at the anchor — an honest result, not an error.
                      {analysis.skipped.length > 0 ? ` Skipped: ${analysis.skipped.map((s) => s.symbol).join(", ")}.` : ""}
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          )}

          {error ? <Notice tone="error" title="Import failed">{error}</Notice> : null}
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader title="Dataset settings" description="Provenance is recorded on every analysis." />
        <CardContent className="space-y-4">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                setFile(f);
                reset();
                void validate(f); // pass the file — state hasn't committed yet
              }
            }}
          />
          <div className="space-y-1 text-xs">
            <p className="font-medium">File</p>
            <p className="text-muted-foreground break-all">{file ? file.name : "none selected"}</p>
            <Button variant="secondary" className="mt-1" onClick={() => fileRef.current?.click()}>
              {file ? "Replace file" : "Select file"}
            </Button>
          </div>
          <label className="block space-y-1 text-xs">
            <span className="font-medium">Symbol label</span>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="e.g. NIFTY50, MYSTOCK"
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5"
            />
          </label>
          <label className="block space-y-1 text-xs">
            <span className="font-medium">Timeframe (required for analysis)</span>
            <select
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value as Timeframe)}
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5"
            >
              {TIMEFRAMES.map((tf) => (
                <option key={tf} value={tf}>{tf}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-xs">
            <span className="font-medium">Market (gap calendar)</span>
            <select
              value={market}
              onChange={(e) => setMarket(e.target.value as MarketSegmentId | "")}
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5"
            >
              <option value="">Weekday market (default)</option>
              <option value="crypto">Crypto / 24-7</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void validate()} disabled={!file}>Validate &amp; preview</Button>
            <Button
              onClick={analyze}
              disabled={!file || stage === "pick" || !symbol.trim() || stage === "analyzing"}
            >
              {stage === "analyzing" ? "Analyzing…" : "Run analysis"}
            </Button>
          </div>
          <Notice tone="info" title="Your data, your responsibility">
            <p>
              Imported data is analyzed for your own session. Uploading data does not
              grant redistribution rights — do not import data you are not entitled to use.
            </p>
          </Notice>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2" : undefined}>
      <p className="text-muted-foreground">{label}</p>
      <p className="font-mono text-sm">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multi-timeframe upload (Phase P3) — 2–4 datasets, one declared instrument,
// spec-31 frames through the canonical engine join (closed bars only).
// ---------------------------------------------------------------------------

interface MtfDataset {
  file?: File;
  timeframe: Timeframe;
  is24x7: boolean;
  /** Optional per-file instrument tag — must match the run symbol when set. */
  symbol: string;
  validation?: ValidateResult;
  error?: string;
  validating: boolean;
}

interface MtfFrameReport {
  role: string;
  timeframe: Timeframe;
  fileName?: string;
  bars: number;
  firstBarIso: string;
  lastBarIso: string;
  closedIndexAtAnchor: number;
  state: "serves-cell" | "usable" | "no-closed-bar" | "unused";
}

interface MtfResponse {
  result?: AnalysisResult;
  mtf?: {
    roles: { htf?: Timeframe; itf: Timeframe; etf?: Timeframe };
    anchorTimeframe: Timeframe;
    anchorCloseIso: string;
    window: { startIso: string; endIso: string };
    frames: MtfFrameReport[];
    unusedTimeframes: Timeframe[];
    warnings: string[];
    timeSemantics: Record<string, string>;
  };
  datasets?: { fileName: string; timeframe: Timeframe; rowCount: number; rejectedCount: number }[];
  error?: { message?: string };
}

const newDataset = (): MtfDataset => ({
  timeframe: "1h",
  is24x7: false,
  symbol: "",
  validating: false,
});

function MtfImportPanel({ onBack }: { onBack: () => void }) {
  const fileRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [datasets, setDatasets] = useState<MtfDataset[]>([newDataset(), newDataset()]);
  const [symbol, setSymbol] = useState("");
  const [anchor, setAnchor] = useState<Timeframe | "">("");
  const [asOf, setAsOf] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [response, setResponse] = useState<MtfResponse | undefined>();

  const patch = (i: number, p: Partial<MtfDataset>) =>
    setDatasets((ds) => ds.map((d, k) => (k === i ? { ...d, ...p } : d)));

  const declaredTfs = datasets
    .filter((d) => d.file)
    .map((d) => d.timeframe);
  const anchorOptions = [...new Set(declaredTfs)];

  const validateOne = async (i: number) => {
    const d = datasets[i];
    if (!d.file) return;
    patch(i, { validating: true, error: undefined });
    const form = new FormData();
    form.set("file", d.file);
    const qs = new URLSearchParams();
    qs.set("timeframe", d.timeframe);
    if (d.is24x7) qs.set("is24x7", "true");
    try {
      const res = await fetch(`/api/import/validate?${qs}`, { method: "POST", body: form });
      const body = (await res.json()) as { result?: ValidateResult; error?: { message?: string } };
      if (!res.ok || !body.result) {
        patch(i, { validating: false, error: body.error?.message ?? `validation failed (HTTP ${res.status})`, validation: undefined });
        return;
      }
      patch(i, { validating: false, validation: body.result });
    } catch (e) {
      patch(i, { validating: false, error: e instanceof Error ? e.message : "validation failed" });
    }
  };

  const run = async () => {
    setError(undefined);
    setResponse(undefined);
    setRunning(true);
    try {
      const form = new FormData();
      datasets.forEach((d) => {
        if (d.file) form.append("files", d.file);
      });
      form.set(
        "meta",
        JSON.stringify(
          datasets
            .filter((d) => d.file)
            .map((d) => ({
              ...(d.symbol.trim() !== "" ? { symbol: d.symbol.trim() } : {}),
              timeframe: d.timeframe,
              ...(d.is24x7 ? { is24x7: true } : {}),
            })),
        ),
      );
      form.set("symbol", symbol.trim().toUpperCase());
      form.set("anchor", anchor);
      if (asOf.trim() !== "") form.set("asOf", asOf.trim());
      const res = await fetch("/api/import/mtf-analysis", { method: "POST", body: form });
      const body = (await res.json()) as MtfResponse;
      if (!res.ok || !body.result) {
        setError(body.error?.message ?? `MTF analysis failed (HTTP ${res.status})`);
        return;
      }
      setResponse(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "MTF analysis failed");
    } finally {
      setRunning(false);
    }
  };

  const fileCount = datasets.filter((d) => d.file).length;
  const canRun =
    fileCount >= 2 &&
    symbol.trim() !== "" &&
    anchor !== "" &&
    !running;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader
          title="Multi-timeframe upload"
          description="2–4 CSV datasets of the SAME instrument at different timeframes. The canonical engine joins them causally — a timeframe contributes only bars fully closed at the anchor. Never merges instruments, never fabricates missing bars."
        />
        <CardContent className="space-y-4">
          {datasets.map((d, i) => (
            <div key={i} className="space-y-2 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <input
                  ref={(el) => { fileRefs.current[i] = el; }}
                  type="file"
                  accept=".csv,.txt,text/csv,text/plain"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    patch(i, { file: f, validation: undefined, error: undefined });
                  }}
                />
                <Button variant="secondary" onClick={() => fileRefs.current[i]?.click()}>
                  {d.file ? "Replace" : `File ${i + 1}`}
                </Button>
                <span className="break-all text-muted-foreground">{d.file?.name ?? "no file"}</span>
                {datasets.length > 2 ? (
                  <button
                    className="ml-auto text-muted-foreground hover:text-foreground"
                    onClick={() => setDatasets((ds) => ds.filter((_, k) => k !== i))}
                  >
                    remove
                  </button>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-xs">
                <label className="space-y-1">
                  <span className="font-medium">Timeframe</span>
                  <select
                    value={d.timeframe}
                    onChange={(e) => patch(i, { timeframe: e.target.value as Timeframe, validation: undefined })}
                    className="w-full rounded-md border border-border bg-surface px-2 py-1.5"
                  >
                    {TIMEFRAMES.map((tf) => (
                      <option key={tf} value={tf}>{tf}</option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="font-medium">Calendar</span>
                  <select
                    value={d.is24x7 ? "crypto" : "weekday"}
                    onChange={(e) => patch(i, { is24x7: e.target.value === "crypto" })}
                    className="w-full rounded-md border border-border bg-surface px-2 py-1.5"
                  >
                    <option value="weekday">Weekday market</option>
                    <option value="crypto">Crypto / 24-7</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="font-medium">Instrument tag (optional)</span>
                  <input
                    value={d.symbol}
                    onChange={(e) => patch(i, { symbol: e.target.value })}
                    placeholder="must match run symbol"
                    className="w-full rounded-md border border-border bg-surface px-2 py-1.5"
                  />
                </label>
                <div className="flex items-end">
                  <Button variant="secondary" onClick={() => void validateOne(i)} disabled={!d.file || d.validating}>
                    {d.validating ? "Validating…" : "Validate"}
                  </Button>
                </div>
              </div>
              {d.validation ? (
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <Stat label="Rows" value={String(d.validation.rowCount)} />
                  <Stat label="Gaps" value={String(d.validation.stats.gaps)} />
                  <Stat label="Range" value={`${d.validation.stats.firstBarIso.slice(0, 10)} → ${d.validation.stats.lastBarIso.slice(0, 10)}`} wide />
                  <Stat
                    label="Interval hint"
                    value={
                      d.validation.timeframeHint ??
                      (d.validation.intervalHintMs !== undefined
                        ? `~${Math.round(d.validation.intervalHintMs / 60000)}m`
                        : "—")
                    }
                  />
                </div>
              ) : null}
              {d.error ? <Notice tone="error" title="Validation failed">{d.error}</Notice> : null}
            </div>
          ))}
          {datasets.length < 4 ? (
            <Button variant="secondary" onClick={() => setDatasets((ds) => [...ds, newDataset()])}>
              Add another timeframe
            </Button>
          ) : null}

          {response?.mtf ? (
            <div className="space-y-3">
              <Notice tone="info" title={`MTF analysis complete — anchor ${response.mtf.anchorTimeframe}`}>
                Roles: htf={response.mtf.roles.htf ?? "none"}, itf={response.mtf.roles.itf}, etf=
                {response.mtf.roles.etf ?? "none"}. Anchor close{" "}
                {response.mtf.anchorCloseIso.slice(0, 19)}Z. Common window{" "}
                {response.mtf.window.startIso.slice(0, 10)} → {response.mtf.window.endIso.slice(0, 10)}.
                {response.mtf.unusedTimeframes.length > 0
                  ? ` Unused uploads: ${response.mtf.unusedTimeframes.join(", ")}.`
                  : ""}
              </Notice>
              {response.mtf.warnings.length > 0 ? (
                <Notice tone="warning" title="Alignment warnings">
                  <ul className="list-disc space-y-0.5 pl-4">
                    {response.mtf.warnings.map((w, k) => (
                      <li key={k}>{w}</li>
                    ))}
                  </ul>
                </Notice>
              ) : null}
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead className="border-b border-border bg-surface-elevated">
                    <tr>
                      {["Role", "TF", "File", "Bars", "Range", "Closed@anchor", "State"].map((h) => (
                        <th key={h} className="px-2 py-1.5 text-left font-medium text-muted-foreground">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {response.mtf.frames.map((f, i) => (
                      <tr key={i} className="border-b border-border/50 last:border-0">
                        <td className="px-2 py-1 font-mono">{f.role}</td>
                        <td className="px-2 py-1">{f.timeframe}</td>
                        <td className="px-2 py-1 break-all">{f.fileName ?? "—"}</td>
                        <td className="px-2 py-1 font-mono">{f.bars}</td>
                        <td className="px-2 py-1 font-mono whitespace-nowrap">
                          {f.firstBarIso.slice(0, 10)} → {f.lastBarIso.slice(0, 10)}
                        </td>
                        <td className="px-2 py-1 font-mono">{f.closedIndexAtAnchor}</td>
                        <td className="px-2 py-1">{f.state}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {response.result ? (
                <Notice tone="info" title="Anchor-bar records">
                  {response.result.opportunities.length} ranked, {response.result.developing.length} developing
                  {response.result.opportunities[0]?.alignment
                    ? `. Alignment: ${response.result.opportunities[0].alignment.state} ` +
                      `(score ${response.result.opportunities[0].alignment.alignmentScore})`
                    : ""}
                  .
                </Notice>
              ) : null}
            </div>
          ) : null}

          {error ? <Notice tone="error" title="MTF analysis failed">{error}</Notice> : null}
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader title="Run settings" description="One instrument, canonical roles, causal anchor." />
        <CardContent className="space-y-4">
          <label className="block space-y-1 text-xs">
            <span className="font-medium">Instrument symbol (applies to every file)</span>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="e.g. NIFTY50, EURUSD"
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5"
            />
          </label>
          <label className="block space-y-1 text-xs">
            <span className="font-medium">Analysis timeframe (anchor)</span>
            <select
              value={anchor}
              onChange={(e) => setAnchor(e.target.value as Timeframe)}
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5"
            >
              <option value="">choose…</option>
              {anchorOptions.map((tf) => (
                <option key={tf} value={tf}>{tf}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-xs">
            <span className="font-medium">Anchor timestamp (optional ISO/UTC)</span>
            <input
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              placeholder="defaults to last fully-closed common bar"
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5"
            />
          </label>
          <Button onClick={() => void run()} disabled={!canRun}>
            {running ? "Analyzing…" : "Run MTF analysis"}
          </Button>
          <Notice tone="info" title="Causal guarantee">
            <p>
              At the anchor, a timeframe contributes only bars whose close is at or before it.
              A frame with no closed bar contributes vote-0 context — never a bullish/bearish
              guess. Per-file timezones without an explicit offset are interpreted as the
              server clock and flagged in warnings.
            </p>
          </Notice>
          <Button variant="secondary" onClick={onBack}>Back to single-file import</Button>
        </CardContent>
      </Card>
    </div>
  );
}

