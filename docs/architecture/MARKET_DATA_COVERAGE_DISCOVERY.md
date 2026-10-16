# Market Data Coverage Discovery

Status: discovery record — audited **2026-10-16** (UTC+05:30).
Scope: what the configured market-data layer actually serves today, per catalog
instrument and timeframe, with evidence class attached to every claim.

Related: `MARKET_DATA_PROVIDER_EVALUATION.md`, `MARKET_DATA_INTEGRATION_DESIGN.md`,
`MARKET_DATA_IMPLEMENTATION_ROADMAP.md`, `docs/market-data/README.md`,
`UNIFIED_MARKET_WORKSPACE_DISCOVERY.md`.

---

## 1. What exists today

### Provider layer (`src/lib/market-data/`)

- **`providers/polygon.ts`** — the only live `HistoricalDataProvider`. Maps the
  catalog onto Polygon aggregates: crypto `USDT`→`USD` pairs (`X:BTCUSD`), forex
  and spot metals under `C:` (`C:EURUSD`, `C:XAUUSD`), equities bare (`AAPL`),
  indices via `INDEX_TICKERS` (`NAS100` → `I:NDX`). `adjusted=false` always;
  `end` shifted −1 ms for Polygon's inclusive `to`; `next_url` pagination bounded
  at 40 pages; page-boundary dedup; one bounded retry on 429/5xx/network.
- **`indian-markets` is rejected in code** — `polygonTickerFor` returns
  `undefined` for `marketId === "indian-markets"` before any request
  (`polygon.ts:68`). NIFTY 50 can never reach the vendor.
- **`providers/index.ts`** — `createConfiguredProvider()` builds Polygon from
  `POLYGON_API_KEY` / `MARKET_DATA_BASE_URL`; `observeProviderHealth` records
  last-observed connectivity passively (no probes).
- **`providers/health.ts`** — `connected` only after a real answered request;
  `unverified` = key present, never answered.

### Product services

- `services/candles-service.ts` → `POST /api/candles` — bounded windows
  (`≤2000` bars, `≤1825` days), catalog-first `resolveAsset`, provider errors
  mapped to HTTP by code; 200-with-zero-candles is a valid empty window.
- `services/analysis-service.ts` → `POST /api/analysis` — per-symbol cells,
  last-**closed**-bar anchor (`closedIndexAt`), per-symbol `skipped` reasons,
  `dataSource` on the result.
- `services/system-status.ts` — `market-data` service reports
  `not_configured / unverified / connected / degraded`; `live-quotes` is
  hardcoded `not_configured` — correct, nothing streams.
- `services/intelligence.ts` — `getAnalysisSnapshots()` still returns
  `source: "demo"` envelopes (BTCUSDT/XAUUSD only). Chart overlays and the
  demo trade-plan panel are subordinated to live results (Phase 4 work).

### Configuration evidence

- `.env.example` declares `POLYGON_API_KEY` + `MARKET_DATA_BASE_URL` only.
- `.env.local` contains a `POLYGON_API_KEY` value (32 chars — **configured**;
  value not inspected or reproduced here).

## 2. Real-provider smoke test — executed 2026-10-16

Bounded reads against `https://api.polygon.io/v2/aggs` with the configured key
(key read from `.env.local` in-shell, never printed). ~15 requests total,
`limit=100`, `adjusted=false`.

