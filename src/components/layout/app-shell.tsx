import type { ReactNode } from "react";
import { Sidebar } from "@/components/navigation/sidebar";
import { Topbar } from "./topbar";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main id="main-content" className="flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}
