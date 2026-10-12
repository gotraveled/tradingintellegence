import {
  Activity,
  Droplets,
  GitBranch,
  History,
  Layers,
  ScanLine,
  SquareStack,
  type LucideIcon,
} from "lucide-react";
import type { EvidenceCategory, SetupType } from "@/lib/types";

export interface EvidenceCategoryDefinition {
  id: EvidenceCategory;
  label: string;
  description: string;
  icon: LucideIcon;
  examples: string[];
}

export const EVIDENCE_CATEGORIES: EvidenceCategoryDefinition[] = [
  {
    id: "market_structure",
    label: "Market Structure",
    description: "Swing highs and lows, trend state, and structural shifts.",
    icon: GitBranch,
    examples: ["Break of structure (BOS)", "Change of character (CHOCH)", "Trend state"],
  },
  {
    id: "supply_demand",
    label: "Supply & Demand Zones",
    description: "Areas where price previously left with strong displacement.",
    icon: SquareStack,
    examples: ["Fresh vs. tested zones", "Zone strength", "Origin of move"],
  },
  {
    id: "liquidity",
    label: "Liquidity",
    description: "Resting liquidity pools and how price interacts with them.",
    icon: Droplets,
    examples: ["Equal highs / lows", "Liquidity sweeps", "Session extremes"],
  },
  {
    id: "imbalance",
    label: "Imbalance",
    description: "Inefficient price delivery that markets often revisit.",
    icon: ScanLine,
    examples: ["Fair value gaps", "Volume imbalances", "Mitigation"],
  },
  {
    id: "multi_timeframe",
    label: "Multi-Timeframe Alignment",
    description: "Agreement between higher-timeframe context and execution timeframe.",
    icon: Layers,
    examples: ["HTF bias", "LTF confirmation", "Conflict detection"],
  },
  {
    id: "momentum",
    label: "Momentum & Volatility",
    description: "Strength of displacement and the volatility regime.",
    icon: Activity,
    examples: ["Displacement quality", "Volatility regime", "Range expansion"],
  },
  {
    id: "historical_validation",
    label: "Historical Validation",
    description: "How comparable setups behaved on the same instrument in the past.",
    icon: History,
    examples: ["Sample size", "Observed hit rate", "Reward-to-risk distribution"],
  },
];

export const SETUP_TYPES: { value: SetupType; label: string; description: string }[] = [
  {
    value: "reversal",
    label: "Reversal",
    description: "Evidence that a prevailing move is exhausting and structure is shifting.",
  },
  {
    value: "breakout",
    label: "Breakout",
    description: "Price leaving a defined range or level with confirming displacement.",
  },
  {
    value: "continuation",
    label: "Trend Continuation",
    description: "Pullbacks within an established trend that respect structure.",
  },
];
