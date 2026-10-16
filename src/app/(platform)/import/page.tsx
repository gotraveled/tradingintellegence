import type { Metadata } from "next";
import { DataImportWorkspace } from "@/components/import/data-import-workspace";

export const metadata: Metadata = {
  title: "Data Import",
  description:
    "Upload your own OHLC CSV dataset and run the canonical analysis engine on it — no market-data subscription required.",
};

export default function ImportPage() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 lg:p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Data Import</h1>
        <p className="text-sm text-muted-foreground">
          Your candles, our engine. Upload an OHLCV export, validate it, and run
          the same analysis pipeline the scanner uses — no API key needed.
        </p>
      </header>
      <DataImportWorkspace />
    </div>
  );
}
