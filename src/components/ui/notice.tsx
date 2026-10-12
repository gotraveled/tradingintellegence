import { CircleAlert, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type NoticeTone = "info" | "warning" | "error";

const TONE: Record<NoticeTone, { icon: LucideIcon; className: string; iconClass: string }> = {
  info: { icon: Info, className: "border-info/30 bg-info-muted", iconClass: "text-info" },
  warning: {
    icon: TriangleAlert,
    className: "border-warning/30 bg-warning-muted",
    iconClass: "text-warning",
  },
  error: {
    icon: CircleAlert,
    className: "border-bearish/30 bg-bearish-muted",
    iconClass: "text-bearish",
  },
};

interface NoticeProps {
  tone?: NoticeTone;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Inline status message. Errors use role="alert" so screen readers announce them. */
export function Notice({ tone = "info", title, children, action, className }: NoticeProps) {
  const { icon: Icon, className: toneClass, iconClass } = TONE[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-start",
        toneClass,
        className,
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", iconClass)} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {children ? (
          <div className="text-xs leading-relaxed text-muted-foreground">{children}</div>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}
