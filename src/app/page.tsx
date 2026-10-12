import { ArrowRight, Eye, History, Radar, Scale } from "lucide-react";
import Link from "next/link";
import {
  AiExplanationSection,
  HistoricalValidationSection,
  MarketIntelligenceSection,
  MultiTimeframeSection,
  OpportunityScoringSection,
  SetupIntelligenceSection,
} from "@/components/marketing/landing-sections";
import { SetupPreview } from "@/components/marketing/setup-preview";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import { buttonVariants } from "@/components/ui/button";
import { RISK_DISCLAIMER_SHORT, ROUTES } from "@/lib/constants";

const PRINCIPLES = [
  {
    icon: Eye,
    title: "Transparent reasoning",
    description: "Every opportunity explains why it qualifies and what would invalidate it.",
  },
  {
    icon: Scale,
    title: "No guaranteed outcomes",
    description:
      "Scores describe evidence quality. Markets are uncertain, and losses are always possible.",
  },
  {
    icon: History,
    title: "Evidence over opinion",
    description: "Historical validation is used to expose weak setups, not to market strong ones.",
  },
];

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">
        <section className="border-b border-border">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:py-28">
            <div className="space-y-8">
              <p className="text-xs font-medium tracking-[0.16em] text-info uppercase">
                AI Trading Intelligence
              </p>
              <div className="space-y-5">
                <h1 className="text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
                  See the market before the move.
                </h1>
                <p className="max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
                  Identify high-quality reversals, breakouts and trend continuations using market
                  structure, liquidity, price action and historical intelligence.
                </p>
              </div>
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Link href={ROUTES.dashboard} className={buttonVariants({ size: "lg" })}>
                    Explore Market Intelligence
                    <ArrowRight aria-hidden="true" />
                  </Link>
                  <Link
                    href={ROUTES.scanner}
                    className={buttonVariants({ size: "lg", variant: "secondary" })}
                  >
                    <Radar aria-hidden="true" />
                    Open Scanner
                  </Link>
                </div>
                <p className="text-xs text-subtle-foreground">{RISK_DISCLAIMER_SHORT}</p>
              </div>
            </div>
            <SetupPreview />
          </div>
        </section>

        <MarketIntelligenceSection />
        <SetupIntelligenceSection />
        <MultiTimeframeSection />
        <OpportunityScoringSection />
        <HistoricalValidationSection />
        <AiExplanationSection />

        <section id="principles" className="scroll-mt-14">
          <div className="mx-auto max-w-6xl space-y-10 px-4 py-20 sm:px-6">
            <h2 className="text-2xl font-semibold tracking-tight">Principles</h2>
            <div className="grid gap-8 md:grid-cols-3">
              {PRINCIPLES.map(({ icon: Icon, title, description }) => (
                <div key={title} className="space-y-3">
                  <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
                  <h3 className="font-medium">{title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-10">
              <Link href={ROUTES.dashboard} className={buttonVariants({ size: "lg" })}>
                Explore Market Intelligence
                <ArrowRight aria-hidden="true" />
              </Link>
              <Link
                href={ROUTES.scanner}
                className={buttonVariants({ size: "lg", variant: "secondary" })}
              >
                Open Scanner
              </Link>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
