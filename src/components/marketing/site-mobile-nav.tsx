"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { ROUTES } from "@/lib/constants";

interface SiteMobileNavProps {
  links: readonly { href: string; label: string }[];
}

/** Collapsible marketing nav for viewports below md. Client-side only for the toggle. */
export function SiteMobileNav({ links }: SiteMobileNavProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="md:hidden">
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
            {links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-surface-elevated hover:text-foreground"
                >
                  {link.label}
                </Link>
              </li>
            ))}
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
