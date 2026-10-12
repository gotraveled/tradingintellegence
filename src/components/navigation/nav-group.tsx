"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { NAV_ITEMS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { navItemClasses, NavItemContent } from "./nav-item";

interface NavGroupProps {
  /** Href of a NAV_ITEMS entry. Passed instead of the item so props stay serializable. */
  href: string;
  pathname: string | null;
  sectionActive: boolean;
  onNavigate?: () => void;
}

/** Navigation item with a collapsible submenu. Opens automatically when its section is active. */
export function NavGroup({ href, pathname, sectionActive, onNavigate }: NavGroupProps) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const submenuId = useId();
  const item = NAV_ITEMS.find((entry) => entry.href === href);
  if (!item) return null;
  const open = expanded ?? sectionActive;

  return (
    <div>
      <div className="flex items-center gap-0.5">
        <Link
          href={item.href}
          onClick={onNavigate}
          className={cn(navItemClasses(sectionActive && !open), "min-w-0 flex-1")}
        >
          <NavItemContent item={item} active={sectionActive} />
        </Link>
        <button
          type="button"
          onClick={() => setExpanded(!open)}
          aria-expanded={open}
          aria-controls={submenuId}
          aria-label={`${open ? "Collapse" : "Expand"} ${item.title}`}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-subtle-foreground transition-colors hover:bg-surface-elevated hover:text-foreground"
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
            aria-hidden="true"
          />
        </button>
      </div>
      {open && item.children ? (
        <ul
          id={submenuId}
          className="mt-0.5 mb-1 ml-[18px] space-y-0.5 border-l border-border pl-2.5"
        >
          {item.children.map((child) => {
            const active = pathname === child.href;
            return (
              <li key={child.href}>
                <Link
                  href={child.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-7 items-center rounded-md px-2.5 text-[12.5px] transition-colors",
                    active
                      ? "bg-surface-hover text-foreground"
                      : "text-muted-foreground hover:bg-surface-elevated hover:text-foreground",
                  )}
                >
                  {child.title}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
