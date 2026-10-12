import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SectionProps {
  title: string;
  description?: ReactNode;
  badge?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Section({ title, description, badge, action, children, className }: SectionProps) {
  const headingId = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={headingId} className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 id={headingId} className="text-sm font-semibold tracking-tight">
              {title}
            </h2>
            {badge}
          </div>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
