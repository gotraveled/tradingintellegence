import Link from "next/link";
import { SITE } from "@/lib/constants";
import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("size-6 text-primary", className)}
    >
      <rect
        x="1"
        y="1"
        width="22"
        height="22"
        rx="5"
        className="stroke-current"
        strokeOpacity="0.35"
        strokeWidth="1.5"
      />
      <path
        d="M7 15.5 10.5 11l3 2.5L17 8"
        className="stroke-current"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="17" cy="8" r="1.5" className="fill-current" />
    </svg>
  );
}

export function Brand({ href = "/", className }: { href?: string; className?: string }) {
  return (
    <Link href={href} className={cn("flex items-center gap-2.5", className)}>
      <BrandMark />
      <span className="text-sm font-semibold tracking-tight">{SITE.name}</span>
    </Link>
  );
}
