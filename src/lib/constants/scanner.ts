import type { SetupType } from "@/lib/types";

export type ScannerViewId = "reversals" | "breakouts" | "continuations" | "developing";

export interface ScannerView {
  id: ScannerViewId;
  label: string;
  description: string;
  setupType?: SetupType;
  developingOnly?: boolean;
}

export const SCANNER_VIEWS: ScannerView[] = [
  {
    id: "reversals",
    label: "Reversals",
    description:
      "Demand/supply reaction, liquidity sweep, displacement, and a structural shift against the prior move.",
    setupType: "reversal",
  },
  {
    id: "breakouts",
    label: "Breakouts",
    description:
      "Compression into a key level, followed by displacement and confirmation beyond it.",
    setupType: "breakout",
  },
  {
    id: "continuations",
    label: "Continuations",
    description:
      "Established trend, pullback into a zone, and recovery of momentum in trend direction.",
    setupType: "continuation",
  },
  {
    id: "developing",
    label: "Developing Setups",
    description: "Setups with partial evidence that have not yet met confirmation criteria.",
    developingOnly: true,
  },
];

export function getScannerView(id: string) {
  return SCANNER_VIEWS.find((view) => view.id === id);
}
