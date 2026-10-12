import type { Metadata } from "next";
import { ScannerWorkspace } from "@/components/scanner/scanner-workspace";

export const metadata: Metadata = { title: "Scanner · All Opportunities" };

export default function ScannerPage() {
  return <ScannerWorkspace />;
}
