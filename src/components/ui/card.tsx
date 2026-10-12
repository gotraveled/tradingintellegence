import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn("rounded-lg border border-border bg-surface text-foreground", className)}
      {...props}
    />
  );
}

interface CardHeaderProps extends Omit<ComponentProps<"header">, "title"> {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function CardHeader({ title, description, action, className, ...props }: CardHeaderProps) {
  return (
    <header
      className={cn(
        "flex items-start justify-between gap-4 border-b border-border px-5 py-4",
        className,
      )}
      {...props}
    >
      <div className="min-w-0 space-y-1">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-5", className)} {...props} />;
}
