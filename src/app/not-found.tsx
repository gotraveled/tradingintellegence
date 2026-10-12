import Link from "next/link";
import { BrandMark } from "@/components/navigation/brand";
import { buttonVariants } from "@/components/ui/button";
import { ROUTES } from "@/lib/constants";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-24 text-center">
      <BrandMark className="size-8" />
      <div className="space-y-2">
        <p className="numeric text-xs text-subtle-foreground">404</p>
        <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
        <p className="text-sm text-muted-foreground">The page you requested does not exist.</p>
      </div>
      <Link href={ROUTES.dashboard} className={buttonVariants({ variant: "secondary" })}>
        Go to dashboard
      </Link>
    </main>
  );
}
