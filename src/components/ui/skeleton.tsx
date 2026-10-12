import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-surface-elevated", className)} />;
}

/** Generic placeholder for a module page while URL-dependent content streams in. */
export function PageSkeleton() {
  return (
    <div
      className="mx-auto w-full max-w-[1440px] space-y-6 px-4 py-6 sm:px-6 lg:py-8"
      aria-busy="true"
      aria-label="Loading"
    >
      <div className="space-y-3">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <Skeleton className="h-9 w-full" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
    </div>
  );
}
