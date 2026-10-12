import type { OpportunityStatus, SetupType } from "@/lib/types";

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
