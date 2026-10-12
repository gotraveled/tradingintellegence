"use client";

import { usePathname } from "next/navigation";
import { NavList } from "./nav-list";

export function ActiveNavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return <NavList pathname={pathname} onNavigate={onNavigate} />;
}
