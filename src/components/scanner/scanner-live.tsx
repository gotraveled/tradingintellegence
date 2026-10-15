"use client";

import { FlaskConical, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { SCAN_REQUEST, type ScannerView } from "@/lib/constants";
import { runAnalysis, toOpportunities } from "@/lib/services/analysis-runner";
import { ServiceUnavailableError } from "@/lib/services/types";
import type { AnalysisResult, Opportunity } from "@/lib/types";
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

/**
 * Fetch adapter — module-level so the effect body contains no setState call.
 * `signal` aborts the underlying request; `onDone` is expected to ignore calls
 * whose signal has fired (stale-result protection lives in the caller).
 */
function fetchScan(
  onDone: (state: LiveState) => void,
  signal: AbortSignal,
): void {
  runAnalysis({ ...SCAN_REQUEST }, { signal })
    .then((result) =>
      onDone({ status: "success", result, opportunities: toOpportunities(result) }),
    )
    .catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      onDone({
        status: "error",
        message: error instanceof Error ? error.message : "Unexpected error.",
        unavailable: error instanceof ServiceUnavailableError,
      });
    });
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
  /** In-flight scan's abort handle — cleanup aborts whichever fetch is current. */
  const scanAbort = useRef<AbortController | undefined>(undefined);

  // Fetch on mount; setState runs only inside async callbacks, never synchronously
  // in the effect body. The signal both aborts the request and gates setState.
  useEffect(() => {
    const controller = new AbortController();
    scanAbort.current = controller;
    fetchScan((s) => {
      if (!controller.signal.aborted) setState(s);
    }, controller.signal);
    return () => scanAbort.current?.abort();
  }, []);

  const retry = () => {
    scanAbort.current?.abort();
    const controller = new AbortController();
    scanAbort.current = controller;
    setState({ status: "loading" });
    fetchScan((s) => {
      if (!controller.signal.aborted) setState(s);
    }, controller.signal);
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
