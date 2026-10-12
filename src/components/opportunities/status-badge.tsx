import { CircleDashed, CircleX, Flag, ShieldCheck, Timer, type LucideIcon } from "lucide-react";
import { StatusBadge } from "@/components/ui/status";
import { SETUP_STATUS_LABEL, SETUP_STATUS_TONE } from "@/lib/constants";
import type { SetupStatus } from "@/lib/types";

const STATUS_ICON: Record<SetupStatus, LucideIcon> = {
  developing: CircleDashed,
  confirmed: ShieldCheck,
  invalidated: CircleX,
  completed: Flag,
  expired: Timer,
};

export function SetupStatusBadge({
  status,
  className,
}: {
  status: SetupStatus;
  className?: string;
}) {
  return (
    <StatusBadge
      tone={SETUP_STATUS_TONE[status]}
      label={SETUP_STATUS_LABEL[status]}
      icon={STATUS_ICON[status]}
      className={className}
    />
  );
}
