/**
 * Real-provider smoke test — opt-in, env-gated. Runs only when a
 * `POLYGON_API_KEY` is resolvable (env var, or `.env.local` read directly so the
 * value never enters this file). Otherwise every case is skipped — the suite
 * never depends on vendor availability.
 *
 * Purpose: verify Phase M1's capability gate end-to-end against the configured
 * account. Assertions are written against the DECLARED row's behavior under the
 * default inferred-Basic surface:
 *   - intraday timeframe → unsupported_timeframe (entitlement gate)
 *   - daily timeframe    → ok, classified by the provider's own DELAYED status
 *   - indian-markets     → unsupported_symbol without any vendor traffic
 *
 * Record results (date / instrument / timeframe / window / count /
 * classification) in the coverage document when run manually.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createConfiguredProvider } from "../providers";

function envKey(): string | undefined {
  if (process.env.POLYGON_API_KEY) return process.env.POLYGON_API_KEY;
  for (const name of [".env.local", ".env"]) {
    const file = resolve(process.cwd(), name);
    if (!existsSync(file)) continue;
    const line = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith("POLYGON_API_KEY="));
    const value = line?.slice("POLYGON_API_KEY=".length).trim();
    if (value) {
      process.env.POLYGON_API_KEY = value; // register so the bootstrap can build
      return value;
    }
  }
  return undefined;
}

const KEYED = envKey() !== undefined;
const DAY = 86_400_000;
const END = Date.UTC(2026, 9, 15);

describe.skipIf(!KEYED)("Polygon live smoke (configured key, bounded reads)", () => {
  it("intraday is entitlement-gated before any vendor traffic", async () => {
    const provider = createConfiguredProvider();
    expect(provider).toBeDefined();
    const res = await provider!.getCandles({
      asset: { symbol: "AAPL", assetClass: "equities", marketId: "us-stocks" },
      timeframe: "4h",
      start: END - 7 * DAY,
      end: END,
    });
    // Under inferred/declared basic: the declared gate answers 422-equivalent.
    expect(res).toMatchObject({ ok: false, error: { code: "unsupported_timeframe" } });
  });

  it("daily aggregates still serve — classification follows vendor evidence", async () => {
    const provider = createConfiguredProvider();
    const res = await provider!.getCandles({
      asset: { symbol: "AAPL", assetClass: "equities", marketId: "us-stocks" },
      timeframe: "1D",
      start: END - 30 * DAY,
      end: END,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The label tracks the vendor's own status field: DELAYED → "delayed",
      // OK → "historical". Both were observed on 2026-10-16 (DELAYED in the
      // discovery pass; OK in this run) — the contract is evidence, not config.
      expect(["delayed", "historical"]).toContain(res.result.classification);
      expect(res.result.candles.length).toBeGreaterThan(0);
    }
  });

  it("indian-markets is refused at the routing layer", async () => {
    const provider = createConfiguredProvider();
    const res = await provider!.getCandles({
      asset: { symbol: "NIFTY 50", assetClass: "indices", marketId: "indian-markets" },
      timeframe: "1D",
      start: END - 30 * DAY,
      end: END,
    });
    expect(res).toMatchObject({ ok: false, error: { code: "unsupported_symbol" } });
  });
});
