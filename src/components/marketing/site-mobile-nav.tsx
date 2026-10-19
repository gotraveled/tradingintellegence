"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { ROUTES } from "@/lib/constants";
import type { NavEntry } from "./site-nav";

/** Collapsible marketing nav for viewports below lg. Client-side only for the toggle. */
export function SiteMobileNav({ items }: { items: readonly NavEntry[] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Close navigation" : "Open navigation"}
        className="flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-surface-elevated hover:text-foreground"
      >
        {open ? <X className="size-4" aria-hidden="true" /> : <Menu className="size-4" aria-hidden="true" />}
      </button>
      {open ? (
        <nav
          aria-label="Marketing"
          className="absolute inset-x-0 top-full border-b border-border bg-background/95 px-4 py-4 backdrop-blur"
        >
          <ul className="space-y-1">
            {items.map((entry) =>
              entry.type === "link" ? (
                <li key={entry.href}>
                  <Link
                    href={entry.href}
                    onClick={() => setOpen(false)}
                    className="block rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-surface-elevated hover:text-foreground"
                  >
                    {entry.label}
                  </Link>
                </li>
              ) : (
                <li key={entry.label}>
                  <p className="px-3 pt-3 pb-1 text-[11px] font-medium tracking-wide text-subtle-foreground uppercase">
                    {entry.label}
                  </p>
                  <ul className="space-y-1">
                    {entry.items.map((item) => (
                      <li key={item.href + item.label}>
                        <Link
                          href={item.href}
                          onClick={() => setOpen(false)}
                          className="block rounded-md py-2 pr-3 pl-5 text-sm text-muted-foreground transition-colors hover:bg-surface-elevated hover:text-foreground"
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </li>
              ),
            )}
            <li className="pt-2">
              <Link
                href={ROUTES.dataImport}
                onClick={() => setOpen(false)}
                className={buttonVariants({ size: "sm", className: "w-full" })}
              >
                Analyze your data
              </Link>
            </li>
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
