import type { Metadata } from "next";
import { PublicPage, PublicSection } from "@/components/marketing/public-page";
import { SITE } from "@/lib/constants";

export const metadata: Metadata = {
  title: "About",
  description: "What AI Trading Intelligence is building and the principles behind it.",
};

export default function AboutPage() {
  return (
    <PublicPage
      eyebrow="About"
      title="Market analysis built for transparency"
      description={`${SITE.name} is a market analysis and trading intelligence platform. It is software — not a broker, exchange, or financial adviser.`}
    >
      <PublicSection title="What we are building">
        <p>
          Markets produce far more information than a single trader can process consistently.
          {SITE.name} organises that information into structured, explainable market intelligence:
          market structure, liquidity events, supply and demand zones, momentum, and multi-timeframe
          context — each opportunity carrying its supporting evidence and its invalidation
          conditions.
        </p>
        <p>
          The platform is in early development. The interface is live; the intelligence engine,
          market data feeds, and backtesting infrastructure arrive in later phases.
        </p>
      </PublicSection>
      <PublicSection title="Principles">
        <p>
          <strong className="font-medium text-foreground">Transparent reasoning.</strong> Every
          setup must explain why it qualifies and what would invalidate it. A score describes the
          quality of the evidence, never the probability of profit.
        </p>
        <p>
          <strong className="font-medium text-foreground">No guaranteed outcomes.</strong> Markets
          are uncertain and losses are always possible. We do not market predictions.
        </p>
        <p>
          <strong className="font-medium text-foreground">Evidence over opinion.</strong> Historical
          validation exists to expose weak setups and false confidence, not to promise returns.
        </p>
      </PublicSection>
      <PublicSection title="What we are not">
        <p>
          The platform does not execute trades, manage accounts, hold client funds, or provide
          personalised investment advice. Users are responsible for their own trading decisions. See
          the risk disclosure for details.
        </p>
      </PublicSection>
    </PublicPage>
  );
}
