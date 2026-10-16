# Market Data Provider Evaluation

Status: evaluation record — sources checked **2026-10-16**.
Method: official docs/pricing pages and first-party policy pages where found;
third-party reviews marked as such. Pricing and licensing change — re-verify
before purchase. Facts vs assumptions are separated in §6.

Product requirements being evaluated against: **Indian indices & equities
(NSE)** · US equities · crypto · intraday + daily history · eventual streaming ·
fundamentals (nice-to-have) · **commercial display on a public website** ·
reliability · total cost.

---

## 1. Polygon.io (rebranded **Massive**, Oct 30 2025)

- **Coverage:** US stocks, options, indices (`I:`), currencies product =
  forex+crypto combined; **no NSE/Indian coverage**. Futures added May 2026
  (CME group venues).
- **Plans (self-serve):**
  - Stocks: Basic $0 (EOD, 5 calls/min) · Starter $29 (15-min delayed) ·
    Developer $79 · Advanced $199 (real-time, WS).
  - Currencies (forex+crypto): Basic $0 (**EOD only**, 5 calls/min, 2yr) ·
    Starter $49 (**real-time**, unlimited calls, WS, 10+yr). Currencies has no
    professional/non-professional split.
  - Indices: Basic $0 (limited tickers, EOD, 5/min) · Starter $49 (15-min
    delayed) · Advanced $99 (real-time).
  - Business/redistribution tiers are sales-quoted, not self-serve.
- **Licensing:** self-serve plans are **individual/non-professional use**;
  redistribution needs a separate agreement. Stocks/indices plans require
  non-professional status.
- **Evidence:** docs + live smoke test — configured key returns
  `status: "DELAYED"`, daily/weekly OK, intraday sparse/absent → consistent
  with a Basic-tier key.
- Sources: https://polygon.io/pricing (redirects to massive.com),
  https://tradingdatacompare.com/providers/polygon-io/ (3rd-party),
  https://aifinhub.io/articles/polygon-io-futures-forex-api-2026/ (3rd-party,
  cites massive.com pricing re-read 2026-10-11),
  https://cryptomarkets.tools/tools/polygon-io-crypto (3rd-party).
  Checked 2026-10-16.

## 2. Dhan (DhanHQ API — SEBI-registered broker)

- **Coverage:** NSE/BSE/MCX equities, F&O, indices; daily from inception +
  intraday 1/5/15/25/60-min up to **5 years**; ≤90 days per intraday call.
- **Cost:** trading APIs free; **Data API ₹499 + GST/mo** (real-time feed,
  historical intraday, depth, option chain). ~10 req/s, 5000 orders/day on the
  published card.
