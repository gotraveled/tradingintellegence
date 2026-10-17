import type { Metadata } from "next";
import { HistoricalValidationWorkspace } from "@/components/validation/historical-validation-workspace";

export const metadata: Metadata = {
  title: "Historical Validation",
  description:
    "Evaluate engine scenarios against subsequent candles in your own uploaded OHLC datasets — causal, honest, reproducible.",
};

export default function ValidationPage() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 lg:p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Historical Validation</h1>
        <p className="text-sm text-muted-foreground">
          Measure how detected scenarios played out on the candles that followed
          them — using only your uploaded data. Outcomes are measured honestly:
          no look-ahead, conservative same-bar rules, explicit costs, and
          disclosed limitations. Past results never imply future performance.
        </p>
      </header>
      <HistoricalValidationWorkspace />
    </div>
  );
}
