import {
  ArrowDown,
  ArrowRight,
  Ban,
  ChartNoAxesCombined,
  Check,
  Database,
  FlaskConical,
  Gauge,
  Repeat,
  Ruler,
  Sigma,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { AiExplanationExample } from "@/components/shared/ai-explanation-example";
import { ScoreMeter } from "@/components/shared/score-meter";
import { EVIDENCE_CATEGORIES } from "@/lib/constants";
import { cn } from "@/lib/utils";

function IllustrativeLabel() {
  return (
    <span className="text-[11px] font-medium text-subtle-foreground">
      Illustrative — not live data
    </span>
  );
}

interface LandingSectionProps {
  id: string;
  eyebrow: string;
  title: string;
  description: ReactNode;
  children: ReactNode;
  className?: string;
}

export function LandingSection({
  id,
  eyebrow,
  title,
  description,
  children,
  className,
}: LandingSectionProps) {
  return (
    <section id={id} className={cn("scroll-mt-14 border-b border-border", className)}>
      <div className="mx-auto max-w-6xl space-y-10 px-4 py-20 sm:px-6">
        <div className="max-w-2xl space-y-3">
          <p className="text-xs font-medium tracking-[0.16em] text-info uppercase">{eyebrow}</p>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
          <p className="leading-relaxed text-muted-foreground">{description}</p>
        </div>
        {children}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Market Intelligence                                                         */
/* -------------------------------------------------------------------------- */

export function MarketIntelligenceSection() {
  return (
    <LandingSection
      id="intelligence"
      eyebrow="Market Intelligence"
      title="Many independent signals. Not one indicator."
      description="Single indicators lag, conflict, and fail silently. The platform assesses several independent kinds of market evidence and only surfaces a setup when they agree — and tells you when they don't."
    >
      <div className="grid items-center gap-6 lg:grid-cols-[1fr_auto_280px]">
        <ul className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
          {EVIDENCE_CATEGORIES.map((category) => {
            const Icon = category.icon;
            return (
              <li key={category.id} className="flex items-start gap-3 bg-surface p-4">
                <Icon className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{category.label}</p>
                  <p className="text-xs text-muted-foreground">{category.description}</p>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex justify-center text-subtle-foreground" aria-hidden="true">
          <ArrowRight className="hidden size-5 lg:block" />
          <ArrowDown className="size-5 lg:hidden" />
        </div>
        <div className="space-y-3 rounded-lg border border-info/30 bg-info-muted p-5">
          <Sigma className="size-5 text-info" aria-hidden="true" />
          <p className="font-medium">Confluence</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Agreement across independent evidence becomes a candidate setup. Conflicting evidence
            lowers its quality instead of being ignored.
          </p>
        </div>
      </div>
    </LandingSection>
  );
}

/* -------------------------------------------------------------------------- */
/* Setup intelligence                                                          */
/* -------------------------------------------------------------------------- */

const SETUPS: {
  id: string;
  title: string;
  icon: LucideIcon;
  summary: string;
  components: string[];
}[] = [
  {
    id: "reversal",
    title: "Reversal Intelligence",
    icon: Repeat,
    summary: "Identifies exhaustion and a structural shift at a meaningful location.",
    components: [
      "Demand / supply zone",
      "Liquidity sweep",
      "Displacement",
      "Structure shift (CHOCH)",
    ],
  },
  {
    id: "breakout",
    title: "Breakout Intelligence",
    icon: ChartNoAxesCombined,
    summary: "Separates genuine breakouts from false moves through a key level.",
    components: ["Compression", "Key level", "Displacement", "Confirmation"],
  },
  {
    id: "continuation",
    title: "Continuation Intelligence",
    icon: ArrowRight,
    summary: "Finds pullbacks that respect an established trend.",
    components: ["Established trend", "Pullback", "Zone reaction", "Momentum recovery"],
  },
];

export function SetupIntelligenceSection() {
  return (
    <LandingSection
      id="setups"
      eyebrow="Setup Intelligence"
      title="Reversals, breakouts, and continuations — each with its own evidence."
      description="Every setup type is defined by a specific combination of conditions. A setup is only as strong as the evidence behind each one."
    >
      <div className="grid gap-4 lg:grid-cols-3">
        {SETUPS.map((setup) => {
          const Icon = setup.icon;
          return (
            <article
              key={setup.id}
              className="flex flex-col rounded-lg border border-border bg-surface"
            >
              <div className="space-y-3 p-5">
                <Icon className="size-5 text-info" aria-hidden="true" />
                <h3 className="font-semibold">{setup.title}</h3>
                <p className="text-sm text-muted-foreground">{setup.summary}</p>
              </div>
              <ol className="mt-auto space-y-2.5 border-t border-border p-5">
                {setup.components.map((component, index) => (
                  <li key={component} className="flex items-center gap-3 text-sm">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface-elevated numeric text-[11px] text-muted-foreground">
                      {index + 1}
                    </span>
                    {component}
                  </li>
                ))}
              </ol>
            </article>
          );
        })}
      </div>
    </LandingSection>
  );
}

/* -------------------------------------------------------------------------- */
/* Multi-timeframe                                                             */
/* -------------------------------------------------------------------------- */

const TIMEFRAME_TIERS = [
  {
    tier: "Higher timeframe",
    frames: "1W · 1D · 4H",
    role: "Context",
    points: ["Directional bias", "Key demand / supply zones", "Major liquidity pools"],
  },
  {
    tier: "Setup timeframe",
    frames: "4H · 1H",
    role: "Setup",
    points: ["Price interacting with HTF zone", "Structure forming", "Liquidity being approached"],
  },
  {
    tier: "Lower timeframe",
    frames: "15m · 5m",
    role: "Confirmation",
    points: ["Change of character", "Displacement", "Entry confirmation"],
  },
];

export function MultiTimeframeSection() {
  return (
    <LandingSection
      id="multi-timeframe"
      eyebrow="Multi-Timeframe Intelligence"
      title="Higher-timeframe context. Lower-timeframe confirmation."
      description="A lower-timeframe signal without higher-timeframe context is noise. Each tier answers a different question, and a setup is strongest when all three align."
    >
      <ol className="grid gap-4 lg:grid-cols-3">
        {TIMEFRAME_TIERS.map((tier, index) => (
          <li key={tier.tier} className="relative rounded-lg border border-border bg-surface p-5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium tracking-wide text-subtle-foreground uppercase">
                {tier.tier}
              </span>
              <span className="numeric text-xs text-muted-foreground">{tier.frames}</span>
            </div>
            <p className="mt-3 text-lg font-semibold">{tier.role}</p>
            <ul className="mt-3 space-y-1.5">
              {tier.points.map((point) => (
                <li key={point} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Check className="size-3.5 shrink-0 text-info" aria-hidden="true" />
                  {point}
                </li>
              ))}
            </ul>
            {index < TIMEFRAME_TIERS.length - 1 ? (
              <ArrowRight
                className="absolute top-1/2 -right-3.5 hidden size-5 -translate-y-1/2 rounded-full bg-background text-subtle-foreground lg:block"
                aria-hidden="true"
              />
            ) : null}
          </li>
        ))}
      </ol>
    </LandingSection>
  );
}

/* -------------------------------------------------------------------------- */
/* Opportunity scoring                                                         */
/* -------------------------------------------------------------------------- */

const SCORE_COMPONENTS = [
  { label: "Market structure", value: 20, max: 25 },
  { label: "Zone quality", value: 15, max: 20 },
  { label: "Liquidity context", value: 11, max: 15 },
  { label: "Multi-timeframe alignment", value: 9, max: 15 },
  { label: "Momentum / displacement", value: 7, max: 10 },
  { label: "Historical validation", value: 9, max: 15 },
];

export function OpportunityScoringSection() {
  const total = SCORE_COMPONENTS.reduce((sum, item) => sum + item.value, 0);
  return (
    <LandingSection
      id="scoring"
      eyebrow="Opportunity Scoring"
      title="A 0–100 quality score, built from its parts."
      description="Each setup can receive a quality score composed from multiple conditions. Every component is visible, so you can see exactly where a setup is strong and where it is weak."
    >
      <div className="grid gap-8 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-4 rounded-lg border border-border bg-surface p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Gauge className="size-4 text-info" aria-hidden="true" />
              <span className="text-sm font-medium">Score breakdown</span>
            </div>
            <IllustrativeLabel />
          </div>
          <div className="space-y-3.5">
            {SCORE_COMPONENTS.map((item) => (
              <ScoreMeter key={item.label} label={item.label} value={item.value} max={item.max} />
            ))}
          </div>
          <div className="flex items-baseline justify-between border-t border-border pt-4">
            <span className="text-sm text-muted-foreground">Quality score</span>
            <span className="numeric text-2xl font-semibold">
              {total}
              <span className="text-base text-subtle-foreground">/100</span>
            </span>
          </div>
        </div>
        <div className="space-y-5">
          {[
            {
              title: "Quality, not probability",
              text: "A high score means the evidence is strong and consistent. It does not mean a trade will be profitable.",
            },
            {
              title: "Weaknesses stay visible",
              text: "Low components are shown, not averaged away — a strong structure cannot hide weak historical validation.",
            },
            {
              title: "Thresholds, not hype",
              text: "Setups below a quality threshold remain developing or are discarded rather than promoted.",
            },
          ].map((item) => (
            <div key={item.title} className="space-y-1.5">
              <h3 className="font-medium">{item.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{item.text}</p>
            </div>
          ))}
        </div>
      </div>
    </LandingSection>
  );
}

/* -------------------------------------------------------------------------- */
/* Historical validation                                                       */
/* -------------------------------------------------------------------------- */

const VALIDATION_METRICS: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Database,
    title: "Sample size",
    text: "How many comparable setups exist. Small samples are flagged, not hidden.",
  },
  {
    icon: Gauge,
    title: "Observed hit rate",
    text: "How often comparable setups reached their first objective before invalidation.",
  },
  {
    icon: Ruler,
    title: "Reward-to-risk distribution",
    text: "The spread of outcomes in R multiples, not just the average.",
  },
  {
    icon: FlaskConical,
    title: "Out-of-sample testing",
    text: "Rules are checked on data they were not designed on, to reduce overfitting.",
  },
];

export function HistoricalValidationSection() {
  return (
    <LandingSection
      id="validation"
      eyebrow="Historical Validation"
      title="Every setup type is tested against history."
      description="Setups will be evaluated with historical data and backtesting. Validation exists to expose weak setups — past results never guarantee future outcomes."
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {VALIDATION_METRICS.map(({ icon: Icon, title, text }) => (
          <div key={title} className="space-y-3 rounded-lg border border-border bg-surface p-5">
            <Icon className="size-5 text-info" aria-hidden="true" />
            <h3 className="font-medium">{title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{text}</p>
          </div>
        ))}
      </div>
    </LandingSection>
  );
}

/* -------------------------------------------------------------------------- */
/* AI explanation                                                              */
/* -------------------------------------------------------------------------- */

export function AiExplanationSection() {
  return (
    <LandingSection
      id="ai"
      eyebrow="AI Explanation"
      title="Reasoning, not BUY / SELL."
      description="The AI explains why a setup qualifies, what is still missing, and what would invalidate it — so you understand the idea instead of following a signal."
    >
      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <div className="flex flex-col justify-center gap-3 rounded-lg border border-dashed border-border bg-surface/50 p-5">
          <div className="flex items-center gap-2 text-subtle-foreground">
            <Ban className="size-4" aria-hidden="true" />
            <span className="text-xs font-medium tracking-wide uppercase">Not this</span>
          </div>
          <p className="numeric text-2xl font-semibold text-subtle-foreground line-through decoration-1">
            BUY BTCUSDT
          </p>
          <p className="text-sm text-muted-foreground">
            A bare signal gives no context, no invalidation, and no way to judge quality.
          </p>
        </div>
        <div className="space-y-4 rounded-lg border border-border bg-surface p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">AI explanation</span>
            <IllustrativeLabel />
          </div>
          <AiExplanationExample />
        </div>
      </div>
    </LandingSection>
  );
}
