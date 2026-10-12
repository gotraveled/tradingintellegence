import type { Metadata } from "next";
import { PublicPage, PublicSection } from "@/components/marketing/public-page";

export const metadata: Metadata = {
  title: "Methodology",
  description:
    "How the platform evaluates setups: market structure, liquidity, zones, momentum, multi-timeframe confirmation, and historical validation.",
};

const PILLARS = [
  {
    title: "Market structure",
    body: "Trend state, swing highs and lows, and structural shifts such as breaks of structure (BOS) and changes of character (CHOCH). Structure provides the context in which everything else is interpreted.",
  },
  {
    title: "Liquidity",
    body: "Where resting orders are likely concentrated — above swing highs, below swing lows, at session extremes — and whether price has swept those levels before reacting.",
  },
  {
    title: "Supply and demand zones",
    body: "Areas where price previously showed strong acceptance or rejection. Zones define where a reaction is plausible and where a setup is invalidated.",
  },
  {
    title: "Momentum",
    body: "The quality of the impulse or displacement that follows an interaction with structure or a zone — a gauge of whether the reaction has conviction.",
  },
  {
    title: "Multi-timeframe confirmation",
    body: "Higher-timeframe context determines the dominant bias; lower timeframes refine the entry zone. Setups are weighted by how well timeframes agree.",
  },
  {
    title: "Historical validation",
    body: "Comparable historical setups are used to expose weaknesses in a rule set — hit rate, expectancy, and drawdown — rather than to market performance.",
  },
] as const;

export default function MethodologyPage() {
  return (
    <PublicPage
      eyebrow="Methodology"
      title="How a setup earns its score"
      description="Opportunities are identified by combining independent sources of evidence. A score reflects how much of the required evidence is present — it is not a probability of profit."
    >
      {PILLARS.map((pillar) => (
        <PublicSection key={pillar.title} title={pillar.title}>
          <p>{pillar.body}</p>
        </PublicSection>
      ))}
      <PublicSection title="From evidence to score">
        <p>
          Each setup type defines its required conditions. A developing setup has met some of them;
          a confirmed setup has met all required conditions. The quality score weighs which
          conditions are present, how well the timeframes agree, and whether the setup sits in a
          coherent market regime.
        </p>
      </PublicSection>
      <PublicSection title="What a score is not">
        <p>
          A high score is not a prediction, a signal to trade, or a measure of expected profit. It
          describes the quality and completeness of the evidence at that moment. Setups can and do
          fail; invalidation conditions are published alongside every opportunity.
        </p>
      </PublicSection>
    </PublicPage>
  );
}
