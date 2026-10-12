import { Radar } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { SubNav } from "@/components/navigation/sub-nav";
import { DevelopingSetupCard } from "@/components/opportunities/developing-setup-card";
import { OpportunityAnatomy } from "@/components/opportunities/opportunity-anatomy";
import { OpportunityCard } from "@/components/opportunities/opportunity-card";
import { DemoNotice, SourceBadge } from "@/components/shared/demo";
import { Section } from "@/components/shared/section";
import { EmptyState } from "@/components/ui/empty-state";
import { getNavItem, ROUTES, scannerViewHref, type ScannerView } from "@/lib/constants";
import { getDevelopingSetups, getOpportunities } from "@/lib/services/intelligence";
import { ScannerFilters } from "./scanner-filters";

function NoResults() {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <EmptyState
        icon={Radar}
        title="No setups in this view"
        description="Nothing currently meets the criteria for this view."
      />
    </div>
  );
}

/** Shared layout for "All Opportunities" and each scanner sub-view. */
export function ScannerWorkspace({ view }: { view?: ScannerView }) {
  const scanner = getNavItem(ROUTES.scanner);
  const current = view ? scannerViewHref(view.id) : ROUTES.scanner;
  const showDeveloping = !view || view.developingOnly;
  const showQualified = !view?.developingOnly;

  const opportunities = getOpportunities({ setupType: view?.setupType });
  const developing = getDevelopingSetups({ setupType: view?.setupType });

  return (
    <PageContainer>
      <PageHeader
        module={scanner}
        eyebrow={view ? "Scanner" : undefined}
        title={view ? view.label : "All Opportunities"}
        description={view ? view.description : scanner.description}
      />
      <SubNav label="Scanner views" items={scanner.children ?? []} current={current} />
      <DemoNotice />
      <ScannerFilters defaultSetup={view?.setupType} />

      {showQualified ? (
        <Section
          title="Qualified setups"
          description="Ranked by quality score. Scores describe evidence quality, not the probability of profit."
          badge={<SourceBadge source={opportunities.source} />}
        >
          {opportunities.data.length ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {opportunities.data.map((opportunity) => (
                <OpportunityCard
                  key={opportunity.id}
                  opportunity={opportunity}
                  demo={opportunities.source === "demo"}
                />
              ))}
            </div>
          ) : (
            <NoResults />
          )}
        </Section>
      ) : null}

      {showDeveloping ? (
        <Section
          title="Developing setups"
          description="Partial evidence only. These are not confirmed setups."
          badge={<SourceBadge source={developing.source} />}
        >
          {developing.data.length ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {developing.data.map((setup) => (
                <DevelopingSetupCard
                  key={setup.id}
                  setup={setup}
                  demo={developing.source === "demo"}
                />
              ))}
            </div>
          ) : (
            <NoResults />
          )}
        </Section>
      ) : null}

      {!view ? <OpportunityAnatomy /> : null}
    </PageContainer>
  );
}
