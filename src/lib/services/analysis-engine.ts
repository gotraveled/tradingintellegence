import type { AssetClass, Opportunity, SetupType, Timeframe } from "@/lib/types";

export interface ScanRequest {
  assetClasses?: AssetClass[];
  symbols?: string[];
  timeframes: Timeframe[];
  setupTypes?: SetupType[];
  minScore?: number;
}

/**
 * Contract for the independent analysis engine (planned as a separate Python/FastAPI service).
 * The UI depends only on this interface, never on detection internals.
 */
export interface AnalysisEngineClient {
  scan(request: ScanRequest): Promise<Opportunity[]>;
  getOpportunity(id: string): Promise<Opportunity | null>;
}
