import type { Timeframe } from "@/lib/types";
import { cryptoError, type CryptoError, type CryptoQuote, type CryptoResult } from "../types";
import type { CryptoCandleSet } from "../types";
import {
  isKrakenSymbol,
  KRAKEN_REST_BASE,
  KRAKEN_SYMBOLS,
  KLINE_LIMIT,
  krakenIntervalMinutes,
  REST_TIMEOUT_MS,
} from "./constants";
import { normalizeKrakenOhlc, normalizeKrakenTickers } from "./normalize";

/**
 * Kraken Spot public REST client — browser-safe, credential-free.
 *
 * - Strict symbol/timeframe allowlists before any request is built.
 * - Bounded by `KLINE_LIMIT`, `REST_TIMEOUT_MS`; single verified public host.
 * - Errors are returned, never thrown; HTTP 429 maps to `rate_limited`,
 *   Kraken's `error` array to `provider_error`, malformed JSON to
 *   `invalid_data`, transport failures to `provider_error`.
 * - Nothing here synthesizes data: a failed fetch is an error, not a substitute.
 */

export interface KrakenRestConfig {
  fetchImpl?: typeof fetch;
  base?: string;
  timeoutMs?: number;
}

async function fetchJson(
  path: string,
  config: KrakenRestConfig,
): Promise<{ ok: true; body: unknown } | { ok: false; error: CryptoError }> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? REST_TIMEOUT_MS;
  const url = `${config.base ?? KRAKEN_REST_BASE}${path}`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
  } catch {
    return { ok: false, error: { code: "provider_error", message: "Kraken endpoint unreachable", detail: url } };
  }
  if (!res.ok) {
    const code =
      res.status === 429 ? "rate_limited"
      : res.status === 400 || res.status === 404 ? "invalid_request"
      : "provider_error";
    return {
      ok: false,
      error: { code, message: `Kraken request failed (HTTP ${res.status})`, detail: url },
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: { code: "invalid_data", message: "Malformed JSON from Kraken", detail: url } };
  }
  // Kraken wraps every response as { error: string[], result: ... } — a
  // non-empty error array means the exchange rejected the call.
  if (typeof body === "object" && body !== null) {
    const errs = (body as Record<string, unknown>).error;
    if (Array.isArray(errs) && errs.length > 0) {
      return {
        ok: false,
        error: { code: "provider_error", message: `Kraken: ${errs.join("; ")}`, detail: url },
      };
    }
    return { ok: true, body: (body as Record<string, unknown>).result };
  }
  return { ok: false, error: { code: "invalid_data", message: "Malformed Kraken envelope", detail: url } };
}

/** `GET /0/public/Ticker` for the whole allowlist — one request. */
export async function fetchKrakenQuotes(
  config: KrakenRestConfig = {},
): Promise<CryptoResult<CryptoQuote[]>> {
  const pairs = KRAKEN_SYMBOLS.map((s) => s.restKeys[0]);
  const res = await fetchJson(`/0/public/Ticker?pair=${pairs.join(",")}`, config);
  if (!res.ok) return res;
  const normalized = normalizeKrakenTickers(res.body);
  if ("error" in normalized) {
    return cryptoError("invalid_data", normalized.error);
  }
  return { ok: true, data: normalized.quotes };
}

/** `GET /0/public/OHLC` — bounded, allowlisted, normalized to `Candle[]`. */
export async function fetchKrakenOhlc(
  symbol: string,
  timeframe: Timeframe,
  limit = KLINE_LIMIT,
  config: KrakenRestConfig = {},
): Promise<CryptoResult<CryptoCandleSet>> {
  const info = KRAKEN_SYMBOLS.find((s) => s.symbol === symbol);
  if (!isKrakenSymbol(symbol) || info === undefined) {
    return cryptoError("unsupported_symbol", `symbol '${symbol}' is not on the Kraken allowlist`);
  }
  const interval = krakenIntervalMinutes(timeframe);
  if (interval === undefined) {
    return cryptoError("unsupported_timeframe", `timeframe '${timeframe}' is not offered for crypto`);
  }
  const res = await fetchJson(
    `/0/public/OHLC?pair=${info.restKeys[0]}&interval=${interval}`,
    config,
  );
  if (!res.ok) return res;
  const normalized = normalizeKrakenOhlc(res.body, symbol, timeframe);
  if ("error" in normalized) {
    return cryptoError("invalid_data", normalized.error);
  }
  // Kraken returns up to 720 rows — tail-slice to the bound, keep newest bars.
  const bounded = Math.max(1, Math.floor(limit));
  const candles = normalized.candles.slice(-bounded);
  return { ok: true, data: { ...normalized, candles } };
}
