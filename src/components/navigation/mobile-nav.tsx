"use client";

import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { RISK_DISCLAIMER_SHORT, ROUTES } from "@/lib/constants";
import { ActiveNavList } from "./active-nav-list";
import { Brand } from "./brand";

export function MobileNav() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open navigation"
        aria-expanded={open}
        aria-controls="mobile-navigation"
        onClick={() => setOpen(true)}
      >
        <Menu />
      </Button>
      {open ? (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Navigation">
          <div
            className="absolute inset-0 bg-background/70 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            id="mobile-navigation"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border bg-background"
          >
            <div className="flex h-14 items-center justify-between border-b border-border px-4">
              <Brand href={ROUTES.dashboard} />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close navigation"
                onClick={() => setOpen(false)}
              >
                <X />
              </Button>
            </div>
            <div className="flex flex-1 flex-col overflow-y-auto px-3 py-5">
              <ActiveNavList onNavigate={() => setOpen(false)} />
            </div>
            <p className="border-t border-border px-4 py-3 text-[11px] text-subtle-foreground">
              {RISK_DISCLAIMER_SHORT}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
