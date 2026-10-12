import type { ReactNode } from "react";
import { AvailabilityBadge } from "@/components/ui/status";
import type { NavItem } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  module: NavItem;
  title?: string;
  description?: ReactNode;
  eyebrow?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({
  module,
  title,
  description,
  eyebrow,
  meta,
  actions,
  className,
}: PageHeaderProps) {
  const Icon = module.icon;
  return (
    <div
      className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}
    >
      <div className="space-y-2">
        {eyebrow ? (
          <p className="text-[11px] font-medium tracking-wide text-subtle-foreground uppercase">
            {eyebrow}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2.5">
          <Icon className="size-5 text-primary" aria-hidden="true" />
          <h1 className="text-xl font-semibold tracking-tight">{title ?? module.title}</h1>
          <AvailabilityBadge availability={module.availability} />
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {description ?? module.description}
        </p>
        {meta ? <div className="text-xs text-subtle-foreground">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageContainer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("mx-auto w-full max-w-[1440px] space-y-6 px-4 py-6 sm:px-6 lg:py-8", className)}
    >
      {children}
    </div>
  );
}
