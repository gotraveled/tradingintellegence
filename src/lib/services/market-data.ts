import type { Candle, Instrument, Quote, Timeframe } from "@/lib/types";

/**
 * Contract for market-data providers (REST/WebSocket vendors, internal APIs).
 * Concrete implementations are added in later phases and selected via configuration.
 */
export interface MarketDataProvider {
  readonly id: string;
  searchInstruments(query: string): Promise<Instrument[]>;
  getQuotes(symbols: string[]): Promise<Quote[]>;
  getCandles(params: {
    symbol: string;
    timeframe: Timeframe;
    from?: number;
    to?: number;
    limit?: number;
  }): Promise<Candle[]>;
}
