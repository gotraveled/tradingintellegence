import type { FeedStatus } from "../types";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  binanceStreamUrl,
  MAX_RECONNECT_ATTEMPTS,
  STALE_AFTER_MS,
} from "./constants";
import { parseStreamMessage, type StreamEnvelope } from "./normalize";

/**
 * Binance combined-stream client — a browser-side WebSocket feed for public
 * market data. Owns the connection lifecycle only; payloads are dispatched to
 * the caller verbatim.
 *
 * Status semantics (rendered verbatim by the UI — never inferred elsewhere):
 *   connecting   — socket opening, or open but silent
 *   live         — a real message arrived inside the freshness window
 *   stale        — socket still open but silent beyond `staleAfterMs`
 *   reconnecting — socket dead; bounded exponential backoff retry scheduled
 *   offline      — browser offline, attempts exhausted, or `close()` called
 *
 * Honesty rules: `live` is emitted only after a real received message; stale
 * values remain displayed with the last received timestamp; `close()` tears
 * down listeners, timers, and the socket — nothing reconnects a closed feed.
 */

/** Minimal socket surface — the DOM `WebSocket` satisfies this; tests inject a fake. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; wasClean?: boolean }) => void) | null;
  close(): void;
}

export interface BinanceStreamOptions {
  /** Combined-stream suffixes, e.g. `["btcusdt@ticker", "btcusdt@kline_1h"]`. */
  streams: readonly string[];
  onMessage: (envelope: StreamEnvelope) => void;
  onStatus?: (status: FeedStatus, lastEventAt?: number) => void;
  /** Injectable for tests — production uses `new WebSocket(url)`. */
  wsFactory?: (url: string) => SocketLike;
  staleAfterMs?: number;
  /** Freshness-check cadence — 5s in production, tunable in tests. */
  watchdogMs?: number;
  maxReconnectAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  now?: () => number;
  /** Injectable offline check — production reads `navigator.onLine`. */
  isOnline?: () => boolean;
  /** Injectable online/offline event subscription — production uses window events. */
  onOnlineChange?: (handler: (online: boolean) => void) => () => void;
}

const WS_OPEN = 1;

export class BinanceStream {
  private ws: SocketLike | undefined;
  private status: FeedStatus = "connecting";
  private lastMessageAt: number | undefined;
  private lastEventAt: number | undefined;
  private attempts = 0;
  private stopped = false;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribeOnline: (() => void) | undefined;

  private readonly opts: BinanceStreamOptions;
  private readonly wsFactory: (url: string) => SocketLike;
  private readonly now: () => number;
  private readonly isOnline: () => boolean;

  constructor(opts: BinanceStreamOptions) {
    this.opts = opts;
    this.wsFactory =
      opts.wsFactory ??
      ((url: string) => new WebSocket(url) as unknown as SocketLike);
    this.now = opts.now ?? (() => Date.now());
    this.isOnline =
      opts.isOnline ??
      (() => (typeof navigator === "undefined" ? true : navigator.onLine));
  }

  get currentStatus(): FeedStatus {
    return this.status;
  }

  /** Start (or restart) the feed. Idempotent-safe: closes any existing socket. */
  start(): void {
    this.stopped = false;
    this.attempts = 0;
    this.connect();
    // Report the opening state — subscribers must always see a status, even
    // before the first transition.
    this.opts.onStatus?.(this.status, this.lastEventAt);
    this.watchdog = setInterval(() => this.checkFreshness(), this.opts.watchdogMs ?? 5_000);
    this.unsubscribeOnline = this.bindOnline();
  }

  /** Permanently stop — unmount path. Removes every timer/listener/socket. */
  close(): void {
    this.stopped = true;
    this.clearTimers();
    this.unsubscribeOnline?.();
    this.teardownSocket();
    this.setStatus("offline");
  }

  private bindOnline(): () => void {
    if (this.opts.onOnlineChange) return this.opts.onOnlineChange((online) => this.handleOnline(online));
    if (typeof window === "undefined") return () => {};
    const online = () => this.handleOnline(true);
    const offline = () => this.handleOnline(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }

  private handleOnline(online: boolean): void {
    if (this.stopped) return;
    if (online) {
      // Network restored — immediate reconnect regardless of backoff position.
      this.attempts = 0;
      this.clearRetry();
      this.connect();
    } else {
      this.clearRetry();
      this.teardownSocket();
      this.setStatus("offline");
    }
  }

  private connect(): void {
    if (this.stopped) return;
    if (!this.isOnline()) {
      this.setStatus("offline");
      return;
    }
    this.teardownSocket();
    this.setStatus(this.attempts > 0 ? "reconnecting" : "connecting");
    const url = binanceStreamUrl(this.opts.streams);
    const ws = this.wsFactory(url);
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      // Stay "connecting" until the first real message — an open socket with no
      // data is not a live feed.
      this.attempts = 0;
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      const envelope = parseStreamMessage(ev.data);
      if (envelope === undefined) return; // malformed frame — ignore, never fabricate
      this.lastMessageAt = this.now();
      const eventTime =
        typeof envelope.data.E === "number" ? envelope.data.E : this.lastMessageAt;
      this.lastEventAt = eventTime;
      this.setStatus("live");
      this.opts.onMessage(envelope);
    };
    ws.onerror = () => {
      // onclose follows; nothing to do here.
    };
    ws.onclose = () => {
      if (ws !== this.ws || this.stopped) return;
      this.ws = undefined;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (!this.isOnline()) {
      this.setStatus("offline");
      return;
    }
    if (this.attempts >= (this.opts.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS)) {
      this.setStatus("offline");
      return;
    }
    const base = this.opts.backoffBaseMs ?? BACKOFF_BASE_MS;
    const cap = this.opts.backoffMaxMs ?? BACKOFF_MAX_MS;
    const delay = Math.min(base * 2 ** this.attempts, cap);
    this.attempts += 1;
    this.setStatus("reconnecting");
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private checkFreshness(): void {
    if (this.stopped || this.status === "offline" || this.status === "reconnecting") return;
    if (this.ws === undefined || this.ws.readyState !== WS_OPEN) return;
    if (this.lastMessageAt !== undefined && this.now() - this.lastMessageAt > (this.opts.staleAfterMs ?? STALE_AFTER_MS)) {
      this.setStatus("stale");
    }
  }

  private teardownSocket(): void {
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      // closing an already-dead socket — ignore.
    }
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.clearRetry();
    if (this.watchdog !== undefined) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
  }

  private setStatus(status: FeedStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatus?.(status, this.lastEventAt);
  }
}

/** Subscribe one `ticker` stream per symbol — the quote overview feed. */
export function tickerStreams(symbols: readonly string[]): string[] {
  return symbols.map((s) => `${s}@ticker`);
}

/** Kline stream for the chart's selected symbol+interval (Binance interval id). */
export function klineStream(symbol: string, binanceIntervalId: string): string {
  return `${symbol}@kline_${binanceIntervalId}`;
}
