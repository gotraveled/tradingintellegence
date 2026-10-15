import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { SubNav } from "@/components/navigation/sub-nav";
import { OpportunityAnatomy } from "@/components/opportunities/opportunity-anatomy";
import {
  getNavItem,
  ROUTES,
  SCANNER_VIEWS,
  scannerViewHref,
  type ScannerView,
} from "@/lib/constants";
import { getOpportunities } from "@/lib/services/intelligence";
import { ScannerLive } from "./scanner-live";

const SCANNER_TABS = [
  { title: "All", href: ROUTES.scanner },
  ...SCANNER_VIEWS.map((view) => ({ title: view.tabLabel, href: scannerViewHref(view.id) })),
];

/** Shared layout for the "All" tab and each scanner sub-view. */
export function ScannerWorkspace({ view }: { view?: ScannerView }) {
  const scanner = getNavItem(ROUTES.scanner);
  const current = view ? scannerViewHref(view.id) : ROUTES.scanner;
  // Demo payload retained only as the explicit preview fallback inside ScannerLive —
  // it renders on user action, always badged, never as the default.
  const demo = getOpportunities().data;

  return (
    <PageContainer>
      <PageHeader
        module={scanner}
        eyebrow={view ? "Scanner" : undefined}
        title={view ? view.label : "All Opportunities"}
        description={view ? view.description : scanner.description}
      />
      <SubNav label="Scanner tabs" items={SCANNER_TABS} current={current} />
      <ScannerLive demo={demo} view={view} />
      {!view ? <OpportunityAnatomy /> : null}
    </PageContainer>
  );
}
