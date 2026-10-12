import { BrandMark } from "@/components/navigation/brand";
import { RISK_DISCLAIMER, SITE } from "@/lib/constants";

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-10 sm:px-6">
        <div className="flex items-center gap-2.5">
          <BrandMark className="size-5" />
          <span className="text-sm font-medium">{SITE.name}</span>
        </div>
        <p className="max-w-3xl text-xs leading-relaxed text-subtle-foreground">
          {RISK_DISCLAIMER}
        </p>
      </div>
    </footer>
  );
}
