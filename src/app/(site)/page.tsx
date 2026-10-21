import {
  Archive,
  ArrowRight,
  ChartCandlestick,
  Check,
  FileUp,
  Fingerprint,
  History,
  RotateCcw,
  Scale,
  ScanEye,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { SetupPreview } from "@/components/marketing/setup-preview";
import { buttonVariants } from "@/components/ui/button";
import { AvailabilityBadge } from "@/components/ui/status";
import { marketSegmentHref, RISK_DISCLAIMER_SHORT, ROUTES } from "@/lib/constants";
import type { ModuleAvailability } from "@/lib/types";

// ---------------------------------------------------------------------------
// Content — every claim verified against the implementation.
// ---------------------------------------------------------------------------

const CAPABILITIES: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: FileUp,
    title: "Your data, not ours",
    text: "Upload OHLCV exports from any charting platform — no API key, no subscription required.",
  },
  {
    icon: ScanEye,
    title: "Deterministic chart analysis",
    text: "Chart Analyst reads the pixels of your screenshots — reproducible output, not generated prose.",
  },
  {
    icon: Fingerprint,
    title: "Fingerprinted experiments",
    text: "Every run is frozen, hashed, and recorded — compare two runs and see exactly what changed.",
  },
  {
    icon: RotateCcw,
    title: "Replayable research",
    text: "Export portable bundles, archive inputs locally, and replay any run to reproduce its fingerprint.",
  },
];

const JOURNEY: { title: string; text: string; href: string; cta: string }[] = [
  {
    title: "Import market data",
    text: "Validate an OHLCV CSV, preview the parsed series, and catch data problems before any analysis.",
    href: ROUTES.dataImport,
    cta: "Import data",
  },
  {
    title: "Analyze a chart",
    text: "Upload a screenshot and get a deterministic pixel-level read of structure, zones, and visible context.",
    href: ROUTES.chartAnalyst,
    cta: "Open Chart Analyst",
  },
  {
    title: "Validate an idea",
    text: "Replay engine scenarios over your candles and measure how comparable setups actually behaved.",
    href: ROUTES.validation,
    cta: "Run validation",
  },
  {
    title: "Compare strategies",
    text: "Freeze 2–6 configurations and run them side-by-side on the same data under one shared protocol.",
    href: ROUTES.comparison,
    cta: "Open the lab",
  },
  {
    title: "Record experiments",
    text: "Completed comparisons register automatically — fingerprinted, timestamped, and checked against prior test-window exposure.",
    href: ROUTES.comparison,
    cta: "Open the registry",
  },
  {
    title: "Export & replay",
    text: "Export portable rb1 bundles, archive inputs locally, and rerun a record to reproduce its exact fingerprint.",
    href: ROUTES.comparison,
    cta: "Replay a record",
  },
];

interface FeatureRow {
  title: string;
  href: string;
  status: ModuleAvailability;
  text: string;
}

