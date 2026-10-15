import { Sparkles, TrendingUp, Watch } from "lucide-react";
import { TradePlan } from "@/components/opportunities/trade-plan";
import { SetupStatusBadge } from "@/components/opportunities/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { formatDateTimeUTC } from "@/lib/utils";
import { describeSetup, getInstrument, timeframeLabel } from "@/lib/constants";
import type {
  AnalysisCell,
  AnalysisResult,
  BacktestOpportunity,
  Opportunity,
  PriceTarget,
  Timeframe,
} from "@/lib/types";

/** Everything the panel needs — a real AnalysisResult scoped to one chart selection. */
export interface LiveAnalysisView {
  result: AnalysisResult;
  cell: AnalysisCell | undefined;
  /** Ranked records matching THIS symbol+timeframe (defensive — may be empty). */
  opportunities: BacktestOpportunity[];
  /** Chart window actually analyzed exceeds the API lookback bound. */
  windowClamped: boolean;
  lookbackDays: number;
}

/**
 * Project a matched BacktestOpportunity into the `Opportunity` subset TradePlan
 * accepts — same mapping rules as `toOpportunities` (entry/stop/targets pass through;
 * nothing invented).
 */
export function toPlanOpportunity(
  record: BacktestOpportunity,
  fallbackPrecision?: number,
): Pick<
  Opportunity,
  "entry" | "stopLoss" | "targets" | "riskReward" | "pricePrecision" | "status"
> {
  return {
    status: record.status,
    entry: record.plan?.entry,
    stopLoss: record.plan?.stopLoss,
    targets: record.plan?.targets as PriceTarget[] | undefined,
    riskReward: record.plan?.riskReward,
    // Catalog precision first; the panel's resolved precision for pass-through symbols.
    pricePrecision: getInstrument(record.symbol)?.pricePrecision ?? fallbackPrecision,
  };
}

/** Unmet reasons from developing records — "watch" state, never signals. */
function developingReasons(
  result: AnalysisResult,
  symbol: string,
  timeframe: Timeframe,
): string[] {
  return result.developing
    .filter((d) => d.symbol === symbol && d.timeframe === timeframe)
    .flatMap((d) =>
      (d.reasons ?? [])
        .filter((r) => !r.met)
        .map((r) => `${d.setupType} (${d.direction}): ${r.label}`),
    );
}

export function LiveAnalysisPanel({
  view,
  symbol,
  timeframe,
  pricePrecision,
}: {
  view: LiveAnalysisView;
  symbol: string;
  timeframe: Timeframe;
  pricePrecision: number;
}) {
  const { result, cell, opportunities, windowClamped, lookbackDays } = view;
  const evaluatedAt = cell?.evaluatedAt ?? opportunities[0]?.evaluatedAt;
  const top = opportunities[0];
  const skipped = result.skipped.filter((s) => s.symbol === symbol);
  const developing = developingReasons(result, symbol, timeframe);
  const barCount = cell?.barCount;
  const quality = cell?.quality.status;

  return (
    <section
      aria-label="Chart analysis result"
      className="flex flex-col rounded-lg border border-border bg-surface"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-info" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Engine analysis</h2>
        </div>
        <span className="rounded border border-info/30 bg-info-muted px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-info uppercase">
          Live
        </span>
      </header>

      {/* Provenance + honest disclosures — evaluation time is the engine's own anchor,
          never the chart edge or "now". */}
      <p className="border-b border-border px-4 py-2 text-[11px] leading-relaxed text-subtle-foreground">
        {symbol} · {timeframeLabel(timeframe)} · evaluated at the last closed bar{" "}
        {evaluatedAt !== undefined ? (
          <time dateTime={new Date(evaluatedAt).toISOString()} className="numeric">
            {formatDateTimeUTC(new Date(evaluatedAt).toISOString())}
          </time>
        ) : (
          "(unresolved anchor)"
        )}
        {barCount !== undefined ? ` · ${barCount} bars analyzed` : ""}
        {quality !== undefined ? ` · data ${quality.replaceAll("_", " ")}` : ""}
        {` · method ${result.versions.methodVersion}`}
      </p>
      <p className="border-b border-border px-4 py-2 text-[11px] leading-relaxed text-subtle-foreground">
        The anchor is the last bar CLOSED at-or-before the chart edge — a still-forming
        bar never enters the evaluation.
        {windowClamped
          ? ` The displayed window exceeds the analysis bound: the engine evaluated the most recent ${lookbackDays}d${barCount !== undefined ? ` (${barCount} bars)` : ""}, not the full chart range.`
          : ""}
      </p>

      {skipped.length > 0 ? (
        <div className="p-4">
          <Notice tone="warning" title={`${symbol} could not be analyzed`}>
            {skipped.map((s) => s.reason).join(" · ")}
          </Notice>
        </div>
      ) : null}

      {top ? (
        <div className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">
              {describeSetup(top.direction, top.setupType, top.status)}
            </p>
            <div className="flex items-center gap-2">
              <SetupStatusBadge status={top.status} />
              <span className="numeric flex items-center gap-1 text-xs text-subtle-foreground">
                <TrendingUp className="size-3.5" aria-hidden="true" />
                score {top.score}
              </span>
            </div>
          </div>
          <TradePlan layout="stack" plan={toPlanOpportunity(top, pricePrecision)} />
          <p className="text-[11px] text-subtle-foreground">
            Levels drawn on the chart are engine outputs at the evaluation time — evidence
            of confluence, not a recommendation to trade.
          </p>
        </div>
      ) : skipped.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon={Watch}
            title="No qualifying setup"
            description={
              evaluatedAt !== undefined
                ? `The engine found no ranked setup for ${symbol} at ${formatDateTimeUTC(new Date(evaluatedAt).toISOString())}.`
                : `The engine found no ranked setup for ${symbol}.`
            }
          />
        </div>
      ) : null}

      {developing.length > 0 ? (
        <div className="border-t border-border px-4 py-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-warning uppercase">
            <Watch className="size-3.5" aria-hidden="true" />
            Watch state — conditions not yet met
          </p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {developing.slice(0, 6).map((reason) => (
              <li key={reason}>· {reason}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
