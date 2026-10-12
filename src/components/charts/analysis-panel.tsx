import {
  Activity,
  Droplets,
  Gauge,
  GitBranch,
  Sparkles,
  SquareStack,
  Target,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { ReasonList } from "@/components/opportunities/reason-list";
import { SetupStatusBadge } from "@/components/opportunities/status-badge";
import { BiasBadge } from "@/components/shared/bias-badge";
import { DemoBadge } from "@/components/shared/demo";
import { ScoreMeter } from "@/components/shared/score-meter";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  CONFIDENCE_LABEL,
  describeSetup,
  MOMENTUM_LABEL,
  timeframeLabel,
  TREND_LABEL,
  ZONE_FRESHNESS_LABEL,
} from "@/lib/constants";
import type { AnalysisSnapshot } from "@/lib/types";
import { formatDateTimeUTC, formatPrice } from "@/lib/utils";

function PanelSection({
  icon: Icon,
  title,
  aside,
  children,
}: {
  icon: LucideIcon;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5 border-b border-border px-4 py-4 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold">
          <Icon className="size-4 text-info" aria-hidden="true" />
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Summary({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>;
}

interface AnalysisPanelProps {
  snapshot?: AnalysisSnapshot;
  symbol: string;
  demo: boolean;
  pricePrecision: number;
}

export function AnalysisPanel({ snapshot, symbol, demo, pricePrecision }: AnalysisPanelProps) {
  const price = (value: number) => formatPrice(value, pricePrecision);

  return (
    <section
      aria-label="AI market analysis"
      className="flex flex-col rounded-lg border border-border bg-surface"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-info" aria-hidden="true" />
          <h2 className="text-sm font-semibold">AI Market Analysis</h2>
        </div>
        {demo && snapshot ? <DemoBadge /> : null}
      </header>

      {!snapshot ? (
        <EmptyState
          icon={Sparkles}
          title={`No analysis for ${symbol}`}
          description="The analysis engine is not connected. Demo analysis is available for BTCUSDT and XAUUSD."
        />
      ) : (
        <div>
          <p className="border-b border-border px-4 py-2 text-[11px] text-subtle-foreground">
            {timeframeLabel(snapshot.timeframe)} analysis · generated{" "}
            <time dateTime={snapshot.generatedAt} className="numeric">
              {formatDateTimeUTC(snapshot.generatedAt)}
            </time>
          </p>

          <PanelSection
            icon={GitBranch}
            title="Market Structure"
            aside={<BiasBadge bias={snapshot.structure.data.bias} />}
          >
            <div className="flex flex-wrap gap-1.5">
              <Badge>{TREND_LABEL[snapshot.structure.data.trend]}</Badge>
              {snapshot.structure.data.lastBreak ? (
                <Badge>
                  Last {snapshot.structure.data.lastBreak.type} ·{" "}
                  <span className="numeric">{price(snapshot.structure.data.lastBreak.price)}</span>
                </Badge>
              ) : null}
            </div>
            <Summary>{snapshot.structure.summary}</Summary>
          </PanelSection>

          <PanelSection icon={Droplets} title="Liquidity">
            <ul className="space-y-1.5">
              {snapshot.liquidity.data.map((event) => (
                <li key={event.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {event.side === "buy_side" ? "Buy-side" : "Sell-side"} ·{" "}
                    <span className="capitalize">{event.status}</span>
                  </span>
                  <span className="numeric text-foreground">{price(event.price)}</span>
                </li>
              ))}
            </ul>
            <Summary>{snapshot.liquidity.summary}</Summary>
          </PanelSection>

          <PanelSection icon={SquareStack} title="Demand / Supply">
            <ul className="space-y-2">
              {snapshot.zones.data.map((zone) => (
                <li key={zone.id} className="space-y-1 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={
                        zone.type === "demand"
                          ? "font-medium text-bullish"
                          : "font-medium text-bearish"
                      }
                    >
                      {timeframeLabel(zone.timeframe)}{" "}
                      {zone.type === "demand" ? "Demand" : "Supply"}
                    </span>
                    <span className="numeric text-foreground">
                      {price(zone.lowerPrice)} – {price(zone.upperPrice)}
                    </span>
                  </div>
                  <p className="text-subtle-foreground">
                    {ZONE_FRESHNESS_LABEL[zone.freshness]} · {zone.retestCount} retest
                    {zone.retestCount === 1 ? "" : "s"} · strength{" "}
                    <span className="numeric">{zone.strength}</span>
                  </p>
                </li>
              ))}
            </ul>
            <Summary>{snapshot.zones.summary}</Summary>
          </PanelSection>

          <PanelSection
            icon={Activity}
            title="Momentum"
            aside={<Badge>{MOMENTUM_LABEL[snapshot.momentum.data.state]}</Badge>}
          >
            <Summary>{snapshot.momentum.summary}</Summary>
          </PanelSection>

          {snapshot.setup ? (
            <PanelSection
              icon={Target}
              title="Setup"
              aside={<SetupStatusBadge status={snapshot.setup.status} />}
            >
              <p className="text-sm font-medium">
                {describeSetup(
                  snapshot.setup.direction,
                  snapshot.setup.type,
                  snapshot.setup.status,
                )}
              </p>
              <ReasonList reasons={snapshot.setup.reasons} />
            </PanelSection>
          ) : null}

          {snapshot.opportunity ? (
            <PanelSection icon={Gauge} title="Opportunity Score">
              <ScoreMeter value={snapshot.opportunity.score} />
              <p className="text-[11px] text-subtle-foreground">
                Confidence:{" "}
                {snapshot.opportunity.confidence
                  ? CONFIDENCE_LABEL[snapshot.opportunity.confidence]
                  : "Not assessed"}{" "}
                · Evidence quality, not probability of profit.
              </p>
            </PanelSection>
          ) : null}
        </div>
      )}
    </section>
  );
}