| Request | Response |
|---|---|
| `AAPL` 1d, 30d window | `status=DELAYED`, 22 bars, 2026-09-15 → **2026-10-14** |
| `AAPL` 1h, 30d window | `status=DELAYED`, **2 bars** (Sep 15 20:00, 21:00) |
| `AAPL` 5m, 7d window | `status=DELAYED`, **28 bars** — one fragment, Oct 8 20:20–22:35 |
| `X:BTCUSD` 1d, 30d | `status=DELAYED`, 30 bars, → Oct 14 |
| `X:BTCUSD` 1h, 7d | `status=DELAYED`, **1 bar** (Oct 8 20:00) |
| `X:BTCUSD` 5m, 3d | `status=DELAYED`, **20 bars** — fragment, Oct 12 20:20–21:55 |
| `X:BTCUSD` 1w, 60d | `status=DELAYED`, 9 bars, → Oct 11 (week open) |
| `C:EURUSD` 1d, 30d | `status=DELAYED`, 26 bars, → Oct 14 |
| `C:XAUUSD` 1d, 30d | `status=DELAYED`, 26 bars, → Oct 14 |
| `C:XAUUSD` 1h, 30d | `status=DELAYED`, **2 bars** (Sep 15) |
| `I:NDX` 1d, 30d | `status=DELAYED`, 23 bars, → Oct 14 (bars at 05:00 UTC — Polygon's index-day convention) |
| NIFTY 50 | **not sent** — `supports()` is false by code |

### Interpretation (facts vs inference)

**Facts:** every response carries `status: "DELAYED"`; daily and weekly
aggregates return complete plausible series ending **2026-10-14** (≈1 trading
day stale at query time); intraday (minute/hour) aggregates return arbitrary
fragments — single sessions days old, single stray bars — not usable series.

**Inference (provider pricing confirms):** the key sits on the free "Basic"
entitlement — per Polygon/Massive's published plans, Basic is **end-of-day
data only, 5 calls/min** for stocks, indices and currencies. That explains
`DELAYED` + sparse intraday: sub-day aggregates are outside the entitlement.

**Follow-up run (same day, Phase M1 smoke, ~02:52 UTC+05:30):** AAPL 1D 30-day
returned `status: "OK"` — not `DELAYED` — with a full series. Both status
values have now been observed from this account; classification therefore
follows the vendor's per-response status field rather than a fixed plan label.
The M1 gate still refused `4h` (`unsupported_timeframe`) and NIFTY 50
(`unsupported_symbol`) without vendor traffic.

**Consequence for the product:** the chart defaults to `DEFAULT_TIMEFRAME =
"4h"` and analysis defaults to `timeframe` on intraday windows — **the default
product path requests exactly the data class the current plan cannot serve.**
Requests return `200` with near-empty candle arrays (a valid empty window per
the contract), so no error surfaces — the chart is honest but empty, and the
status strip reports `connected` once any request answers. Connectivity ≠
coverage.

## 3. Coverage matrix — catalog instrument × UI timeframe

UI timeframes (`TIMEFRAMES` in `constants/markets.ts`): `1m 5m 15m 1h 4h 1D
1W 1M`. Canonical set also includes `3m 30m 2h 6h 12h` — same per-class story.

Legend: **✓v** verified real data · **◇** inferred same-path (not directly
fetched) · **∅** reachable-but-no-data (entitlement) · **✗** unsupported in
code · **?** unverified

| Instrument | Segment | Ticker served | 1m–4h (intraday) | 1D | 1W | 1M |
|---|---|---|---|---|---|---|
| BTCUSDT | crypto | `X:BTCUSD` | ∅ fragments (1h→1 bar, 5m→20-bar fragment) | ✓v 30/30d | ✓v 9/60d | ◇ same endpoint class |
| ETHUSDT | crypto | `X:ETHUSD` | ∅ inferred (same crypto feed) | ? not fetched | ? | ? |
| XAUUSD | commodities | `C:XAUUSD` | ∅ 2 bars/30d | ✓v 26/30d | ◇ | ◇ |
| EURUSD | forex | `C:EURUSD` | ∅ inferred | ✓v 26/30d | ◇ | ◇ |
| GBPUSD | forex | `C:GBPUSD` | ∅ inferred | ? | ? | ? |
| NAS100 | indices | `I:NDX` | ∅ inferred (indices intraday = separate plan entitlement) | ✓v 23/30d | ◇ | ◇ |
| AAPL | us-stocks | `AAPL` | ∅ 1h→2 bars, 5m→28-bar fragment | ✓v 22/30d | ◇ | ◇ |
| NIFTY 50 | indian-markets | — | ✗ code-blocked | ✗ code-blocked | ✗ | ✗ |

Precise states:
- **Verified real-provider support:** daily/weekly for BTCUSD, XAUUSD, EURUSD,
  I:NDX, AAPL — delayed EOD (~1 day stale).
- **Configured but data effectively unavailable:** all intraday timeframes on
  every tested class — provider answers 200/OK with fragments.
- **Provider reachable but symbol unsupported:** none observed by request —
  NIFTY 50 is blocked client-side in `supports()`; Polygon has no NSE feed.
- **Provider not configured:** no other provider exists. India coverage is
  structurally absent, not merely unconfigured.
- **Delayed vs live:** all verified data is `DELAYED` and ≈EOD-stale.
  **Nothing on this platform is live or streaming.**

## 4. Contract & surface gaps found

1. **`CandlesResult.classification` is the literal `"historical"`**
   (`types/domain/market.ts:272`, set in `candles-service.ts:202`). There is no
   way to label Polygon's `DELAYED` payload as *delayed-EOD* — a real
   provenance gap given the smoke test.
2. **Entitlement vs empty-window ambiguity.** A plan-limited intraday request
   returns `ok` with near-zero bars — indistinguishable from a legitimately
   empty window. `DataQualityReport.missingBarCount`/`coveragePct` catches it
   numerically, but nothing surfaces "this instrument class is outside the
   plan" as a first-class state.
3. **`supports()` only encodes mapping, not entitlement.** Polygon `supports`
   answers "true" for 4h/AAPL even though the plan serves no such data —
   `unsupported_symbol` vs `data_not_available` is the wrong axis for a
   plan-boundary failure.
4. **Session calendars are coarse** — `weekdayUtc` for all non-crypto; no
   per-exchange sessions/holidays (NSE 09:15–15:30 IST exists as
   `sessionWindowUtc` factory but unused). Gap classification will
   mislabel exchange-holiday closures as `unexpected` until real calendars land.
5. **USDT→USD quote normalization is one-way documented** — served ticker is
   recorded in `warnings`/`servedTicker`, good; but the catalog presents
   `BTCUSDT` while the feed is `X:BTCUSD` (price bases differ by the USDT/USD
   basis — usually negligible, but it is a documented approximation, not
   identity).
6. **Scanner/analysis degrade silently on sparse data** — empty/sparse cells
   become `skipped` reasons; honest, but "provider returned no candles" vs
   "plan doesn't cover intraday" collapse into the same message.

## 5. Summary

- The plumbing is solid: honest empty/failure distinction, quality reports,
  passive health, PIT-safe analysis, server-side secrets — all verified in code.
- The **data itself is the gap**: EOD-delayed-only entitlement + zero Indian
  coverage. The chart's default `4h` timeframe is currently unserveable.
- NIFTY 50 requires a new provider — no Polygon plan carries NSE.
- No claims of live/streaming data can be made anywhere in the product today.
