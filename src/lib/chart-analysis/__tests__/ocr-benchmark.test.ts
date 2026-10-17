/**
 * OCR benchmark — REAL measurement harness, gated behind OCR_BENCHMARK=1.
 *
 * Skipped entirely in normal runs: it only executes when the optional
 * tesseract.js package is installed AND the env flag is set. Every metric
 * printed here is measured from actual OCR output on the synthetic fixtures —
 * nothing is fabricated. Fixtures are synthetic (see ocr-fixtures.ts), so
 * results bound the pipeline's mechanics, not universal real-world accuracy.
 *
 * Run: `OCR_BENCHMARK=1 npx vitest run src/lib/chart-analysis/__tests__/ocr-benchmark.test.ts`
 */
import { describe, expect, it } from "vitest";
import { OCR_FIXTURES } from "../ocr-fixtures";
import { pairWordsToTicks, evaluateSuggestion } from "../ocr";
import { isOcrAvailable, runLocalOcr } from "../ocr-runtime";
import { analyzeChartImage } from "../image-metrics";
import { fitAxisCalibration } from "../axis-calibration";

const RUN = process.env.OCR_BENCHMARK === "1";

interface FixtureResult {
  id: string;
  category: string;
  elapsedMs: number;
  expectedLabels: number;
  matched: number;
  missed: number;
  parseErrors: number;
  stray: number;
  meanPositionErrorPx: number;
  suggestion: string;
  calibrated: boolean;
  maxCalibrationErrorPct?: number;
  words: number;
}

(RUN ? describe : describe.skip)("OCR benchmark — measured, synthetic fixtures", () => {
  it("runs the full fixture set and reports measured metrics", async () => {
    const engine = await isOcrAvailable();
    if (!engine) {
      console.log("OCR_BENCHMARK: tesseract.js not installed — no measurements taken.");
      return;
    }

    const results: FixtureResult[] = [];
    for (const fx of OCR_FIXTURES) {
      const png = await fx.render();
      const metrics = await analyzeChartImage(png);
      const stripW = Math.min(110, Math.floor(metrics.width * 0.14));
      const strip =
        metrics.axis.side === "left"
          ? { x0: 0, x1: stripW }
          : { x0: metrics.width - stripW, x1: metrics.width };
      const ocr = await runLocalOcr(png, { timeoutMs: 30000 });
      if (!ocr.available) {
        results.push({ id: fx.id, category: fx.category, elapsedMs: ocr.elapsedMs, expectedLabels: fx.labels.length, matched: 0, missed: fx.labels.length, parseErrors: 0, stray: 0, meanPositionErrorPx: 0, suggestion: "engine-unavailable", calibrated: false, words: 0 });
        continue;
      }
      const ticks = metrics.axis.ticks;
      const { pairs, stray } = pairWordsToTicks(ocr.words, ticks, strip, 16);
      const suggestion = evaluateSuggestion(pairs, ticks.length, stray.length);

      // Match pairs back to ground truth: correct value AND position.
      let matched = 0;
      let parseErrors = 0;
      let posErr = 0;
      let posErrN = 0;
      const used = new Set<number>();
      for (const p of pairs) {
        const expected = fx.labels.find((l, i) => {
          if (used.has(i)) return false;
          const cy = (l.bbox.y0 + l.bbox.y1) / 2;
          return Math.abs(cy - p.rowY) <= 16;
        });
        if (!expected) {
          parseErrors += 1; // paired to a tick row with no truth label
          continue;
        }
        used.add(fx.labels.indexOf(expected));
        const cy = (expected.bbox.y0 + expected.bbox.y1) / 2;
        posErr += Math.abs(cy - p.rowY);
        posErrN += 1;
        if (expected.value !== undefined && Math.abs((p.token.value ?? NaN) - expected.value) <= Math.max(0.001, Math.abs(expected.value) * 1e-4)) {
          matched += 1;
        } else {
          parseErrors += 1;
        }
      }
      const missed = fx.labels.length - matched - 0;

      // Calibration: when suggested, fit a scale and measure truth error.
      let calibrated = false;
      let maxCalErr: number | undefined;
      if (suggestion.status === "suggested" && suggestion.anchors.length >= 2) {
        const cal = fitAxisCalibration(
          suggestion.anchors.map((a) => ({ row: a.rowY, price: a.price })),
          { prefer: "auto", source: "detected-ticks" },
        );
        if (cal.rowToPrice) {
          calibrated = true;
          maxCalErr = 0;
          for (const l of fx.labels) {
            if (l.value === undefined) continue;
            const cy = (l.bbox.y0 + l.bbox.y1) / 2;
            const est = cal.rowToPrice(cy);
            if (est !== undefined) {
              maxCalErr = Math.max(maxCalErr, Math.abs((est - l.value) / l.value) * 100);
            }
          }
        }
      }

      results.push({
        id: fx.id, category: fx.category, elapsedMs: ocr.elapsedMs,
        expectedLabels: fx.labels.length, matched, missed, parseErrors,
        stray: stray.length, meanPositionErrorPx: posErrN > 0 ? posErr / posErrN : 0,
        suggestion: suggestion.status, calibrated, maxCalibrationErrorPct: maxCalErr, words: ocr.words.length,
      });
    }

    // ---- aggregate + emit measured report ----
    const byCat = (c: string) => results.filter((r) => r.category === c);
    const agg = (rs: FixtureResult[]) => {
      const exp = rs.reduce((s, r) => s + r.expectedLabels, 0);
      const mat = rs.reduce((s, r) => s + r.matched, 0);
      return {
        fixtures: rs.length,
        expectedLabels: exp,
        exactMatchRate: exp > 0 ? +(mat / exp).toFixed(3) : 0,
        missed: rs.reduce((s, r) => s + r.missed, 0),
        falsePositives: rs.reduce((s, r) => s + r.stray, 0),
        parseErrors: rs.reduce((s, r) => s + r.parseErrors, 0),
        meanPositionErrorPx: rs.length ? +(rs.reduce((s, r) => s + r.meanPositionErrorPx, 0) / rs.length).toFixed(1) : 0,
        meanElapsedMs: rs.length ? Math.round(rs.reduce((s, r) => s + r.elapsedMs, 0) / rs.length) : 0,
      };
    };
    const report = {
      sampleSize: results.length,
      overall: agg(results),
      byCategory: Object.fromEntries(["clean", "difficult", "false-positive", "no-axis"].map((c) => [c, agg(byCat(c))])),
      perFixture: results,
    };
    console.log("\n=== OCR BENCHMARK RESULTS (measured) ===");
    console.log(JSON.stringify(report, null, 1));
    console.log("=== END ===\n");

    // Hard guarantees regardless of accuracy:
    const noAxis = results.find((r) => r.id === "no-axis")!;
    expect(noAxis.suggestion === "rejected" || noAxis.matched === 0).toBe(true);
    const slanted = results.find((r) => r.id === "slanted-8deg")!;
    expect(slanted.suggestion).not.toBe("suggested"); // no truth ticks → cannot calibrate
  }, 300000);
});
