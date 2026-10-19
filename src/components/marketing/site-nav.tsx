"use client";

/**
 * Grouped marketing navigation — accessible dropdown groups for the public
 * header. Pure disclosure buttons (aria-expanded), Escape to close, and
 * click-outside dismissal. Labels route to real pages or homepage anchors.
 */
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export interface NavGroup {
  type: "group";
  label: string;
  items: { href: string; label: string; note?: string }[];
}
export interface NavLink {
  type: "link";
  href: string;
  label: string;
}
export type NavEntry = NavLink | NavGroup;

export function SiteNav({ items }: { items: readonly NavEntry[] }) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (openGroup === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenGroup(null);
        triggerRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenGroup(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [openGroup]);

  const linkClass =
    "rounded-md px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-surface-elevated hover:text-foreground";

  return (
    <nav ref={rootRef} aria-label="Marketing" className="hidden items-center gap-1 lg:flex">
      {items.map((entry) =>
        entry.type === "link" ? (
          <Link key={entry.href} href={entry.href} className={linkClass}>
            {entry.label}
          </Link>
        ) : (
          <div key={entry.label} className="relative">
            <button
              type="button"
              aria-expanded={openGroup === entry.label}
              aria-haspopup="menu"
              onClick={(e) =>
                setOpenGroup((v) => {
                  const next = v === entry.label ? null : entry.label;
                  if (next !== null) triggerRef.current = e.currentTarget;
                  return next;
                })
              }
              className={`flex items-center gap-1 ${linkClass}`}
            >
              {entry.label}
              <ChevronDown
                className={`size-3.5 transition-transform ${openGroup === entry.label ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>
            {openGroup === entry.label ? (
              <div
                role="menu"
                aria-label={entry.label}
                className="absolute top-full left-0 z-50 mt-1 w-64 rounded-lg border border-border bg-surface-elevated p-1.5 shadow-lg shadow-black/30"
              >
                {entry.items.map((item) => (
                  <Link
                    key={item.href + item.label}
                    href={item.href}
                    role="menuitem"
                    onClick={() => setOpenGroup(null)}
                    className="block rounded-md px-2.5 py-2 transition-colors hover:bg-surface-hover"
                  >
                    <span className="block text-[13px] font-medium text-foreground">{item.label}</span>
                    {item.note ? (
                      <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                        {item.note}
                      </span>
                    ) : null}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
        ),
      )}
    </nav>
  );
}
