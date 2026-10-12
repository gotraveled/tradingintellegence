import { Suspense } from "react";
import { RISK_DISCLAIMER_SHORT, ROUTES } from "@/lib/constants";
import { ActiveNavList } from "./active-nav-list";
import { Brand } from "./brand";
import { NavList } from "./nav-list";

export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-background lg:flex">
      <div className="flex h-14 items-center border-b border-border px-4">
        <Brand href={ROUTES.dashboard} />
      </div>
      <div className="flex flex-1 flex-col overflow-y-auto px-3 py-5">
        <Suspense fallback={<NavList pathname={null} />}>
          <ActiveNavList />
        </Suspense>
      </div>
      <p className="border-t border-border px-4 py-3 text-[11px] leading-relaxed text-subtle-foreground">
        {RISK_DISCLAIMER_SHORT}
      </p>
    </aside>
  );
}
