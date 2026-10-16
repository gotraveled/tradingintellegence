"use client";

/**
 * Chart Analyst workspace â€” screenshot â†’ structured report.
 *
 * Upload/preview/replace/remove an image, add optional context (symbol, market,
 * timeframe, last price, horizon, price-axis calibration), and run the
 * deterministic pixel analysis. When a local vision runtime is configured the
 * operator sees its status and any narrative â€” images never leave this
 * deployment. No OCR is installed: numeric axis values are never read from
 * pixels, so calibration uses only user-supplied anchors.
 */
import { useEffect, useRef, useState } from "react";
import { ImageUp, ScanEye, X } from "lucide-react";
import type { ScreenshotReport } from "@/lib/chart-analysis/report";
import type { EvidenceRegion } from "@/lib/chart-analysis/evidence";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";

interface RuntimeStatus {
  configured: boolean;
  reachable: boolean;
  model?: string;
  note?: string;
  narrative?: { state: string; detail?: string; status?: number; reason?: string; afterMs?: number };
}

interface ApiResult {
  report: ScreenshotReport;
  runtime: RuntimeStatus;
  provenance: string;
}

type Stage = "pick" | "ready" | "analyzing" | "done";

const HORIZONS = [
  { id: "intraday", label: "Intraday" },
  { id: "swing", label: "Swing" },
  { id: "position", label: "Position / longer term" },
] as const;

