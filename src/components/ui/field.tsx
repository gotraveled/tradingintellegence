import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const controlClasses =
  "h-9 w-full rounded-md border border-border bg-surface-elevated px-3 text-sm text-foreground placeholder:text-subtle-foreground transition-colors hover:border-border-strong focus-visible:border-primary focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(controlClasses, className)} {...props} />;
}

export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <div className="relative">
      <select className={cn(controlClasses, "appearance-none pr-8", className)} {...props}>
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-subtle-foreground"
        aria-hidden="true"
      />
    </div>
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    <label className={cn("text-xs font-medium text-muted-foreground", className)} {...props} />
  );
}