- **Licensing:** broker API — account + token required; **redistribution terms
  not published** in public docs; almost certainly personal/account-bound use
  (same class as Kite's policy). Treat public display as **not granted** until
  Dhan confirms in writing.
- Sources: https://dhanhq.co/docs/v2/historical-data/,
  https://dhanhq.co/trading-apis, https://dhan.co/support/platforms/dhanhq-api/.
  Checked 2026-10-16.

## 3. Upstox Developer API

- **Coverage:** NSE/BSE/MCX; Historical Candle V3 — minutes 1–300 (history from
  **Jan 2022**), hours 1–5, days/weeks/months (from Jan 2000); retrieval caps
  (≤1 month per call for ≤15-min bars, 1 quarter for >15-min, 1 decade daily).
  Intraday endpoint = current day only. Expired-instrument history on the paid
  "Plus" plan.
- **Cost:** **free** (trading + data APIs; Plus tier exists for expired
  contracts).
- **Licensing:** OAuth tied to an Upstox account; docs don't publish
  redistribution rights — same caution as Dhan.
- Sources: https://upstox.com/developer/api-documentation/v3/get-historical-candle-data,
  https://upstox.com/trading-api/,
  https://upstox.com/developer/api-documentation/backtesting.
  Checked 2026-10-16.

## 4. Zerodha Kite Connect

- **Coverage:** NSE/BSE/MCX + NFO/CDS; historical intervals
  minute/3/5/10/15/30/60-minute + day (no native week/month — aggregate
  client-side); `continuous=1` for expired futures.
- **Cost:** **₹500/mo per API key** (includes WS live data + history); free
  "Personal" tier has **no data**. Free for startups via Rainmatter.
- **Licensing — explicit:** *"live market data obtained via Kite Connect cannot
  be displayed to the public at large"*, no derivative redistribution, no
  scraping into redistributed databases; FAQ: "Displaying or redistributing
  Kite Connect API data on external platforms violates exchange data vending
  policies… contact an exchange-authorised data vendor." **Disqualified for
  public display** of NSE data.
- Sources: https://kite.trade/terms/,
  https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/kite-connect-api-faqs,
  https://kite.trade/docs/connect/v3/historical/. Checked 2026-10-16.

## 5. Exchange-authorized Indian channels

- **NSE Data & Analytics** (ex-DotEx) is the canonical source — real-time
  multicast feed over leased line, or via authorized vendors. Data Usage &
  Sharing Policy governs commercial use; EOD/delayed/historical products exist
  with separate pricing.
- **Authorized RT vendors** (NSE list): TrueData, GDFL (Global Datafeeds),
  Tickerplant, Spider, Refinitiv, Xignite, TradingView, etc.
- **TrueData** — authorized vendor for NSE/BSE/MCX; API for real-time + chart
  data; **explicit:** redistribution/public website display requires exchange +
  vendor approval — i.e., *possible, but licensed*.
- **GDFL** — explicit: "APIs available here are only for Individual Users for
  Personal Use. For Commercial Use, you will need to sign agreement with
  respective Exchanges and pay them the requisite fees."
- Sources: https://www.nseindia.com/static/market-data/nse-data-policy,
  https://www.nseindia.com/static/market-data/real-time-data-subscription,
  https://archives.nseindia.com/content/press/List_data_Vendors.pdf,
  https://www.truedata.in/market-data-apis,
  https://globaldatafeeds.in/global-datafeeds-apis/global-datafeeds-apis/pricing-sales/who-can-purchase/.
  Checked 2026-10-16.

## 6. Other credible vendors

- **Twelve Data** — NSE listed (Level A, Grow $29/mo individual; **EOD delay**
  for NSE); 70+ markets; Business plans required for commercial display
  (Venture $149/mo+; redistribution = separate agreement; "price data for
  regions outside the US requires additional approval for commercial use").
  Cheap legal-ish path to NSE equities *EOD* — but NSE indices (NIFTY) vs
  equities coverage needs direct verification.
  Sources: https://twelvedata.com/pricing, https://support.twelvedata.com/en/articles/5332349,
  https://support.twelvedata.com/en/articles/5735131. Checked 2026-10-16.
- **Finnhub / Alpha Vantage / Tiingo** — not deeply evaluated; none advertise
  NSE-authorized redistribution. Assumption, not verified.
- **Yahoo Finance** — unofficial endpoints cover `^NSEI`; **no license** for
  commercial/public redistribution — excluded as a foundation (mention only as
  dev-time sanity data).

## 7. Evaluation vs product requirements

| Requirement | Polygon/Massive | Dhan | Upstox | Kite | TrueData/GDFL | Twelve Data |
|---|---|---|---|---|---|---|
| NSE/NIFTY | ✗ | ✓ | ✓ | ✓ | ✓ | ~ (equities EOD; index TBD) |
| US equities | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Crypto | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Intraday history | ✓ paid | ✓ 5y | ✓ from 2022 | ✓ | ✓ | ✓ |
| Streaming | ✓ paid | ✓ WS | ✓ WS | ✓ WS | ✓ | ✓ WS |
| Fundamentals | ✓ paid | ✗ | ✗ | ✗ | ✗ | ✓ |
| Public/website display | needs business contract | **not granted** | **not granted** | **explicitly forbidden** | licensable via exchange agreement | needs Business + non-US approval |
| Self-serve cost | $0–199/mo per asset class | ₹499/mo | free | ₹500/mo | contract | $0–$149+ |

## 8. Recommendation

**Two-track provider strategy; India is the differentiator.**

1. **Keep Polygon as the non-India provider; upgrade deliberately.** Today's
   Basic key proves plumbing end-to-end but only serves delayed EOD. The chart
   defaults to 4h — either the plan moves to Stocks/Currencies/Indices Starter
   (~$29+49+49/mo for 15-min-delayed intraday) or the product honestly presents
   "delayed end-of-day" coverage until upgraded.
2. **India track is a licensing problem first, an API problem second.**
   Broker APIs (Dhan/Upstox/Kite) are cheap and technically sufficient, but
   their terms do not grant public redistribution — Kite says so explicitly.
   For a public website, the lawful path is an **NSE-authorized vendor
   (TrueData/GDFL/Tickerplant) or NSE Data & Analytics direct**, with an
   exchange-level display agreement. For internal-only operation (no public
   display), a broker API is viable immediately.
3. **Launch sequencing:** the existing US/crypto/FX coverage can ship first as
   *delayed historical analysis* (honest labels) while India licensing is
   negotiated; do not block the platform on NSE entitlement. If India-first is
   the business goal, budget exchange/vendor licensing from day one — there is
   no cheap legal shortcut.
4. **Decisions needed (open questions for the business):**
   - Is this deployment public-facing (website) or personal/internal?
   - Which entitlement level for Polygon (Basic vs Starter per asset class)?
   - NSE route: authorized vendor (fastest legal public path) vs broker API
     (internal only) vs Twelve Data Business (EOD-only but off-the-shelf)?
