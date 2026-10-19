import type { Timeframe } from "@/lib/types";
import { cryptoError, type CryptoError, type CryptoQuote, type CryptoResult } from "../types";
import type { CryptoCandleSet } from "../types";
import {
  BINANCE_REST_HOSTS,
  binanceInterval,
  isCryptoSymbol,
  KLINE_LIMIT,
  KLINE_LIMIT_MAX,
  REST_TIMEOUT_MS,
} from "./constants";
import { normalizeKlines, normalizeTicker } from "./normalize";

/**
 * Binance Spot public REST client — browser-safe, credential-free.
 *
 * - Strict symbol/timeframe allowlists before any request is built.
 * - Bounded by `KLINE_LIMIT_MAX`, `REST_TIMEOUT_MS`; host failover across the
 *   verified public endpoints (market-data hosts only — never private endpoints).
 * - Errors are returned, never thrown; HTTP 429/418 map to `rate_limited`,
 *   malformed JSON to `invalid_data`, transport failures to `provider_error`.
 * - Nothing here synthesizes data: a failed fetch is an error, not a substitute.
 */

export interface BinanceRestConfig {
  fetchImpl?: typeof fetch;
  hosts?: readonly string[];
  timeoutMs?: number;
}

async function fetchJson(
  path: string,
  config: BinanceRestConfig,
): Promise<{ ok: true; body: unknown; host: string } | { ok: false; error: CryptoError }> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const hosts = config.hosts ?? BINANCE_REST_HOSTS;
  const timeoutMs = config.timeoutMs ?? REST_TIMEOUT_MS;
  let lastError: CryptoError | undefined;

  for (const host of hosts) {
    const url = `${host}${path}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
    } catch {
      // Timeout/DNS/network — try the next verified host before failing.
      lastError = { code: "provider_error", message: "Binance endpoint unreachable", detail: url };
      continue;
    }
    if (res.ok) {
      try {
        const body: unknown = await res.json();
        return { ok: true, body, host };
      } catch {
        lastError = { code: "invalid_data", message: "Malformed JSON from Binance", detail: url };
        continue;
      }
    }
    if (res.status === 429 || res.status === 418) {
      // Retry-after honoured by the caller's UI state — no hammering.
      return {
        ok: false,
        error: { code: "rate_limited", message: `Binance rate limit (HTTP ${res.status})`, detail: url },
      };
    }
    if (res.status === 400 || res.status === 404) {
      return {
        ok: false,
        error: {
          code: "invalid_request",
          message: `Binance rejected the request (HTTP ${res.status})`,
          detail: url,
        },
      };
    }
    if (res.status === 451 || res.status === 403) {
      return {
        ok: false,
        error: {
          code: "provider_error",
          message: `Binance endpoint not accessible from this network (HTTP ${res.status})`,
          detail: url,
        },
      };
    }
    lastError = {
      code: "provider_error",
      message: `Binance request failed (HTTP ${res.status})`,
      detail: url,
    };
  }
  return { ok: false, error: lastError ?? { code: "provider_error", message: "No Binance host configured" } };
}

/** `GET /api/v3/ticker/24hr` for the allowlist — one request, per-symbol rows. */
export async function fetchCryptoQuotes(
  symbols: readonly string[],
  config: BinanceRestConfig = {},
): Promise<CryptoResult<CryptoQuote[]>> {
  const allowed = symbols.filter(isCryptoSymbol);
  if (allowed.length === 0) {
    return cryptoError("unsupported_symbol", `no allowlisted symbols in [${symbols.join(", ")}]`);
  }
  const param = encodeURIComponent(JSON.stringify(allowed));
  const res = await fetchJson(`/api/v3/ticker/24hr?symbols=${param}`, config);
  if (!res.ok) return res;
  if (!Array.isArray(res.body)) {
    return cryptoError("invalid_data", "malformed 24hr ticker payload (expected array)");
  }
  const quotes: CryptoQuote[] = [];
  const warnings: string[] = [];
  for (const row of res.body) {
    const sym = typeof row === "object" && row !== null ? String((row as Record<string, unknown>).symbol ?? "") : "";
    const quote = normalizeTicker(row, sym);
    if (quote !== undefined && isCryptoSymbol(quote.symbol)) {
      quotes.push(quote);
    } else {
      warnings.push(`dropped malformed ticker row (${sym || "unknown"})`);
    }
  }
  if (quotes.length === 0) {
    return cryptoError("invalid_data", "ticker response contained no usable rows", warnings.join("; "));
  }
  return { ok: true, data: quotes };
}

/** `GET /api/v3/klines` — bounded, allowlisted, normalized to `Candle[]`. */
export async function fetchCryptoKlines(
  symbol: string,
  timeframe: Timeframe,
  limit = KLINE_LIMIT,
  config: BinanceRestConfig = {},
): Promise<CryptoResult<CryptoCandleSet>> {
  if (!isCryptoSymbol(symbol)) {
    return cryptoError("unsupported_symbol", `symbol '${symbol}' is not on the crypto allowlist`);
  }
  const interval = binanceInterval(timeframe);
  if (interval === undefined) {
    return cryptoError("unsupported_timeframe", `timeframe '${timeframe}' is not offered for crypto`);
  }
  const bounded = Math.max(1, Math.min(Math.floor(limit), KLINE_LIMIT_MAX));
  const res = await fetchJson(
    `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${bounded}`,
    config,
  );
  if (!res.ok) return res;
  const normalized = normalizeKlines(res.body, symbol, timeframe);
  if ("error" in normalized) {
    return cryptoError("invalid_data", normalized.error);
  }
  return { ok: true, data: normalized };
}
