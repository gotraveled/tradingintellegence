"use client";

/**
 * Experiment Registry panel — browser-local research history for the
 * Strategy Comparison Lab (er1). Lists recorded runs, opens frozen records,
 * diffs two records, and exports/imports versioned JSON.
 *
 * Honesty contract baked into the UI:
 *  - Records are ledger entries, not proof of execution — imports are
 *    user-supplied claims and are labelled as such.
 *  - "No prior exposure recorded in this registry" is the strongest status
 *    shown; the panel never says a period is "untouched" or "independent".
 *  - One comparison = one experiment; strategies are rows, not experiments.
 */
import { useCallback, useEffect, useState } from "react";
import { Download, FileUp, GitCompareArrows } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import {
  browserStore,
  diffRecords,
  exportRecords,
  importRecords,
  type ExperimentRecord,
} from "@/lib/services/experiment-registry";
import {
  buildManifest,
  classifyDiffPath,
  exportManifest,
  exportVerification,
  importManifest,
  verifyManifest,
  type VerificationReport,
} from "@/lib/services/reproducibility";
import {
  buildBundle,
  compareReplay,
  exportBundle,
  importBundle,
  reconstructForm,
  verifyBundle,
  type BundleVerification,
  type ReplayBundle,
  type ReplayComparisonReport,
} from "@/lib/services/replay-bundle";
import type { StrategyComparisonResult } from "@/lib/services/strategy-comparison";
import {
  archiveStatus,
  archiveSummary,
  browserArchiveStore,
  buildArchivedBundle,
  clearArchive,
  deleteArchived,
  type ArchiveSummary,
  type RecordArchiveStatus,
} from "@/lib/services/input-archive";

const STATUS_LABEL: Record<string, string> = {
  repeat: "exact repeat",
  exposed: "previously exposed period",
  "consumed-window-overlap": "consumed-window overlap",
  overlap: "overlapping period",
  "no-prior-exposure": "no prior exposure recorded",
  unknown: "exposure unknown",
};

const fmtDiff = (v: unknown): string => {
  if (v === undefined) return "—";
  const s = JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
};

