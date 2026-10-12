import { FlaskConical } from "lucide-react";
import { DemoBadge } from "@/components/shared/demo";
import { MetricTile } from "@/components/shared/metric-tile";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import type { DataSource } from "@/lib/services/types";
import type { BacktestResult } from "@/lib/types";
import { formatDateUTC } from "@/lib/utils";
import { EquityCurve } from "./equity-curve";
import { TradeDistribution } from "./trade-distribution";

export type BacktestState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "error"; message: string }
  | { status: "success"; result: BacktestResult; source: DataSource };

interface BacktestResultsProps {
  state: BacktestState;
  onRetry: () => void;
  onPreviewDemo: () => void;
}

const SMALL_SAMPLE = 30;

function signedR(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}R`;
}

export function BacktestResults({ state, onRetry, onPreviewDemo }: BacktestResultsProps) {
  const result = state.status === "success" ? state.result : undefined;
  const loading = state.status === "running";
  const isDemo = state.status === "success" && state.source === "demo";

  return (
    <section aria-labelledby="backtest-results-heading" aria-busy={loading} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 id="backtest-results-heading" className="text-sm font-semibold">
            Results
          </h2>
          {isDemo ? <DemoBadge /> : null}
        </div>
        {result ? (
          <p className="text-[11px] text-subtle-foreground">
            {formatDateUTC(result.period.from)} – {formatDateUTC(result.period.to)}
          </p>
        ) : null}
      </div>

      {state.status === "idle" ? (
        <Notice title="No backtest has been run">
          Configure a strategy and select Run Backtest. You can also preview the results layout with
          illustrative data.
        </Notice>
      ) : null}

      {state.status === "error" ? (
        <Notice
          tone="error"
          title="Backtest could not be run"
          action={
            <>
              <Button size="sm" variant="secondary" onClick={onRetry}>
                Try again
              </Button>
              <Button size="sm" variant="ghost" onClick={onPreviewDemo}>
                Preview demo result
              </Button>
            </>
          }
        >
          {state.message}
        </Notice>
      ) : null}

      {isDemo ? (
        <Notice tone="warning" title="Illustrative result — not a real backtest">
          These figures are generated demo data used to preview the layout. They are not derived
          from market history and say nothing about how any strategy would perform.
        </Notice>
      ) : null}

      {result && result.sampleSize < SMALL_SAMPLE ? (
        <Notice tone="warning" title="Small sample">
          Fewer than {SMALL_SAMPLE} trades. Metrics are statistically unreliable.
        </Notice>
      ) : null}

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 2xl:grid-cols-6">
        <MetricTile
          label="Win rate"
          loading={loading}
          value={result ? `${(result.hitRate * 100).toFixed(1)}%` : undefined}
        />
        <MetricTile
          label="Profit factor"
          loading={loading}
          value={result?.profitFactor?.toFixed(2)}
        />
        <MetricTile
          label="Expectancy"
          hint="Per trade"
          loading={loading}
          value={result ? signedR(result.expectancyR) : undefined}
        />
        <MetricTile
          label="Average R"
          loading={loading}
          value={result ? signedR(result.averageR) : undefined}
        />
        <MetricTile
          label="Maximum drawdown"
          loading={loading}
          value={
            result?.maxDrawdownR !== undefined ? `−${result.maxDrawdownR.toFixed(1)}R` : undefined
          }
        />
        <MetricTile label="Number of trades" loading={loading} value={result?.sampleSize} />
      </dl>

      <div className="grid gap-4 lg:grid-cols-2">
        <figure className="rounded-lg border border-border bg-surface">
          <figcaption className="border-b border-border px-4 py-3 text-sm font-semibold">
            Equity curve
          </figcaption>
          <div className="p-4">
            {loading ? (
              <div className="h-48 animate-pulse rounded-md bg-surface-elevated" />
            ) : (
              <EquityCurve trades={result?.trades} />
            )}
          </div>
        </figure>
        <figure className="rounded-lg border border-border bg-surface">
          <figcaption className="border-b border-border px-4 py-3 text-sm font-semibold">
            Trade distribution
          </figcaption>
          <div className="p-4">
            {loading ? (
              <div className="h-48 animate-pulse rounded-md bg-surface-elevated" />
            ) : (
              <TradeDistribution trades={result?.trades} />
            )}
          </div>
        </figure>
      </div>

      {result?.assumptions ? (
        <p className="flex items-center gap-1.5 text-[11px] text-subtle-foreground">
          <FlaskConical className="size-3.5" aria-hidden="true" />
          Assumptions: {result.assumptions.commissionBps ?? 0} bps commission,{" "}
          {result.assumptions.slippageBps ?? 0} bps slippage. Past results never guarantee future
          outcomes.
        </p>
      ) : null}
    </section>
  );
}
