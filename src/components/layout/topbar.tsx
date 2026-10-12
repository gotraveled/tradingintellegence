import { Search } from "lucide-react";
import { MobileNav } from "@/components/navigation/mobile-nav";
import { ConnectionBadge } from "@/components/ui/status";
import { getSystemStatus } from "@/lib/services/system-status";

export function Topbar() {
  const marketData = getSystemStatus().find((service) => service.id === "market-data");

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/75 sm:px-6">
      <MobileNav />
      <div className="relative w-full max-w-md">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle-foreground"
          aria-hidden="true"
        />
        <input
          type="search"
          disabled
          aria-label="Search instruments"
          placeholder="Search instruments — requires a market data provider"
          className="h-9 w-full rounded-md border border-border bg-surface pr-3 pl-9 text-sm placeholder:text-subtle-foreground disabled:cursor-not-allowed"
        />
      </div>
      <div className="ml-auto hidden items-center gap-2 sm:flex">
        <span className="text-xs text-subtle-foreground">Market data</span>
        {marketData ? <ConnectionBadge status={marketData.status} /> : null}
      </div>
    </header>
  );
}
