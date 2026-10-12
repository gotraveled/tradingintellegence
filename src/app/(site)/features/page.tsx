import type { Metadata } from "next";
import { PublicPage, PublicSection } from "@/components/marketing/public-page";

export const metadata: Metadata = {
  title: "Features",
  description: "Market scanner, chart intelligence, strategy lab, alerts and watchlist.",
};

export default function FeaturesPage() {
  return (
    <PublicPage
      eyebrow="Features"
      title="One workspace for market intelligence"
      description="The platform modules under development. Each is designed to be fed by the same intelligence engine and data model."
    >
      <PublicSection title="Market scanner">
        <p>
          Scan across markets for developing and confirmed setups — reversals, breakouts, and trend
          continuations — filtered by market, asset class, timeframe, setup type, direction, status,
          and minimum quality score.
        </p>
      </PublicSection>
      <PublicSection title="Chart intelligence">
        <p>
          A chart workspace that overlays detected structure, liquidity, zones, and imbalances,
          alongside an analysis panel that explains what the evidence currently shows and a trade
          plan describing where the setup would be invalidated.
        </p>
      </PublicSection>
      <PublicSection title="Strategy lab">
        <p>
          A future backtesting environment for validating strategy rules against historical data —
          with assumptions, drawdown, expectancy, and sample-size warnings made explicit. The UI is
          live; the backtesting engine is a later phase.
        </p>
      </PublicSection>
      <PublicSection title="Alerts">
        <p>
          Rules for setup lifecycle events (developing, confirmed, invalidated), zone approaches,
          and targets reached — delivered in-app, by email, or via webhook. Delivery channels are
          planned, not yet connected.
        </p>
      </PublicSection>
      <PublicSection title="Watchlist">
        <p>
          Track instruments and their current setup status in one place. Persistence and account
          sync are planned for a later phase.
        </p>
      </PublicSection>
      <PublicSection title="AI explanation">
        <p>
          The Market Intelligence Assistant will answer questions about why setups qualify, how they
          were scored, and what the structure shows — citing the underlying evidence. It explains;
          it does not issue buy or sell instructions.
        </p>
      </PublicSection>
    </PublicPage>
  );
}