export function ExperimentRegistryPanel() {
  const [records, setRecords] = useState<ExperimentRecord[]>([]);
  const [persistent, setPersistent] = useState(false);
  const [limitation, setLimitation] = useState("");
  const [filter, setFilter] = useState("");
  const [openId, setOpenId] = useState<string | undefined>();
  const [selected, setSelected] = useState<string[]>([]);
  const [notices, setNotices] = useState<string[]>([]);

  const reload = useCallback(() => {
    const store = browserStore();
    setRecords(store.load());
    setPersistent(store.persistent);
    setLimitation(store.limitation);
  }, []);

  useEffect(() => {
    queueMicrotask(reload); // async — setState is forbidden inside the effect body
    const onChange = () => reload();
    window.addEventListener("ti-registry-changed", onChange);
    window.addEventListener("storage", onChange); // other tabs
    return () => {
      window.removeEventListener("ti-registry-changed", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [reload]);

  const visible = records.filter((r) => {
    const q = filter.trim().toLowerCase();
    if (q === "") return true;
    return r.fingerprint.toLowerCase().includes(q) ||
      r.strategies.some((s) => s.id.toLowerCase().includes(q)) ||
      r.datasets.some((d) => `${d.symbol}@${d.timeframe}`.toLowerCase().includes(q));
  });

  const [verify, setVerify] = useState<{ recordId: string; report: VerificationReport } | undefined>();
  const [verifyNotices, setVerifyNotices] = useState<string[]>([]);
  const [archive, setArchive] = useState<ArchiveSummary | undefined>();
  const [openArchive, setOpenArchive] = useState<RecordArchiveStatus | undefined>();
  const [archiveMsg, setArchiveMsg] = useState<string | undefined>();
  const [bundle, setBundle] = useState<{ b: ReplayBundle; v: BundleVerification; notices: string[] } | undefined>();
  const [replayErr, setReplayErr] = useState<string | undefined>();
  const [replayReport, setReplayReport] = useState<ReplayComparisonReport | undefined>();
  const [replaying, setReplaying] = useState(false);

  const importReplay = async (file: File) => {
    setReplayErr(undefined);
    setReplayReport(undefined);
    const out = importBundle(await file.text());
    if (!out.ok || out.bundle === undefined) {
      setReplayErr(out.error ?? "import failed");
      setBundle(undefined);
      return;
    }
    setBundle({ b: out.bundle, v: await verifyBundle(out.bundle), notices: out.notices });
  };

  const runReplay = async () => {
    if (bundle === undefined || bundle.v.ineligible.length > 0) return;
    setReplaying(true);
    setReplayErr(undefined);
    try {
      const res = await fetch("/api/compare/strategies", {
        method: "POST",
        body: reconstructForm(bundle.b),
      });
      const body = await res.json() as { result?: StrategyComparisonResult; error?: { message?: string } };
      if (!res.ok || body.result === undefined) {
        setReplayErr(body.error?.message ?? `replay failed (HTTP ${res.status})`);
        return;
      }
      // Replay output stays separate — it is never registered or merged.
      setReplayReport(compareReplay(bundle.b, body.result));
    } catch (e) {
      setReplayErr(e instanceof Error ? e.message : "replay request failed");
    } finally {
      setReplaying(false);
    }
  };

  const open = records.find((r) => r.recordId === openId);
  const pair = selected.map((id) => records.find((r) => r.recordId === id)).filter((r): r is ExperimentRecord => r !== undefined);
  const diff = pair.length === 2 ? diffRecords(pair[0], pair[1]) : undefined;

  const refreshArchive = async () => {
    setArchive(await archiveSummary(browserArchiveStore()));
  };

  // Archive summary refreshes with the registry — the workspace dispatches
  // the same event after an opt-in archive write.
  useEffect(() => {
    queueMicrotask(() => void refreshArchive()); // async — no sync setState in effects
  }, [records]);

  // Per-record archive status for the open detail row.
  useEffect(() => {
    if (open === undefined) {
      queueMicrotask(() => setOpenArchive(undefined)); // async — no sync setState in effects
      return;
    }
    const store = browserArchiveStore();
    let cancelled = false;
    void archiveStatus(store, open).then((s) => { if (!cancelled) setOpenArchive(s); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.recordId, archive]);

  const exportArchivedBundle = async () => {
    if (open === undefined) return;
    const out = await buildArchivedBundle(browserArchiveStore(), open);
    if (!out.ok || out.bundle === undefined) {
      setArchiveMsg(out.error ?? "archive export failed");
      return;
    }
    const blob = new Blob([exportBundle(out.bundle)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `replay-bundle-${open.recordId.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    const v = out.verification;
    setArchiveMsg(v !== undefined && v.ineligible.length > 0
      ? `Bundle exported but not replay-eligible: ${v.ineligible.join("; ")}`
      : "Full replay bundle exported from archived inputs (verified).");
  };

  const removeArchived = async () => {
    if (open === undefined) return;
    const r = await deleteArchived(browserArchiveStore(), open.recordId);
    setArchiveMsg(r.ok ? "Archived inputs deleted — experiment metadata unchanged." : r.error);
    await refreshArchive();
  };

  const wipeArchive = async () => {
    const r = await clearArchive(browserArchiveStore());
    setArchiveMsg(r.ok ? "Input archive cleared — experiment metadata unchanged." : r.error);
    await refreshArchive();
  };

  const toggleSelect = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(-2)));

  const exportAll = () => {
    const blob = new Blob([exportRecords(records)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `experiment-registry-${records.length}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importFile = async (file: File) => {
    const store = browserStore();
    const outcome = importRecords(await file.text(), store.load());
    if (!outcome.ok) {
      setNotices([`import failed — ${outcome.error ?? "unknown error"}`]);
      return;
    }
    store.save(outcome.history);
    setNotices(outcome.notices);
    reload();
    window.dispatchEvent(new Event("ti-registry-changed"));
  };

  return (
    <Card>
      <CardHeader
        title={`Research history — ${records.length} recorded experiment${records.length === 1 ? "" : "s"}`}
        description="Registry of frozen comparison runs and test-period exposure. One comparison = one experiment; strategies within it are rows, not independent experiments."
      />
      <CardContent className="space-y-3 text-sm">
        <Notice tone="info" title="Storage">
          {limitation}
          {!persistent && " Export before leaving the page."}
        </Notice>

        <div className="flex flex-wrap items-center gap-2">
          <input
            className="w-64 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            placeholder="filter by fingerprint, strategy, or series"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <Button size="sm" variant="outline" onClick={exportAll} disabled={records.length === 0}>
            <Download className="mr-1 h-4 w-4" /> Export all
          </Button>
          <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-xs text-foreground hover:border-border-strong hover:bg-surface-hover">
            <FileUp className="h-4 w-4" /> Import JSON
            <input type="file" accept=".json,application/json" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} />
          </label>
          <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-xs text-foreground hover:border-border-strong hover:bg-surface-hover">
            <FileUp className="h-4 w-4" /> Import replay bundle
            <input type="file" accept=".json,application/json" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void importReplay(f); e.target.value = ""; }} />
          </label>
          {pair.length === 2 && (
            <Button size="sm" variant="outline" onClick={() => setSelected([])}>
              clear diff
            </Button>
          )}
        </div>

        {notices.length > 0 && (
          <Notice tone="warning" title="Import notices">
            <ul className="list-disc space-y-1 pl-4">
              {notices.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          </Notice>
        )}

        {/* ---- Local input archive (V1.1, opt-in) ---- */}
        {archive !== undefined && (
          <div className="rounded-md border border-border bg-surface-elevated p-2 text-xs">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">Input archive</span>
              <span className="text-muted-foreground">
                {archive.persistent ? "persistent (IndexedDB)" : "NOT persistent"} ·
                {archive.experiments === 0
                  ? " no archived inputs"
                  : ` ${archive.experiments} experiment(s) · ${(archive.totalBytes / 1024).toFixed(1)} KiB`}
              </span>
              {archive.experiments > 0 && (
                <Button size="sm" variant="outline" onClick={() => void wipeArchive()}>
                  clear archive
                </Button>
              )}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">{archive.limitation}</div>
            {archiveMsg !== undefined && (
              <div className="mt-1 text-[11px]">{archiveMsg}</div>
            )}
          </div>
        )}

        {visible.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {records.length === 0
              ? "No experiments recorded yet — completed comparisons register automatically."
              : "No records match the filter."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1 pr-2 font-medium"></th>
                  <th className="py-1 pr-3 font-medium">Recorded (wall clock)</th>
                  <th className="py-1 pr-3 font-medium">Experiment</th>
                  <th className="py-1 pr-3 font-medium">Strategies</th>
                  <th className="py-1 pr-3 font-medium">Test period</th>
                  <th className="py-1 pr-3 font-medium">Exposure</th>
                  <th className="py-1 font-medium">Origin</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.recordId}
                    className={`cursor-pointer border-b border-border/50 align-top hover:bg-surface-hover ${openId === r.recordId ? "bg-surface-elevated" : ""}`}
                    onClick={() => !r.unsupported && setOpenId(openId === r.recordId ? undefined : r.recordId)}>
                    <td className="py-1.5 pr-2" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.includes(r.recordId)}
                        disabled={r.unsupported === true}
                        onChange={() => toggleSelect(r.recordId)} aria-label="select for diff" />
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{r.createdAt.slice(0, 19).replace("T", " ")}</td>
                    <td className="py-1.5 pr-3">
                      <code className="text-[11px]">{r.fingerprint.slice(0, 12)}…</code>
                      <div className="text-[10px] text-muted-foreground">
                        record {r.recordId.slice(0, 8)}… · {r.protocolVersion}
                        {archive?.byRecord.has(r.recordId) === true && " · inputs archived"}
                      </div>
                    </td>
                    <td className="py-1.5 pr-3">{r.strategies.map((s) => s.id).join(", ")}</td>
                    <td className="py-1.5 pr-3 text-[11px]">{r.testPeriod
                      ? `${r.testPeriod.from.slice(0, 10)}…${r.testPeriod.to.slice(0, 10)}`
                      : "—"}</td>
                    <td className="py-1.5 pr-3">
                      <span className={r.exposure.status === "repeat" || r.exposure.status === "exposed" || r.exposure.status === "consumed-window-overlap"
                        ? "text-warning" : ""}>
                        {STATUS_LABEL[r.exposure.status] ?? r.exposure.status}
                      </span>
                    </td>
                    <td className="py-1.5">
                      {r.unsupported === true
                        ? <span className="text-bearish">unsupported v{r.schemaVersion}</span>
                        : r.identityConflict === true
                          ? <span className="text-bearish">conflict</span>
                          : r.provenance}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {open !== undefined && (
          <div className="rounded-md border border-border bg-surface-elevated p-3 text-xs">
            <div className="mb-2 font-medium">
              Record {open.recordId.slice(0, 12)}… — experiment {open.fingerprint.slice(0, 12)}…
              {open.provenance === "imported" && " · imported record (user-supplied claim — not verified engine output)"}
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              <div><span className="text-muted-foreground">Protocol</span> {open.protocolVersion} / {open.contractVersion}</div>
              <div><span className="text-muted-foreground">Datasets</span> {open.datasets.map((d) => `${d.symbol}@${d.timeframe} (${d.bars})`).join(", ")}</div>
              <div><span className="text-muted-foreground">Evaluation range</span> {open.evaluationRange ? `${open.evaluationRange.from.slice(0, 10)}…${open.evaluationRange.to.slice(0, 10)}` : "—"}</div>
              <div><span className="text-muted-foreground">Shared protocol</span> {fmtDiff(open.shared)}</div>
              <div><span className="text-muted-foreground">Uncertainty</span> {open.uncertaintyMethod ?? "—"}</div>
              <div><span className="text-muted-foreground">Exposure</span> {STATUS_LABEL[open.exposure.status]}{open.exposure.coverage === "partial" ? " · partial coverage" : ""}</div>
              <div><span className="text-muted-foreground">Consumed windows</span> {open.consumedWindows?.length
                ? open.consumedWindows.map((w) => `${w.series} [${w.fromBar}–${w.toBar}]`).join(", ")
                : "—"}{(open.unverifiableWindows ?? 0) > 0 ? ` (+${open.unverifiableWindows} unverifiable)` : ""}</div>
            </div>

            {/* ---- Reproducibility manifest (rm1) ---- */}
            <div className="mt-2 rounded-md border border-border p-2">
              <div className="mb-1 font-medium">Reproducibility manifest</div>
              {(() => {
                const m = buildManifest(open);
                const missing = Object.entries(m.availability)
                  .filter(([, v]) => v !== "recorded").map(([k, v]) => `${k}: ${v}`);
                return (
                  <>
                    <div className="text-muted-foreground">
                      digest <code>{m.digest.slice(0, 16)}…</code> · {m.manifestVersion}
                      {missing.length > 0 && ` · missing: ${missing.join(", ")}`}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="outline" onClick={() => {
                        setVerify({
                          recordId: open.recordId,
                          report: verifyManifest(m, { record: open }),
                        });
                        setVerifyNotices([]);
                      }}>
                        verify
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => {
                        const blob = new Blob([exportManifest(m)], { type: "application/json" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `manifest-${open.recordId.slice(0, 12)}.json`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}>
                        export manifest
                      </Button>
                      {verify?.recordId === open.recordId && (
                        <Button size="sm" variant="outline" onClick={() => {
                          const blob = new Blob([exportVerification(verify.report)], { type: "application/json" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `verification-${open.recordId.slice(0, 12)}.json`;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}>
                          export report
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => {
                        const d0 = open.datasets[0];
                        const b = buildBundle({
                          record: open,
                          // Original CSV bytes are not held by the registry —
                          // a metadata-only bundle, labelled as such.
                          inputs: { symbol: d0?.symbol ?? "unknown", anchor: d0?.timeframe ?? "unknown" },
                        });
                        const blob = new Blob([exportBundle(b)], { type: "application/json" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `replay-bundle-${open.recordId.slice(0, 8)}.json`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}>
                        export bundle (metadata-only)
                      </Button>
                      <label className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border border-border px-2 text-[11px] hover:bg-surface-hover">
                        verify imported manifest…
                        <input type="file" accept=".json,application/json" className="hidden"
                          onChange={async (e) => {
                            const f = e.target.files?.[0]; e.target.value = "";
                            if (!f) return;
                            const out = importManifest(await f.text());
                            if (!out.ok || out.manifest === undefined) {
                              setVerifyNotices([`manifest import failed — ${out.error ?? "unknown"}`]);
                              setVerify(undefined);
                              return;
                            }
                            setVerifyNotices(out.notices);
                            setVerify({
                              recordId: open.recordId,
                              report: verifyManifest(out.manifest, { record: open }),
                            });
                          }} />
                      </label>
                    </div>
                  </>
                );
              })()}
            </div>

            {verifyNotices.length > 0 && (
              <Notice tone="info" title="Manifest import notices">
                <ul className="list-disc space-y-1 pl-4">
                  {verifyNotices.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </Notice>
            )}

            {verify?.recordId === open.recordId && (
              <Notice
                tone={verify.report.overall === "mismatch" ? "error" :
                  verify.report.overall === "unverifiable" || verify.report.overall === "partially-verifiable" ? "warning" : "info"}
                title={`Verification — ${verify.report.overall}`}>
                <div>integrity: {verify.report.integrity} · input identity: {verify.report.inputIdentity}</div>
                <ul className="list-disc space-y-0.5 pl-4">
                  {verify.report.checks.map((c, i) => <li key={i}><code>{c.name}</code>: {c.detail}</li>)}
                </ul>
                <div className="mt-1 text-[11px] text-muted-foreground">{verify.report.caveat}</div>
              </Notice>
            )}

            {/* ---- Archived inputs (V1.1) ---- */}
            <div className="mt-2 rounded-md border border-border p-2">
              <div className="mb-1 font-medium">Archived inputs</div>
              {openArchive === undefined ? (
                <div className="text-muted-foreground">checking…</div>
              ) : openArchive.state === "archived" ? (
                <>
                  <div className="text-muted-foreground">
                    {openArchive.files} file(s) · {(openArchive.totalBytes / 1024).toFixed(1)} KiB —
                    digests verified on restore
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => void exportArchivedBundle()}>
                      export bundle (archived inputs)
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void removeArchived()}>
                      delete archived inputs
                    </Button>
                  </div>
                </>
              ) : openArchive.state === "none" ? (
                <div className="text-muted-foreground">
                  no archived inputs — original CSVs were not stored for this experiment
                  {openArchive.detail !== undefined ? ` (${openArchive.detail})` : ""}
                </div>
              ) : (
                <>
                  <div className="text-warning">
                    {openArchive.state} — {openArchive.detail ?? "archived inputs failed verification"}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => void removeArchived()}>
                      delete archived inputs
                    </Button>
                  </div>
                </>
              )}
            </div>

            <p className="mt-2 text-muted-foreground">{open.exposure.note}</p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">Strategy</th>
                    <th className="py-1 pr-3 font-medium">Result fp</th>
                    <th className="py-1 pr-3 font-medium">Realized n</th>
                    <th className="py-1 pr-3 font-medium">Realized WR</th>
                    <th className="py-1 pr-3 font-medium">Realized E[R]</th>
                    <th className="py-1 font-medium">Cohorts (raw/purged)</th>
                  </tr>
                </thead>
                <tbody>
                  {open.strategies.map((s) => (
                    <tr key={s.id} className="border-b border-border/50">
                      <td className="py-1 pr-3">{s.id}</td>
                      <td className="py-1 pr-3"><code>{s.resultFingerprint.slice(0, 10)}…</code></td>
                      <td className="py-1 pr-3">{s.row.realizedCount}</td>
                      <td className="py-1 pr-3">{s.row.realizedWinRate?.toFixed(3) ?? "—"}</td>
                      <td className="py-1 pr-3">{s.row.realizedExpectancyR?.toFixed(3) ?? "—"}</td>
                      <td className="py-1">
                        {s.cohorts.length === 0 ? "—" : s.cohorts.map((c) =>
                          `${c.name}: ${c.scenarioCount}${c.purgedCount !== undefined ? `/${c.retainedCount ?? "?"}` : ""}`,
                        ).join(" · ")}
                        {s.boundaryStatus ? ` · boundaries ${s.boundaryStatus}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {diff !== undefined && (
          <div className="rounded-md border border-border p-3 text-xs">
            <div className="mb-2 flex items-center gap-2 font-medium">
              <GitCompareArrows className="h-4 w-4" />
              Difference report — {pair[0].fingerprint.slice(0, 8)}… vs {pair[1].fingerprint.slice(0, 8)}…
            </div>
            {diff.length === 0 ? (
              <p className="text-muted-foreground">No configuration differences — same frozen inputs.</p>
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">Field</th>
                    <th className="py-1 pr-3 font-medium">Change</th>
                    <th className="py-1 pr-3 font-medium">A</th>
                    <th className="py-1 font-medium">B</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.map((d) => (
                    <tr key={d.path} className="border-b border-border/50 align-top">
                      <td className="py-1 pr-3"><code>{d.path}</code></td>
                      <td className="py-1 pr-3">{classifyDiffPath(d.path)}</td>
                      <td className="py-1 pr-3 break-all">{fmtDiff(d.a)}</td>
                      <td className="py-1 break-all">{fmtDiff(d.b)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ---- Imported replay bundle (rb1): verify → eligibility → replay ---- */}
        {replayErr !== undefined && (
          <Notice tone="error" title="Replay bundle">{replayErr}</Notice>
        )}
        {bundle !== undefined && (
          <div className="rounded-md border border-border p-3 text-xs">
            <div className="mb-2 font-medium">
              Replay bundle {bundle.b.bundleVersion} — {bundle.b.files.length} file(s)
              {bundle.v.imported && " · imported (user-supplied evidence)"}
            </div>
            {bundle.notices.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                {bundle.notices.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            )}
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {bundle.v.checks.map((c, i) => (
                <li key={i}><code>{c.name}</code>: <b>{c.status}</b> — {c.detail}</li>
              ))}
            </ul>
            {bundle.v.ineligible.length > 0 ? (
              <Notice tone="warning" title="Replay ineligible">
                <ul className="list-disc space-y-0.5 pl-4">
                  {bundle.v.ineligible.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </Notice>
            ) : (
              <Button size="sm" variant="outline" className="mt-2"
                onClick={() => void runReplay()} disabled={replaying}>
                {replaying ? "Replaying…" : "Run replay via canonical comparison"}
              </Button>
            )}
            {replayReport !== undefined && (
              <div className="mt-3 rounded-md border border-border p-2">
                <div className="mb-1 font-medium">
                  Recorded vs replayed — fingerprint {replayReport.fingerprintMatch ? "MATCHES" : "DIFFERS"} · dataset {replayReport.datasetIdentityMatch ? "MATCHES" : "DIFFERS"}
                </div>
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="py-0.5 pr-3 font-medium">Field</th>
                      <th className="py-0.5 pr-3 font-medium">Status</th>
                      <th className="py-0.5 pr-3 font-medium">Recorded</th>
                      <th className="py-0.5 font-medium">Replayed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {replayReport.fields.map((f) => (
                      <tr key={f.field} className="border-b border-border/50 align-top">
                        <td className="py-0.5 pr-3">{f.field}</td>
                        <td className="py-0.5 pr-3">{f.status}</td>
                        <td className="py-0.5 pr-3 break-all">{fmtDiff(f.recorded)}</td>
                        <td className="py-0.5 break-all">{fmtDiff(f.replayed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-1 text-muted-foreground">{replayReport.note}</p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
