import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  Info,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import type { ConnectionStatus, ModuleAvailability, Tone } from "@/lib/types";
import { Badge } from "./badge";

const TONE_META: Record<Tone, { icon: LucideIcon; label: string }> = {
  bullish: { icon: TrendingUp, label: "Bullish" },
  bearish: { icon: TrendingDown, label: "Bearish" },
  developing: { icon: TriangleAlert, label: "Developing" },
  neutral: { icon: Info, label: "Neutral" },
  inactive: { icon: CircleMinus, label: "Unavailable" },
};

interface StatusBadgeProps {
  tone: Tone;
  label?: string;
  icon?: LucideIcon;
  className?: string;
}

/** Status is always conveyed by icon + text, never by color alone. */
export function StatusBadge({ tone, label, icon, className }: StatusBadgeProps) {
  const meta = TONE_META[tone];
  const Icon = icon ?? meta.icon;
  return (
    <Badge tone={tone} className={className}>
      <Icon aria-hidden="true" />
      <span>{label ?? meta.label}</span>
    </Badge>
  );
}

const CONNECTION_META: Record<ConnectionStatus, { tone: Tone; label: string; icon: LucideIcon }> = {
  connected: { tone: "bullish", label: "Connected", icon: CircleCheck },
  degraded: { tone: "developing", label: "Degraded", icon: TriangleAlert },
  disconnected: { tone: "inactive", label: "Not connected", icon: Unplug },
  not_configured: { tone: "inactive", label: "Not configured", icon: CircleDashed },
};

export function ConnectionBadge({
  status,
  className,
}: {
  status: ConnectionStatus;
  className?: string;
}) {
  const meta = CONNECTION_META[status];
  return <StatusBadge tone={meta.tone} label={meta.label} icon={meta.icon} className={className} />;
}

const AVAILABILITY_META: Record<
  ModuleAvailability,
  { tone: Tone; label: string; icon: LucideIcon }
> = {
  available: { tone: "bullish", label: "Available", icon: CircleCheck },
  preview: { tone: "neutral", label: "Preview", icon: Info },
  planned: { tone: "inactive", label: "Planned", icon: CircleDashed },
};

export function AvailabilityBadge({
  availability,
  className,
}: {
  availability: ModuleAvailability;
  className?: string;
}) {
  const meta = AVAILABILITY_META[availability];
  return <StatusBadge tone={meta.tone} label={meta.label} icon={meta.icon} className={className} />;
}