const FEATURES: { heading: string; intro: string; rows: FeatureRow[] }[] = [
  {
    heading: "Working research tools",
    intro: "Fully functional today — powered entirely by data you upload.",
    rows: [
      {
        title: "Data Import",
        href: ROUTES.dataImport,
        status: "available",
        text: "Upload 1–4 OHLCV CSVs (8 MB, 60k rows each). Validation, timeframe detection, and multi-timeframe role binding run the same canonical pipeline as the scanner.",
      },
      {
        title: "Chart Analyst",
        href: ROUTES.chartAnalyst,
        status: "available",
        text: "Deterministic pixel analysis of chart screenshots — structure, zones, ticks. An optional local vision model adds narrative; nothing is sent anywhere without it.",
      },
      {
        title: "Historical Validation",
        href: ROUTES.validation,
        status: "available",
        text: "Causal, chronological scenario replay over uploaded candles — hit rates, reward-to-risk, sample-size honesty.",
      },
      {
        title: "Comparison Lab",
        href: ROUTES.comparison,
        status: "available",
        text: "Frozen engine snapshots compared under identical data and protocol. Every run registers a fingerprinted experiment record.",
      },
      {
        title: "Experiment Registry & Replay",
        href: ROUTES.comparison,
        status: "available",
        text: "Local-first records with test-set exposure tracking, reproducibility manifests, rb1 bundle export/import, and the V1.2 input archive — restore original bytes and replay to the same fingerprint.",
      },
      {
        title: "Research Desk",
        href: ROUTES.research,
        status: "available",
        text: "Official-source filings and releases, attributed and linked — no editorializing.",
      },
      {
        title: "Live Trading Desk",
        href: marketSegmentHref("crypto"),
        status: "available",
        text: "Live Binance Spot and NSE/BSE index feeds — Victor 1m pin-bar scalps and Confluence 5m swings run side-by-side, paper-booked in real time. A strategy tournament replays eight methods on the same bars to rank what actually works.",
      },
    ],
  },
  {
    heading: "Implemented, provider-gated",
    intro: "The interface and workflow are built. The live-data path stays closed until display rights are established — honestly flagged, never faked.",
    rows: [
      {
        title: "Scanner",
        href: ROUTES.scanner,
        status: "preview",
        text: "Full opportunity pipeline. Serving requires authorized display rights; an explicit, always-badged sample preview is available.",
      },
      {
        title: "Markets & Chart Workspace",
        href: ROUTES.markets,
        status: "preview",
        text: "Instrument universe and overlay-rich chart workspace — provider-gated until display authorization exists.",
      },
      {
        title: "Strategy Lab",
        href: ROUTES.strategyLab,
        status: "preview",
        text: "Rule definition and backtest workflow — runs against provider candles, so results require a data entitlement.",
      },
    ],
  },
  {
    heading: "Sample-data surfaces",
    intro: "Functional layouts populated with synthetic data — always badged, never presented as live.",
    rows: [
      {
        title: "Dashboard",
        href: ROUTES.dashboard,
        status: "sample",
        text: "Regime, opportunity, and setup panels rendered on sample payloads — a faithful preview of the live product.",
      },
      {
        title: "Watchlist",
        href: ROUTES.watchlist,
        status: "sample",
        text: "Tracking layout on sample instruments. Your data feeds will populate it once display rights exist.",
      },
      {
        title: "Alerts",
        href: ROUTES.alerts,
        status: "sample",
        text: "Alert configuration and event stream on sample data — no live notifications yet.",
      },
    ],
  },
  {
    heading: "Planned",
    intro: "Not implemented — labelled, not disguised.",
    rows: [
      {
        title: "Market Intelligence",
        href: ROUTES.marketIntelligence,
        status: "planned",
        text: "Cross-asset context and AI-generated briefings — the session panel works; the rest is genuinely not built yet.",
      },
      {
        title: "AI Assistant",
        href: ROUTES.assistant,
        status: "planned",
        text: "Conversational evidence queries. The workspace exists and says so honestly — no fake AI behind it.",
      },
    ],
  },
];

