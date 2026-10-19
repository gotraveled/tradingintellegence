import type { NavItem } from "@/lib/types";
import { cn } from "@/lib/utils";

export function navItemClasses(active: boolean) {
  return cn(
    "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors",
    active
      ? "bg-surface-hover text-foreground"
      : "text-muted-foreground hover:bg-surface-elevated hover:text-foreground",
  );
}

export function NavItemContent({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <>
      <Icon
        className={cn(
          "size-4 shrink-0",
          active ? "text-primary" : "text-subtle-foreground group-hover:text-muted-foreground",
        )}
        aria-hidden="true"
      />
      <span className={cn("truncate", active && "text-foreground")}>{item.title}</span>
      {item.availability === "planned" ? (
        <span className="ml-auto text-[10px] font-medium tracking-wide text-subtle-foreground uppercase">
          Soon
        </span>
      ) : item.availability === "sample" ? (
        <span className="ml-auto text-[10px] font-medium tracking-wide text-warning uppercase">
          Sample
        </span>
      ) : null}
    </>
  );
}
