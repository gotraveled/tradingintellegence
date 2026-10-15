import type { AnalysisRequest, OpportunityStatus, SetupType } from "@/lib/types";
import { FEATURED_INSTRUMENTS } from "./instruments";
import { DEFAULT_TIMEFRAME } from "./markets";

/**
 * The scanner's live request — the catalog universe at the shared default
 * timeframe. Symbols derive from FEATURED_INSTRUMENTS so the requested universe
 * can never drift from the instruments the UI advertises. Catalog-only by
 * contract: symbols the provider cannot serve surface in `skipped`, never
 * silently substituted or dropped.
 */
export const SCAN_REQUEST: AnalysisRequest = {
  symbols: FEATURED_INSTRUMENTS.map((asset) => asset.symbol),
  timeframe: DEFAULT_TIMEFRAME,
};

export type ScannerViewId =
  "reversals" | "breakouts" | "continuations" | "developing" | "confirmed";

export interface ScannerView {
  id: ScannerViewId;
  label: string;
  /** Short label for tabs. */
  tabLabel: string;
  description: string;
  setupType?: SetupType;
  status?: OpportunityStatus;
}

export const SCANNER_VIEWS: ScannerView[] = [
  {
    id: "reversals",
    label: "Reversals",
    tabLabel: "Reversals",
    description:
      "Demand/supply reaction, liquidity sweep, displacement, and a structural shift against the prior move.",
    setupType: "reversal",
  },
  {
    id: "breakouts",
    label: "Breakouts",
    tabLabel: "Breakouts",
    description:
      "Compression into a key level, followed by displacement and confirmation beyond it.",
    setupType: "breakout",
  },
  {
    id: "continuations",
    label: "Continuations",
    tabLabel: "Continuations",
    description:
      "Established trend, pullback into a zone, and recovery of momentum in trend direction.",
    setupType: "continuation",
  },
  {
    id: "developing",
    label: "Developing Setups",
    tabLabel: "Developing",
    description: "Setups with partial evidence that have not yet met confirmation criteria.",
    status: "developing",
  },
  {
    id: "confirmed",
    label: "Confirmed Setups",
    tabLabel: "Confirmed",
    description: "Setups whose required conditions are met and that remain valid.",
    status: "confirmed",
  },
];

export function getScannerView(id: string) {
  return SCANNER_VIEWS.find((view) => view.id === id);
}