const SHOWCASES: {
  title: string;
  href: string;
  cta: string;
  lead: string;
  points: string[];
  outputs: string[];
}[] = [
  {
    title: "Market Data Import",
    href: ROUTES.dataImport,
    cta: "Import a dataset",
    lead: "Every upload-driven workflow starts here. Drop an OHLCV CSV — or up to four timeframes of the same instrument — and the validator reports exactly what it found before anything runs.",
    points: [
      "Delimiter and column detection, per-row issue reporting, and gap, duplicate, and ordering checks.",
      "Timeframe hinting plus explicit multi-timeframe role binding (HTF / ITF / ETF).",
      "Provenance is recorded on every run — the file itself is never stored or sent anywhere.",
    ],
    outputs: [
      "Row & rejection counts",
      "Gap and duplicate report",
      "Preview table",
      "Timeframe hint",
      "Provenance string",
    ],
  },
  {
    title: "Chart Analyst",
    href: ROUTES.chartAnalyst,
    cta: "Analyze a screenshot",
    lead: "Point it at a chart screenshot and it reads the pixels — candle geometry, trend direction, demand/supply zones, and axis ticks — deterministically. No OCR guesses at your price levels: calibration uses anchors you supply.",
    points: [
      "Structured report: candles read, bull/bear split, trend, levels with touch counts, scenarios.",
      "Optional user-anchored price-axis calibration — otherwise levels stay labelled visual estimates.",
      "A local vision runtime (Ollama) can add a narrative; nothing leaves your deployment either way.",
    ],
    outputs: [
      "Verdict and reasoning",
      "Levels with touches",
      "Supply/demand zones",
      "Scenarios & invalidations",
      "Calibration status",
    ],
  },
  {
    title: "Historical Validation",
    href: ROUTES.validation,
    cta: "Validate an idea",
    lead: "Replay the engine's scenarios chronologically over your candles and measure what actually happened — win rates ship with sample sizes and confidence intervals, never naked percentages.",
    points: [
      "Causal evaluation with explicit horizon, entry deadline, fees, and slippage assumptions.",
      "Chronological 60/20/20 splits with optional purged-boundary evaluation.",
      "Sensitivity grids for costs and horizons; results export as JSON or CSV.",
    ],
    outputs: [
      "Realized W/L/BE with n",
      "Expectancy R with 95% CI",
      "Cohort splits & purge counts",
      "Dependence diagnostics",
      "Run fingerprint",
    ],
  },
  {
    title: "Strategy Comparison Lab",
    href: ROUTES.comparison,
    cta: "Compare strategies",
    lead: "Freeze 2–6 configuration presets and evaluate them on the same dataset under one shared protocol — differences in outcome are attributable to the configuration, nothing else.",
    points: [
      "Identical snapshots are rejected; differing opportunity counts are reported, not reconciled.",
      "Fairness and test-set exposure warnings appear before the results table.",
      "Per-instrument and per-cohort breakdowns where the data supports them.",
    ],
    outputs: [
      "Side-by-side metrics",
      "Uncertainty intervals",
      "Exposure notice",
      "Fairness warnings",
      "JSON export",
    ],
  },
  {
    title: "Experiment Registry & Replay",
    href: ROUTES.comparison,
    cta: "Open the registry",
    lead: "Completed comparisons register automatically — configuration, protocol, datasets, exposure, fingerprint. Archived inputs restore byte-identical, and exported bundles replay to the same fingerprint on demand.",
    points: [
      "Every record carries a fingerprinted identity plus prior test-window exposure.",
      "Opt-in archive stores original upload bytes in IndexedDB, digests verified on restore.",
      "rb1 bundles are portable: import, verify, replay — verification distinguishes file integrity from proof that an experiment was valid.",
    ],
    outputs: [
      "Fingerprinted records",
      "Exposure status",
      "Digest-verified archive",
      "rb1 bundle export/import",
      "Replay match report",
    ],
  },
];

const STEPS = [
  {
    n: "01",
    title: "Bring your market data",
    text: "Export OHLCV candles from your platform and import them — or screenshot a chart. No credentials needed.",
  },
  {
    n: "02",
    title: "Run the engine",
    text: "Chart analysis, historical validation, or a frozen strategy comparison — the same canonical pipeline everywhere.",
  },
  {
    n: "03",
    title: "Read the uncertainty",
    text: "Scores describe evidence quality, not probability. Sample sizes and weaknesses are always visible.",
  },
  {
    n: "04",
    title: "Keep the proof",
    text: "Records are fingerprinted, inputs archivable, bundles exportable — replay any result to the exact fingerprint.",
  },
];

