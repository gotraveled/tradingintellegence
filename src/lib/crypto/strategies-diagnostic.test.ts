import { describe, it, expect } from "vitest";
import { STRATEGIES } from "./strategies";
import { atr } from "./analysis";
import type { Candle } from "@/lib/types";

/** Test every strategy against real BTC 5m data to see which produce signals. */
describe("all strategies on live BTC data", () => {
  it("each strategy either produces a signal or logs why not", async () => {
    const res = await fetch(
      "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=500",
    );
    expect(res.ok).toBe(true);
    const raw = (await res.json()) as number[][];
    const candles: Candle[] = raw.map((c) => ({
      time: c[0],
      open: parseFloat(String(c[1])),
      high: parseFloat(String(c[2])),
      low: parseFloat(String(c[3])),
      close: parseFloat(String(c[4])),
      volume: parseFloat(String(c[5])),
    }));
    const closed = candles.slice(0, -1);
    console.log(`\nBTC 5m: ${closed.length} closed bars, last close ${closed[closed.length - 1].close}`);
    console.log(`ATR(14): ${(atr(closed, 14) || 0).toFixed(2)}\n`);

    for (const d of STRATEGIES) {
      try {
        const fn = d.create();
        const sig = fn(closed);
        if (sig === undefined) {
          console.log(`  ${d.id.padEnd(18)} → no setup`);
        } else {
          const risk = Math.abs((sig.entry ?? NaN) - (sig.stopLoss ?? NaN));
          const gate = 0.5 * (sig.entry ?? 0) * 0.0015;
          const gateOk = risk >= gate;
          console.log(
            `  ${d.id.padEnd(18)} → ${sig.direction} ${sig.confidence}pts` +
            ` | entry ${sig.entry ?? "?"} stop ${sig.stopLoss ?? "?"}` +
            ` | risk $${risk.toFixed(0)} ${gateOk ? "✓" : "✗ gate"}` +
            ` | ${sig.reasons?.[0]?.slice(0, 60) ?? ""}`
          );
        }
      } catch (e) {
        console.log(`  ${d.id.padEnd(18)} → THREW: ${(e as Error).message.slice(0, 50)}`);
      }
    }

    // Replay the FULL tape: count how many bars each strategy fired on.
    // Stateful strategies (ORB's one-per-day) use a fresh factory per run.
    console.log("\nFull-tape signal counts (every bar replayed):");
    for (const d of STRATEGIES) {
      const fn = d.create();
      let fires = 0;
      let errors = 0;
      for (let i = 40; i < closed.length; i += 1) {
        try {
          const s = fn(closed.slice(0, i + 1));
          if (s !== undefined && s.direction !== "wait" && s.entry !== undefined) fires += 1;
        } catch {
          errors += 1;
        }
      }
      console.log(`  ${d.id.padEnd(18)} → ${fires} signals${errors > 0 ? ` (${errors} errors)` : ""}`);
    }
    expect(closed.length).toBeGreaterThan(40);
  });
});
