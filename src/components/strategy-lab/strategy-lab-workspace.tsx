"use client";

import { useRef, useState } from "react";
import { runBacktest } from "@/lib/services/backtest-runner";
import type { DataEnvelope } from "@/lib/services/types";
import type { BacktestRequest, BacktestResult, Strategy } from "@/lib/types";
import { BacktestForm } from "./backtest-form";
import { BacktestResults, type BacktestState } from "./backtest-results";

interface StrategyLabWorkspaceProps {
  strategies: Strategy[];
  demoResult: DataEnvelope<BacktestResult>;
}

export function StrategyLabWorkspace({ strategies, demoResult }: StrategyLabWorkspaceProps) {
  const [state, setState] = useState<BacktestState>({ status: "idle" });
  const lastRequest = useRef<BacktestRequest | null>(null);

  const execute = async (request: BacktestRequest) => {
    lastRequest.current = request;
    setState({ status: "running" });
    try {
      const result = await runBacktest(request);
      setState({ status: "success", result, source: "live" });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Unexpected error.",
      });
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
      <div className="xl:sticky xl:top-20 xl:self-start">
        <BacktestForm
          strategies={strategies}
          running={state.status === "running"}
          onSubmit={execute}
        />
      </div>
      <BacktestResults
        state={state}
        onRetry={() => {
          if (lastRequest.current) void execute(lastRequest.current);
        }}
        onPreviewDemo={() =>
          setState({ status: "success", result: demoResult.data, source: demoResult.source })
        }
      />
    </div>
  );
}
