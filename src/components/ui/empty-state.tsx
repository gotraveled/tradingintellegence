import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      <div className="flex size-10 items-center justify-center rounded-md border border-border bg-surface-elevated text-muted-foreground">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