export function ChartAnalystWorkspace() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | undefined>();
  const [previewUrl, setPreviewUrl] = useState<string | undefined>();
  const [stage, setStage] = useState<Stage>("pick");
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<ApiResult | undefined>();
  const [symbol, setSymbol] = useState("");
  const [timeframe, setTimeframe] = useState("");
  const [price, setPrice] = useState("");
  const [horizon, setHorizon] = useState<(typeof HORIZONS)[number]["id"]>("swing");
  const [showAxis, setShowAxis] = useState(false);
  const [topPrice, setTopPrice] = useState("");
  const [bottomPrice, setBottomPrice] = useState("");
  const [tickPrices, setTickPrices] = useState("");
  const [showOverlay, setShowOverlay] = useState(true);
  const [overlayKinds, setOverlayKinds] = useState<Record<EvidenceRegion["kind"], boolean>>({
    "candle-cluster": false, // dense â€” opt-in, zones/ticks are the useful default
    zone: true,
    "axis-tick": true,
  });
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [axisScale, setAxisScale] = useState<"auto" | "linear" | "log">("auto");

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const pick = (f: File | undefined) => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(undefined);
    setResult(undefined);
    setError(undefined);
    if (!f) {
      setFile(undefined);
      setStage("pick");
      return;
    }
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    setStage("ready");
  };

  const analyze = async () => {
    if (!file) return;
    setStage("analyzing");
    setError(undefined);
    const num = (s: string) => (s.trim() && Number.isFinite(Number(s)) ? Number(s) : undefined);
    const ticks = tickPrices
      .split(/[\s,]+/)
      .map((t) => Number(t))
      .filter((n) => Number.isFinite(n) && n > 0);
    const priceAxis =
      showAxis && (num(topPrice) !== undefined || num(bottomPrice) !== undefined || ticks.length > 0)
        ? {
            ...(num(topPrice) !== undefined ? { topPrice: num(topPrice) } : {}),
            ...(num(bottomPrice) !== undefined ? { bottomPrice: num(bottomPrice) } : {}),
            ...(ticks.length > 0 ? { tickPrices: ticks } : {}),
            scale: axisScale,
          }
        : undefined;
    const form = new FormData();
    form.set("image", file);
    form.set(
      "context",
      JSON.stringify({
        ...(symbol.trim() ? { symbol: symbol.trim() } : {}),
        ...(timeframe.trim() ? { timeframe: timeframe.trim() } : {}),
        ...(num(price) !== undefined ? { currentPrice: num(price) } : {}),
        ...(priceAxis !== undefined ? { priceAxis } : {}),
        horizon,
      }),
    );
    try {
      const res = await fetch("/api/chart-analysis", { method: "POST", body: form });
      const body = (await res.json()) as { result?: ApiResult; error?: { message?: string } };
      if (!res.ok || !body.result) {
        setError(body.error?.message ?? `analysis failed (HTTP ${res.status})`);
        setStage("ready");
        return;
      }
      setResult(body.result);
      setStage("done");
    } catch {
      setError("The analysis service could not be reached.");
      setStage("ready");
    }
  };

  const report = result?.report;
  const selectedRegion = report?.evidence?.find((r) => r.id === selectedId);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <Card>
        <CardHeader
          title="Chart screenshot"
          description="PNG, JPEG, or WebP. Analyzed locally â€” the image is never stored or sent to a third party."
          action={
            file ? (
              <Button variant="ghost" size="sm" onClick={() => pick(undefined)} aria-label="Remove image">
                <X className="size-4" /> Remove
              </Button>
            ) : undefined
          }
        />
        <CardContent>
          {stage === "pick" ? (
            <EmptyState
              icon={ImageUp}
              title="Drop a chart screenshot"
              description="Candlestick charts work best â€” standard green/red palettes are detected automatically."
              action={<Button onClick={() => fileRef.current?.click()}>Select image</Button>}
            />
          ) : (
            <div className="space-y-3">
              {previewUrl ? (
                <div className="relative max-h-[480px] w-full overflow-hidden rounded-md border border-border bg-surface-elevated">
                  {/* eslint-disable-next-line @next/next/no-img-element -- local object URL, not an optimizable asset */}
                  <img
                    src={previewUrl}
                    alt="Uploaded chart screenshot"
                    className="max-h-[480px] w-full object-contain"
                  />
                  {showOverlay && report?.evidence
                    ? report.evidence
                        .filter((r) => overlayKinds[r.kind])
                        .map((r) => <EvidenceBox key={r.id} region={r} selected={r.id === selectedId} onSelect={() => setSelectedId(r.id === selectedId ? undefined : r.id)} />)
                    : null}
                </div>
              ) : null}
              {report?.evidence && report.evidence.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <button
                    onClick={() => setShowOverlay(!showOverlay)}
                    className="rounded-md border border-border px-2 py-0.5 text-muted-foreground"
                  >
                    Overlays {showOverlay ? "on" : "off"}
                  </button>
                  {(["zone", "axis-tick", "candle-cluster"] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setOverlayKinds((p) => ({ ...p, [k]: !p[k] }))}
                      className={`rounded-md border px-2 py-0.5 ${overlayKinds[k] ? "border-primary/50 text-foreground" : "border-border text-muted-foreground"}`}
                    >
                      {k === "zone" ? "Zones (inferred)" : k === "axis-tick" ? "Axis ticks (observed)" : "Candles (observed)"}
                    </button>
                  ))}
                  <span className="text-muted-foreground">Click a region or level to inspect.</span>
                </div>
              ) : null}
              {selectedRegion ? (
                <div className="rounded-md border border-border bg-surface-elevated p-2.5 text-xs space-y-0.5">
                  <p className="font-medium">
                    {selectedRegion.kind} â€” {selectedRegion.id}
                    <span className="ml-2 text-muted-foreground">{selectedRegion.basis}</span>
                  </p>
                  <p className="text-muted-foreground">{selectedRegion.method}</p>
                  <p className="text-muted-foreground">{selectedRegion.limitation}</p>
                  <p className="font-mono text-muted-foreground">
                    px [{selectedRegion.px.x0},{selectedRegion.px.y0} â€“ {selectedRegion.px.x1},{selectedRegion.px.y1}]
                  </p>
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground break-all">{file?.name}</p>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => pick(e.target.files?.[0])}
          />
          {error ? <Notice tone="error" title="Analysis failed" className="mt-4">{error}</Notice> : null}
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader title="Context" description="Optional â€” improves the report's grounding." />
          <CardContent className="space-y-3">
            <label className="block space-y-1 text-xs">
              <span className="font-medium">Symbol</span>
              <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="e.g. NIFTY50" className="w-full rounded-md border border-border bg-surface px-2 py-1.5" />
            </label>
            <label className="block space-y-1 text-xs">
              <span className="font-medium">Timeframe</span>
              <input value={timeframe} onChange={(e) => setTimeframe(e.target.value)} placeholder="e.g. 15m, 1h, 1D" className="w-full rounded-md border border-border bg-surface px-2 py-1.5" />
            </label>
            <label className="block space-y-1 text-xs">
              <span className="font-medium">Last price (optional anchor)</span>
              <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="e.g. 24500.50" className="w-full rounded-md border border-border bg-surface px-2 py-1.5" />
            </label>
            <div className="space-y-1 text-xs">
              <span className="font-medium">Horizon</span>
              <div className="flex gap-1.5">
                {HORIZONS.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => setHorizon(h.id)}
                    className={`rounded-md border px-2 py-1 text-xs ${horizon === h.id ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"}`}
                  >
                    {h.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-md border border-border p-2.5 space-y-2">
              <button
                onClick={() => setShowAxis(!showAxis)}
                className="w-full text-left text-xs font-medium text-muted-foreground"
              >
                Price axis calibration {showAxis ? "â–¾" : "â–¸"}
              </button>
              {showAxis ? (
                <div className="space-y-2 text-xs">
                  <p className="text-muted-foreground">
                    No OCR is installed â€” axis numbers are never read from pixels.
                    Supply values yourself to get real prices; everything stays
                    visual estimates otherwise.
                  </p>
                  {report ? (
                    <p className="text-muted-foreground">
                      {report.calibration.ticksDetected > 0
                        ? `${report.calibration.ticksDetected} candidate tick position${report.calibration.ticksDetected > 1 ? "s" : ""} detected on the ${report.facts ? "chart" : "image"} â€” shown as numbered markers on the image when "Axis ticks" is on. Supply exactly ${report.calibration.ticksDetected} price${report.calibration.ticksDetected > 1 ? "s" : ""}, topâ†’bottom (marker 1 â†’ N), or a top+bottom range.`
                        : "No candidate tick positions were detected â€” you can still calibrate with a top+bottom visible range, or leave it uncalibrated."}
                      {report.calibration.notes.length > 0 ? ` Result: ${report.calibration.status}. ${report.calibration.notes.join(" ")}` : ""}
                    </p>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="text-muted-foreground">Top visible price</span>
                      <input value={topPrice} onChange={(e) => setTopPrice(e.target.value)} inputMode="decimal" placeholder="e.g. 25000" className="w-full rounded-md border border-border bg-surface px-2 py-1.5" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-muted-foreground">Bottom visible price</span>
                      <input value={bottomPrice} onChange={(e) => setBottomPrice(e.target.value)} inputMode="decimal" placeholder="e.g. 24000" className="w-full rounded-md border border-border bg-surface px-2 py-1.5" />
                    </label>
                  </div>
                  <label className="block space-y-1">
                    <span className="text-muted-foreground">Tick prices topâ†’bottom (optional, one per detected label)</span>
                    <input value={tickPrices} onChange={(e) => setTickPrices(e.target.value)} inputMode="decimal" placeholder="e.g. 25000, 24750, 24500" className="w-full rounded-md border border-border bg-surface px-2 py-1.5" />
                  </label>
                  <div className="space-y-1">
                    <span className="text-muted-foreground">Scale</span>
                    <div className="flex gap-1.5">
                      {(["auto", "linear", "log"] as const).map((s) => (
                        <button
                          key={s}
                          onClick={() => setAxisScale(s)}
                          className={`rounded-md border px-2 py-1 text-xs ${axisScale === s ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"}`}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
            <Button onClick={analyze} disabled={!file || stage === "analyzing"} className="w-full">
              <ScanEye className="size-4" />
              {stage === "analyzing" ? "Analyzingâ€¦" : "Analyze screenshot"}
            </Button>
          </CardContent>
        </Card>

        {result?.runtime ? (
          <Notice
            tone={result.runtime.narrative?.state === "success" ? "info" : "warning"}
            title={
              result.runtime.narrative?.state === "success"
                ? `Model narrative: ${result.runtime.model ?? "local runtime"}`
                : "Deterministic analysis only"
            }
          >
            {result.runtime.note}
            {result.runtime.narrative && result.runtime.narrative.state !== "success" ? (
              <span className="block mt-1 text-muted-foreground">
                Narrative: {result.runtime.narrative.state}
                {result.runtime.narrative.status !== undefined ? ` (HTTP ${result.runtime.narrative.status})` : ""}
                {result.runtime.narrative.reason ? ` â€” ${result.runtime.narrative.reason}` : ""}
                {result.runtime.narrative.detail ? ` â€” ${result.runtime.narrative.detail}` : ""}
              </span>
            ) : null}
          </Notice>
        ) : null}
      </div>

      {report ? (
        <Card className="lg:col-span-2">
          <CardHeader
            title={
              report.verdict === "no_trade"
                ? "NO TRADE â€” insufficient evidence"
                : report.verdict === "wait"
                  ? "WAIT â€” no clear edge"
                  : "Analysis"
            }
            description={report.verdictReason}
          />
          <CardContent className="space-y-5">
            <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
              <Fact label="Candles read" value={String(report.facts.candleCount)} />
              <Fact label="Bull / Bear" value={`${report.facts.bullishCount} / ${report.facts.bearishCount}`} />
              <Fact label="Trend" value={report.facts.trendDirection} />
              <Fact label="Last position" value={report.facts.lastPositionNote} />
            </div>

            <Notice
              tone={report.calibration.status === "calibrated" ? "info" : "warning"}
              title={`Price axis: ${report.calibration.status}`}
            >
              {report.calibration.status === "calibrated"
                ? `${report.calibration.anchorCount} anchor${report.calibration.anchorCount > 1 ? "s" : ""} (${report.calibration.source}) â€” ${report.calibration.scale} scale${report.calibration.notes.length > 0 ? `. ${report.calibration.notes.join(" ")}` : ""}`
                : report.calibration.status === "approximate"
                  ? `Scale undetermined â€” levels are coarse estimates. ${report.calibration.notes.join(" ")}`
                  : report.calibration.status === "user-anchored"
                    ? "A single price anchor is a reference point, not a scale â€” levels stay visual."
                    : `No usable price axis â€” ${report.calibration.notes[0] ?? "levels are screen-space estimates."}`}
            </Notice>

            {report.levels.length > 0 ? (
              <ReportSection title="Levels">
                <ul className="list-disc space-y-0.5 pl-4">
                  {report.levels.map((l, i) => (
                    <li
                      key={i}
                      onClick={() => setSelectedId(selectedId === `zone-${i}` ? undefined : `zone-${i}`)}
                      className={`cursor-pointer rounded px-1 -mx-1 ${selectedId === `zone-${i}` ? "bg-primary/10" : "hover:bg-surface-elevated"}`}
                    >
                      {l.kind === "resistance" ? "Supply" : "Demand"} Ã—{l.touches} â€” {l.bandPct}
                      {l.priceTop !== undefined && l.priceBottom !== undefined
                        ? ` â€” â‰ˆ${l.priceBottom}â€“${l.priceTop}${l.calibration === "approximate" ? " (approximate)" : " (calibrated)"}`
                        : l.calibration === "user-anchored"
                          ? " (visual â€” anchored, no scale)"
                          : " (visual â€” uncalibrated)"}
                    </li>
                  ))}
                </ul>
              </ReportSection>
            ) : null}

            <ReportSection title="Trend">{report.trend}</ReportSection>
            <ReportSection title="Market structure">{report.structure}</ReportSection>
            {report.supplyDemand.length > 0 ? (
              <ReportSection title="Demand / supply zones">
                <ul className="list-disc space-y-0.5 pl-4">
                  {report.supplyDemand.map((z, i) => <li key={i}>{z}</li>)}
                </ul>
              </ReportSection>
            ) : null}
            {report.scenarios.length > 0 ? (
              <ReportSection title="Scenarios">
                <div className="space-y-3">
                  {report.scenarios.map((s, i) => (
                    <div key={i} className="rounded-md border border-border p-3 text-xs space-y-1">
                      <p className="font-medium capitalize">{s.side}</p>
                      <p><span className="text-muted-foreground">Trigger:</span> {s.trigger}</p>
                      <p><span className="text-muted-foreground">Invalidation:</span> {s.invalidation}</p>
                      <p><span className="text-muted-foreground">Entry:</span> {s.entryNote}</p>
                      <p><span className="text-muted-foreground">Target:</span> {s.targetNote}</p>
                      {s.riskRewardNote ? <p><span className="text-muted-foreground">R/R:</span> {s.riskRewardNote}</p> : null}
                    </div>
                  ))}
                </div>
              </ReportSection>
            ) : null}
            {report.riskNotes.length > 0 ? (
              <ReportSection title="Risk notes">
                <ul className="list-disc space-y-0.5 pl-4">
                  {report.riskNotes.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </ReportSection>
            ) : null}
            {report.modelNarrative ? (
              <ReportSection title={`Model narrative â€” ${report.modelNarrative.runtime}`}>
                <p className="whitespace-pre-wrap">{report.modelNarrative.text}</p>
              </ReportSection>
            ) : null}
            <div className="rounded-md border border-border bg-surface-elevated p-3 text-xs space-y-1">
              {report.assumptions.length > 0 ? (
                <p><span className="font-medium">Assumptions:</span> {report.assumptions.join(" ")}</p>
              ) : null}
              <p><span className="font-medium">Limitations:</span> {report.limitations.join(" ")}</p>
              <p className="text-muted-foreground">{result?.provenance}</p>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="font-mono text-sm">{value}</p>
    </div>
  );
}

function ReportSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="text-sm leading-relaxed">{children}</div>
    </div>
  );
}

/**
 * An evidence rectangle in normalized coordinates — positions are fractions of
 * the displayed image box, so the overlay scales with any preview size without
 * drift. Style per kind: observed = solid outline, inferred = dashed.
 */
function EvidenceBox({ region, selected, onSelect }: { region: EvidenceRegion; selected: boolean; onSelect: () => void }) {
  const color =
    region.kind === "zone" ? "border-amber-400/70 bg-amber-400/10" :
    region.kind === "axis-tick" ? "border-sky-400/70 bg-sky-400/10" :
    "border-emerald-400/50 bg-emerald-400/5";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Evidence ${region.id}`}
      title={`${region.kind} — ${region.basis}`}
      className={`absolute border ${region.basis === "inferred" ? "border-dashed" : ""} ${color} ${selected ? "ring-2 ring-primary" : ""}`}
      style={{
        left: `${region.rect.x * 100}%`,
        top: `${region.rect.y * 100}%`,
        width: `${region.rect.w * 100}%`,
        height: `${region.rect.h * 100}%`,
      }}
    >
      {region.kind === "axis-tick" && region.tickIndex !== undefined ? (
        <span className="absolute -top-3 right-0 rounded bg-sky-500/80 px-0.5 text-[9px] leading-3 text-white">
          {region.tickIndex + 1}
        </span>
      ) : null}
    </button>
  );
}
