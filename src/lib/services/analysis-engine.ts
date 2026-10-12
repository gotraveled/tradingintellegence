import type {
  AnalysisSnapshot,
  AssetClass,
  BacktestResult,
  Direction,
  LiquidityEvent,
  MarketSegmentId,
  MarketStructure,
  Opportunity,
  OpportunityStatus,
  Setup,
  SetupType,
  Signal,
  Timeframe,
  Zone,
} from "@/lib/types";

export interface ScanRequest {
  markets?: MarketSegmentId[];
  assetClasses?: AssetClass[];
  symbols?: string[];
  timeframes: Timeframe[];
  setupTypes?: SetupType[];
  directions?: Direction[];
  statuses?: OpportunityStatus[];
  minScore?: number;
}

interface SymbolTimeframe {
  symbol: string;
  timeframe: Timeframe;
}

/**
 * Contract for the independent analysis engine (planned as a separate Python/FastAPI service).
 * The UI depends only on this interface, never on detection internals.
 */
export interface AnalysisEngineClient {
  scan(request: ScanRequest): Promise<Opportunity[]>;
  getOpportunity(id: string): Promise<Opportunity | null>;
  getSetup(id: string): Promise<Setup | null>;
  getAnalysis(params: SymbolTimeframe): Promise<AnalysisSnapshot | null>;
  getStructure(params: SymbolTimeframe): Promise<MarketStructure | null>;
  getZones(params: SymbolTimeframe): Promise<Zone[]>;
  getLiquidity(params: SymbolTimeframe): Promise<LiquidityEvent[]>;
  getSignals(params: SymbolTimeframe & { since?: string }): Promise<Signal[]>;
  getBacktest(id: string): Promise<BacktestResult | null>;
}
