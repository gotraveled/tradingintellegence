import type { Metadata } from "next";
import { MarketsWorkspace } from "@/components/markets/markets-workspace";

export const metadata: Metadata = { title: "Markets · Global Markets" };

export default function MarketsPage() {
  return <MarketsWorkspace />;
}
