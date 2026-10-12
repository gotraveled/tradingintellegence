import Link from "next/link";
import type { NavChild } from "@/lib/types";
import { cn } from "@/lib/utils";

interface SubNavProps {
  label: string;
  items: NavChild[];
  current: string;
  className?: string;
}

/** Horizontal in-page navigation for module sub-views. */
export function SubNav({ label, items, current, className }: SubNavProps) {
  return (
    <nav aria-label={label} className={cn("-mx-1 overflow-x-auto", className)}>
      <ul className="flex min-w-max items-center gap-1 border-b border-border px-1">
        {items.map((item) => {
          const active = item.href === current;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px flex h-9 items-center border-b-2 px-3 text-[13px] transition-colors",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {item.title}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
