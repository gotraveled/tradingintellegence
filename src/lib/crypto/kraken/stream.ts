import type { FeedStatus } from "../types";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  KRAKEN_WS_URL,
  MAX_RECONNECT_ATTEMPTS,
  STALE_AFTER_MS,
} from "./constants";
import { parseKrakenWsMessage, type KrakenWsEvent } from "./normalize";

/**
 * Kraken WebSocket v2 client — a browser-side feed for public market data.
 * Unlike Binance's combined-stream URL, v2 channels are subscribed by sending
 * `{ method: "subscribe" }` frames after the socket opens; the connection
 * lifecycle (status semantics, freshness watchdog, bounded reconnect) mirrors
 * the Binance feed so the UI treats both venues identically.
 *
 * Status semantics (rendered verbatim by the UI — never inferred elsewhere):
 *   connecting   — socket opening, or open but silent
 *   live         — a real data message arrived inside the freshness window
 *   stale        — socket still open but silent beyond `staleAfterMs`
 *   reconnecting — socket dead; bounded exponential backoff retry scheduled
 *   offline      — browser offline, attempts exhausted, or `close()` called
 */

/** Minimal socket surface — DOM `WebSocket` satisfies this; tests inject a fake. */
export interface KrakenSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; wasClean?: boolean }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface KrakenStreamOptions {
  /** WS v2 channel symbols, e.g. ["BTC/USD", "ETH/USD"]. */
  symbols: readonly string[];
  /** OHLC interval in minutes (5, 15, 30, 60, 240, 1440) — omit to skip ohlc. */
  ohlcIntervalMinutes?: number;
  onMessage: (event: KrakenWsEvent) => void;
  onStatus?: (status: FeedStatus, lastEventAt?: number) => void;
  wsFactory?: (url: string) => KrakenSocketLike;
  staleAfterMs?: number;
  watchdogMs?: number;
  maxReconnectAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  now?: () => number;
  isOnline?: () => boolean;
  onOnlineChange?: (handler: (online: boolean) => void) => () => void;
}

const WS_OPEN = 1;

export class KrakenStream {
  private ws: KrakenSocketLike | undefined;
  private status: FeedStatus = "connecting";
  private lastMessageAt: number | undefined;
  private lastEventAt: number | undefined;
  private attempts = 0;
  private stopped = false;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribeOnline: (() => void) | undefined;

  private readonly opts: KrakenStreamOptions;
  private readonly wsFactory: (url: string) => KrakenSocketLike;
  private readonly now: () => number;
  private readonly isOnline: () => boolean;

  constructor(opts: KrakenStreamOptions) {
    this.opts = opts;
    this.wsFactory =
      opts.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as KrakenSocketLike);
    this.now = opts.now ?? (() => Date.now());
    this.isOnline =
      opts.isOnline ?? (() => (typeof navigator === "undefined" ? true : navigator.onLine));
  }

  get currentStatus(): FeedStatus {
    return this.status;
  }

  start(): void {
    this.stopped = false;
    this.attempts = 0;
    this.connect();
    this.opts.onStatus?.(this.status, this.lastEventAt);
    this.watchdog = setInterval(() => this.checkFreshness(), this.opts.watchdogMs ?? 5_000);
    this.unsubscribeOnline = this.bindOnline();
  }

  close(): void {
    this.stopped = true;
    this.clearTimers();
    this.unsubscribeOnline?.();
    this.teardownSocket();
    this.setStatus("offline");
  }

  private subscribe(ws: KrakenSocketLike): void {
    const symbols = [...this.opts.symbols];
    if (symbols.length === 0) return;
    try {
      ws.send(
        JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: symbols } }),
      );
      if (this.opts.ohlcIntervalMinutes !== undefined) {
        ws.send(
          JSON.stringify({
            method: "subscribe",
            params: {
              channel: "ohlc",
              symbol: symbols,
              interval: this.opts.ohlcIntervalMinutes,
            },
          }),
        );
      }
    } catch {
      // A send on a closing socket throws in some browsers — the onclose path
      // handles the reconnect; nothing else to do here.
    }
  }

  private bindOnline(): () => void {
    if (this.opts.onOnlineChange) {
      return this.opts.onOnlineChange((online) => this.handleOnline(online));
    }
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
    const ws = this.wsFactory(KRAKEN_WS_URL);
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.attempts = 0;
      this.subscribe(ws);
      // Stay "connecting" until the first real data message — an open socket
      // with no data is not a live feed.
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      const events = parseKrakenWsMessage(ev.data);
      for (const event of events) {
        if (event.kind === "ignored") continue;
        this.lastMessageAt = this.now();
        this.lastEventAt =
          event.kind === "ticker" ? event.quote.eventTime : event.intervalBeginMs;
        this.setStatus("live");
        this.opts.onMessage(event);
      }
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
    if (
      this.lastMessageAt !== undefined &&
      this.now() - this.lastMessageAt > (this.opts.staleAfterMs ?? STALE_AFTER_MS)
    ) {
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
