import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        bullish: "border-bullish/25 bg-bullish-muted text-bullish",
        bearish: "border-bearish/25 bg-bearish-muted text-bearish",
        developing: "border-warning/25 bg-warning-muted text-warning",
        neutral: "border-info/25 bg-info-muted text-info",
        inactive: "border-border bg-inactive-muted text-inactive",
        outline: "border-border text-muted-foreground",
      },
    },
    defaultVariants: {
      tone: "outline",
    },
  },
);

export type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
