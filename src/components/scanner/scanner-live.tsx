"use client";

import { FlaskConical, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import type { ScannerView } from "@/lib/constants";
import { runAnalysis, toOpportunities } from "@/lib/services/analysis-runner";
import { ServiceUnavailableError } from "@/lib/services/types";
import type { AnalysisRequest, AnalysisResult, Opportunity } from "@/lib/types";
import { ScannerResults } from "./scanner-results";

type LiveState =
  | { status: "loading" }
  | { status: "success"; result: AnalysisResult; opportunities: Opportunity[] }
  | { status: "error"; message: string; unavailable: boolean };

interface ScannerLiveProps {
  /** Demo payload for the explicit preview path — rendered only on user action. */
  demo: Opportunity[];
  view?: ScannerView;
}

// The scanner's live surface is the catalog universe at the default 4h frame —
// the same symbols and timeframe the UI's featured set advertises. Catalog-only
// by contract: symbols the provider cannot serve land in `skipped`, never
// silently substituted.
const SCAN_REQUEST: AnalysisRequest = {
  symbols: ["BTCUSDT", "ETHUSDT", "XAUUSD", "EURUSD", "GBPUSD", "NAS100", "AAPL"],
  timeframe: "4h",
};

/** Fetch adapter — module-level so the effect body contains no setState call. */
function fetchScan(
  onSuccess: (state: LiveState) => void,
  onError: (state: LiveState) => void,
): void {
  runAnalysis({ ...SCAN_REQUEST })
    .then((result) =>
      onSuccess({ status: "success", result, opportunities: toOpportunities(result) }),
    )
    .catch((error: unknown) =>
      onError({
        status: "error",
        message: error instanceof Error ? error.message : "Unexpected error.",
        unavailable: error instanceof ServiceUnavailableError,
      }),
    );
}

/**
 * The live scanner path — fetches point-in-time engine observations from
 * `/api/analysis` (server-side provider + engine; historical aggregates).
 * No demo fallback happens silently: demo data renders only via the explicit
 * "Preview demo data" action, always badged.
 */
export function ScannerLive({ demo, view }: ScannerLiveProps) {
  const [state, setState] = useState<LiveState>({ status: "loading" });
  const [demoPreview, setDemoPreview] = useState(false);

  // Fetch on mount; setState runs only inside async callbacks, never synchronously
  // in the effect body.
  useEffect(() => {
    let cancelled = false;
    const ok = (s: LiveState) => { if (!cancelled) setState(s); };
    fetchScan(ok, ok);
    return () => {
      cancelled = true;
    };
  }, []);

  const retry = () => {
    setState({ status: "loading" });
    fetchScan(setState, setState);
  };

  const live = state.status === "success" ? state.opportunities : null;

  return (
    <div className="space-y-4">
      {state.status === "loading" ? (
        <div className="space-y-4" aria-busy="true" aria-label="Running analysis">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : null}

      {state.status === "error" ? (
        <EmptyState
          icon={RefreshCw}
          title={state.unavailable ? "Analysis unavailable" : "Analysis failed"}
          description={state.message}
          action={
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={retry}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-hover"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => setDemoPreview(true)}
                className="flex items-center gap-1.5 rounded-md border border-dashed border-warning/40 px-3 py-1.5 text-xs font-medium text-warning hover:bg-warning-muted"
              >
                <FlaskConical className="size-3.5" aria-hidden="true" />
                Preview demo data
              </button>
            </div>
          }
        />
      ) : null}

      {state.status === "success" ? (
        <div className="space-y-4">
          <Notice title="Historical aggregate analysis">
            The evaluation timestamp is stamped per symbol. Scores describe evidence
            quality, not the probability of profit.
          </Notice>
          {state.result.skipped.length > 0 ? (
            <Notice
              tone="warning"
              title={
                state.result.skipped.length === 1
                  ? `${state.result.skipped[0].symbol} could not be evaluated`
                  : `${state.result.skipped.length} symbols could not be evaluated`
              }
            >
              {state.result.skipped
                .map((skip) => `${skip.symbol}: ${skip.reason}`)
                .join(" · ")}
            </Notice>
          ) : null}
        </div>
      ) : null}

      {demoPreview ? (
        <ScannerResults opportunities={demo} source="demo" view={view} />
      ) : live !== null ? (
        <ScannerResults opportunities={live} source="live" view={view} />
      ) : null}
    </div>
  );
}
