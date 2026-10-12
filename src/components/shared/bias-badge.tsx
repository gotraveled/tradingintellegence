import { Minus, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";
import { StatusBadge } from "@/components/ui/status";
import { BIAS_LABEL, BIAS_TONE } from "@/lib/constants";
import type { Bias } from "@/lib/types";

const BIAS_ICON: Record<Bias, LucideIcon> = {
  bullish: TrendingUp,
  bearish: TrendingDown,
  neutral: Minus,
};

export function BiasBadge({ bias, className }: { bias: Bias; className?: string }) {
  return (
    <StatusBadge
      tone={BIAS_TONE[bias]}
      label={BIAS_LABEL[bias]}
      icon={BIAS_ICON[bias]}
      className={className}
    />
  );
}