const AUDIENCES = [
  {
    title: "Independent traders",
    text: "Test setups on your own exported data with the same pipeline used for scanner intelligence.",
  },
  {
    title: "Technical analysts",
    text: "Validate patterns causally and keep an auditable record of what was tested, when, and how.",
  },
  {
    title: "Systematic researchers",
    text: "Freeze configurations, compare variants fairly, and reproduce any result byte-for-byte.",
  },
  {
    title: "Serious learners",
    text: "Learn structured market research with tools that show weakness honestly instead of selling certainty.",
  },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "What data formats can I upload?",
    a: "OHLCV CSV files — time, open, high, low, close, volume. Up to 4 files, 8 MB and 60,000 rows each. The validator reports problems precisely; invalid files never produce silent output.",
  },
  {
    q: "Do I need an API key or subscription?",
    a: "No. Every upload-driven tool — Data Import, Chart Analyst, Historical Validation, the Comparison Lab, and the Experiment Registry — works with nothing but your files.",
  },
  {
    q: "Is live market data available?",
    a: "Provider-backed surfaces (Scanner, Markets, Chart Workspace, Strategy Lab) are implemented but gated: public serving requires a written display-rights agreement with the data vendor, which does not exist yet. Rather than fabricate feeds, those surfaces show their status honestly.",
  },
  {
    q: "What does Chart Analyst actually do?",
    a: "Deterministic pixel analysis of a chart screenshot — candle geometry, structure, zones, and tick context — optionally narrated by a local vision model (Ollama). It does not read a live chart or fetch prices.",
  },
  {
    q: "What is an experiment fingerprint?",
    a: "A hash over the exact configuration, protocol, and dataset identity of a run. Two runs with the same fingerprint are provably identical; replaying a bundle reproduces the fingerprint — that's the integrity guarantee.",
  },
  {
    q: "Where is my data stored?",
    a: "In your browser only — experiments in localStorage, archived inputs in IndexedDB, all opt-in. Nothing is uploaded to a server you didn't deploy. Exports are plain JSON bundles you keep.",
  },
  {
    q: "Does reproducibility mean a strategy is profitable?",
    a: "No. A replayed fingerprint proves the same inputs produce the same output — nothing more. Historical validation measures what happened on the uploaded data; it cannot prove future performance.",
  },
  {
    q: "Does the platform trade or place orders?",
    a: "No. This is a research and analysis tool. There is no broker connection, no order execution, and no signal service — and the AI Assistant is a planned feature, not a live agent.",
  },
  {
    q: "Does my research persist between sessions?",
    a: "Experiment records persist in browser localStorage; archived CSV bytes persist in IndexedDB — both opt-in and device-local. Export bundles before clearing site data.",
  },
  {
    q: "What is a replay bundle?",
    a: "An rb1 JSON file containing the experiment record plus the original input files. Import one to verify digests, check replay eligibility, and rerun the canonical comparison — a matching fingerprint proves identical inputs and configuration.",
  },
];

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="border-b border-border">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:py-24">
          <div className="space-y-8">
            <p className="text-xs font-medium tracking-[0.16em] text-info uppercase">
              AI Trading Intelligence
            </p>
            <div className="space-y-5">
              <h1 className="text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
                Research the markets. Test your edge. Understand the evidence.
              </h1>
              <p className="max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
                Import your candles, analyze a chart, validate an idea, and compare frozen
                configurations — every result fingerprinted, archivable, and replayable.
                What isn&rsquo;t ready is labelled, not disguised.
              </p>
            </div>
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Link href={ROUTES.dataImport} className={buttonVariants({ size: "lg" })}>
                  <FileUp aria-hidden="true" />
                  Analyze your own data
                </Link>
                <Link
                  href={ROUTES.dashboard}
                  className={buttonVariants({ size: "lg", variant: "secondary" })}
                >
                  Explore the platform
                  <ArrowRight aria-hidden="true" />
                </Link>
              </div>
              <p className="text-xs text-subtle-foreground">{RISK_DISCLAIMER_SHORT}</p>
            </div>
          </div>
          <div>
            <SetupPreview />
            <p className="mt-3 text-center text-xs text-subtle-foreground">
              Product preview — representative sample data, not live prices.
            </p>
          </div>
        </div>
      </section>

      {/* Capability strip */}
      <section className="border-b border-border bg-surface-elevated/40">
        <div className="mx-auto grid max-w-6xl gap-4 px-4 py-10 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
          {CAPABILITIES.map((cap) => (
            <div key={cap.title} className="flex gap-3 rounded-lg border border-border bg-surface p-4">
              <cap.icon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
              <div>
                <h3 className="text-sm font-semibold">{cap.title}</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{cap.text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Research journey */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-6xl space-y-8 px-4 py-16 sm:px-6">
          <div className="space-y-3">
            <p className="text-xs font-medium tracking-[0.16em] text-info uppercase">
              What the platform does
            </p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              A connected research journey — every step is a working tool.
            </h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {JOURNEY.map((step) => (
              <Link
                key={step.title}
                href={step.href}
                className="group rounded-lg border border-border bg-surface p-6 transition-colors hover:border-border-strong hover:bg-surface-elevated"
              >
                <h3 className="font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.text}</p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-sm text-primary">
                  {step.cta}
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Feature showcase — grouped by honest availability */}
      <section className="border-b border-border bg-surface-elevated/40">
        <div className="mx-auto max-w-6xl space-y-12 px-4 py-16 sm:px-6">
          <div className="space-y-3">
            <p className="text-xs font-medium tracking-[0.16em] text-info uppercase">
              Capability map
            </p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Every feature, labelled by what it really is.
            </h2>
          </div>
          {FEATURES.map((group) => (
            <div key={group.heading} className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-lg font-semibold">{group.heading}</h3>
                <p className="text-sm text-muted-foreground">{group.intro}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {group.rows.map((f) => (
                  <Link
                    key={f.title}
                    href={f.href}
                    className="rounded-lg border border-border bg-surface p-5 transition-colors hover:border-border-strong hover:bg-surface-elevated"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h4 className="font-semibold">{f.title}</h4>
                      <AvailabilityBadge availability={f.status} />
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.text}</p>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Deep showcases — the working tools, in detail */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-6xl space-y-14 px-4 py-16 sm:px-6">
          <div className="space-y-3">
            <p className="text-xs font-medium tracking-[0.16em] text-info uppercase">
              Working tools
            </p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Five tools, one research loop.
            </h2>
          </div>
          {SHOWCASES.map((s, i) => (
            <div
              key={s.title}
              className={`grid gap-8 lg:grid-cols-2 lg:items-center ${i % 2 === 1 ? "" : ""}`}
            >
              <div className={`space-y-4 ${i % 2 === 1 ? "lg:order-2" : ""}`}>
                <div className="flex items-center gap-3">
                  <AvailabilityBadge availability="available" />
                </div>
                <h3 className="text-xl font-semibold tracking-tight">{s.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{s.lead}</p>
                <ul className="space-y-2">
                  {s.points.map((p) => (
                    <li key={p} className="flex gap-2 text-sm text-muted-foreground">
                      <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
                <Link href={s.href} className={buttonVariants({ size: "sm" })}>
                  {s.cta}
                  <ArrowRight aria-hidden="true" />
                </Link>
              </div>
              <div className={`rounded-lg border border-border bg-surface-elevated p-5 ${i % 2 === 1 ? "lg:order-1" : ""}`}>
                <p className="text-[11px] font-medium tracking-wide text-subtle-foreground uppercase">
                  What the run returns
                </p>
                <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {s.outputs.map((o) => (
                    <li
                      key={o}
                      className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted-foreground"
                    >
                      {o}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="scroll-mt-16 border-b border-border">
        <div className="mx-auto max-w-6xl space-y-8 px-4 py-16 sm:px-6">
          <div className="space-y-3">
            <p className="text-xs font-medium tracking-[0.16em] text-info uppercase">How it works</p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Four steps from raw candles to a replayable record.
            </h2>
          </div>
          <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s) => (
              <li key={s.n} className="rounded-lg border border-border bg-surface p-5">
                <p className="numeric text-xs font-medium text-primary">{s.n}</p>
                <h3 className="mt-2 font-semibold">{s.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Research rigor */}
      <section className="border-b border-border bg-surface-elevated/40">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-16 sm:px-6 lg:grid-cols-2">
          <div className="space-y-4">
            <p className="text-xs font-medium tracking-[0.16em] text-info uppercase">
              Research rigor
            </p>
            <h2 className="text-2xl font-semibold tracking-tight">
              Built for evidence you can check — not stories you can&rsquo;t.
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Validation is chronological, dataset identity is hashed, configuration changes
              are fingerprinted, and the registry tracks test-set exposure so reuse is
              never invisible. Bundle exports carry everything needed to reproduce a run.
            </p>
            <div className="flex flex-wrap gap-3 pt-2">
              <Link href={ROUTES.comparison} className={buttonVariants({ size: "sm" })}>
                <Scale aria-hidden="true" />
                Open Comparison Lab
              </Link>
              <Link href={ROUTES.validation} className={buttonVariants({ size: "sm", variant: "secondary" })}>
                <History aria-hidden="true" />
                Run a validation
              </Link>
            </div>
          </div>
          <div className="grid content-start gap-3">
            {[
              {
                icon: Fingerprint,
                title: "Fingerprints, not vibes",
                text: "Run identity is a hash of config + protocol + dataset. Identical fingerprint, identical run.",
              },
              {
                icon: Archive,
                title: "Input integrity",
                text: "Archived inputs store the original upload bytes with byte-level digests — restore and replay prove the chain.",
              },
              {
                icon: ChartCandlestick,
                title: "Causal validation",
                text: "Scenarios evaluate bar-by-bar with no lookahead. Observed hit rates ship with their sample sizes.",
              },
            ].map((item) => (
              <div key={item.title} className="flex gap-3 rounded-lg border border-border bg-surface p-4">
                <item.icon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
                <div>
                  <h3 className="text-sm font-semibold">{item.title}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.text}</p>
                </div>
              </div>
            ))}
            <p className="px-1 text-xs leading-relaxed text-subtle-foreground">
              Reproducibility proves identity, not profitability — and a holdout dataset is only
              independent while it stays untouched. The registry exposes the reuse; it cannot
              un-see data.
            </p>
          </div>
        </div>
      </section>

      {/* Who it's for */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-6xl space-y-8 px-4 py-16 sm:px-6">
          <div className="space-y-3">
            <p className="text-xs font-medium tracking-[0.16em] text-info uppercase">Who it is for</p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Research tools for people who check the work.
            </h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {AUDIENCES.map((a) => (
              <div key={a.title} className="rounded-lg border border-border bg-surface p-5">
                <h3 className="font-semibold">{a.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{a.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Data transparency */}
      <section className="border-b border-border bg-surface-elevated/40">
        <div className="mx-auto max-w-6xl space-y-6 px-4 py-16 sm:px-6">
          <div className="space-y-3">
            <p className="text-xs font-medium tracking-[0.16em] text-warning uppercase">
              Data transparency
            </p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Where every screen&rsquo;s data actually comes from.
            </h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                ["available", "Your uploads", "Data Import, Chart Analyst, Validation, Comparison, Registry — the complete working path, no credentials."],
                ["preview", "Provider-gated", "Scanner, Markets, Chart Workspace, Strategy Lab — built, but live data waits on vendor display rights."],
                ["sample", "Synthetic sample", "Dashboard, Watchlist, Alerts — real layouts on fake data, always badged amber."],
                ["planned", "Not built yet", "Market Intelligence briefings and the AI Assistant — labelled, not disguised."],
              ] as const
            ).map(([status, title, text]) => (
              <div key={status} className="rounded-lg border border-border bg-surface p-5">
                <AvailabilityBadge availability={status} />
                <h3 className="mt-3 font-semibold">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="scroll-mt-16 border-b border-border">
        <div className="mx-auto max-w-6xl space-y-8 px-4 py-16 sm:px-6">
          <div className="space-y-3">
            <p className="text-xs font-medium tracking-[0.16em] text-info uppercase">FAQ</p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Honest answers to the questions that matter.
            </h2>
          </div>
          <dl className="grid gap-3 sm:grid-cols-2">
            {FAQ.map((item) => (
              <div key={item.q} className="rounded-lg border border-border bg-surface p-5">
                <dt className="font-semibold">{item.q}</dt>
                <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Final CTA */}
      <section>
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <div className="rounded-xl border border-border bg-surface-elevated px-6 py-12 text-center sm:px-12">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Start with your own data — proof in minutes.
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
              No account, no API key, no subscription. Import a dataset, run the engine, and
              keep a fingerprinted record of exactly what you found.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Link href={ROUTES.dataImport} className={buttonVariants({ size: "lg" })}>
                <FileUp aria-hidden="true" />
                Import market data
              </Link>
              <Link
                href={ROUTES.chartAnalyst}
                className={buttonVariants({ size: "lg", variant: "secondary" })}
              >
                <ScanEye aria-hidden="true" />
                Analyze a chart
              </Link>
            </div>
            <p className="mt-4 text-xs text-subtle-foreground">{RISK_DISCLAIMER_SHORT}</p>
          </div>
        </div>
      </section>
    </>
  );
}
