# Chart Analyst — Optional Local OCR Benchmark (measured results)

**Status:** evaluation only. OCR is NOT wired into the analysis route; this
document reports measured evidence for a decision on an opt-in suggestion path.

**Date:** 2026-10-16 · **Engine:** tesseract.js 7.0.0 (devDependency, benchmark-only)
**Run:** `OCR_BENCHMARK=1 npx vitest run src/lib/chart-analysis/__tests__/ocr-benchmark.test.ts`

## 1. Engine evaluation

| Criterion | Finding |
|---|---|
| License | tesseract.js Apache-2.0; core tesseract Apache-2.0 — permissive, commercial-safe |
| Runtime | Node (worker_threads) and browser builds exist; we used Node via dynamic `import()` — fully optional |
| Language data | `eng.traineddata` (~13 MB) downloaded once from tessdata CDN on first use when `cacheMethod:"refresh"`; **one documented network fetch**. Point `OCR_LANG_PATH` (or `langPath` opt) at a local file + `cacheMethod:"none"` for fully-offline operation |
| Package size | ~1.35 MB (`tesseract.js`) + WASM core; model data separate as above |
| Speed | ~1.2–1.6 s per 640×400 image including worker startup (measured; first run adds the one-time fetch) |
| Memory | one wasm worker per call, terminated after each run; no leak observed in 10-image loop |
| Offline after setup | Yes, with local `eng.traineddata` |
| Can be fully disabled | Yes — package absent → `runLocalOcr` returns `available:false`; production route never calls it |

**v7 API note (found during benchmark):** `recognize()` returns `data.text`
always but positional output is opt-in — `recognize(img, {}, { blocks:true })`
yields `blocks→paragraphs→lines→words`. Flat `data.words`/`data.lines` are not
populated in v7. A default `Invalid resolution 25 dpi` warning is emitted for
DPI-less PNGs (cosmetic).

## 2. Fixture inventory (all synthetic, `ocr-fixtures.ts`)

10 sharp-rendered images, 640×400, ground-truth label text + bbox + value.
Synthetic fixtures validate pipeline mechanics; they do NOT represent all real
charts (real fonts, anti-aliasing, themes, JPEG artifacts differ).

| id | category | labels | notes |
|---|---|---|---|
| dark-right-ints | clean | 4 | "25,000" grouped ints, dark bg, right axis |
| light-left-decimals | clean | 4 | "1.2550" 4-decimals, light bg, left axis |
| small-font-12 | clean | 4 | 12px — legibility floor |
| euro-decimal-comma | difficult | 4 | "1.250,00" both separators |
| negatives-and-currency | difficult | 3 | "$50.00"/"0.00"/"-50.00" |
| faint-low-contrast | difficult | 3 | ~3:1 contrast |
| cropped-edge | difficult | 3 | bottom label clipped by canvas |
| slanted-8deg | difficult | 0 usable | 8° rotated labels — expected to fail |
| legend-decoys | false-positive | 3 + 3 decoys | "BTC/USD", "Volume 1.2M", "14:32" |
| no-axis | no-axis | 0 | candles only |

## 3. Measured results

Overall: 28 expected labels, **22 exact matches (78.6%)**, 6 missed,
3 false-positive strays, 1 parse error, mean position error ~2.3 px,
mean runtime ~1.4 s/image.

| category | fixtures | expected | exact-match | missed | stray | parse errors |
|---|---|---|---|---|---|---|
| clean | 3 | 12 | 9 (75%) | 3 | 0 | 0 |
| difficult | 5 | 13 | 11 (84.6%) | 2 | 2 | 1 |
| false-positive | 1 | 3 | 3 (100%) | 0 | 0 | 0 |
| no-axis | 1 | 0 | — | 0 | 0 | 0 |

**Decoys:** "BTC/USD"/"Volume 1.2M"/"14:32" produced zero strip pairings —
decoys are outside the axis strip or non-numeric, so they became stray or were
ignored. No false label was ever accepted as a tick.

**Calibration:** suggested anchors fitted a scale on 4 fixtures with max
truth error 0.018%–0.45% (all linear, exactly as drawn). Non-fixture-relevant
finding: "negatives-and-currency" suggested 3 anchors but `fitAxisCalibration`
refused — it rejects non-positive prices by design (log-scale constraint);
suggestion ≠ calibration acceptance, which is correct layered safety.

**Dominant failure mode:** comma-grouped integers ("25,000") are correctly
read by OCR but flagged *ambiguous* by parsing (could be EU decimal 25.000) —
all 4 anchors dropped → suggestion rejected. This is the conservative rule
working; it also means the single most common axis format needs either a
user-side convention confirm or a collection-consistency heuristic.

## 4. Proposed acceptance thresholds (post-measurement)

- ≥2 anchors, confidence ≥60, coverage ≥60% of detected ticks, strictly
  decreasing — unchanged from implementation (validated by benchmark).
- Ambiguous separator forms stay excluded; a *collection-consistency* upgrade
  (all labels uniformly `/\d{1,3}(,\d{3})+$/` → US grouping) could add them as
  **"ambiguous — needs user confirm"**, never auto-accept.
- Single anchor, contradictions, corrected glyphs alone → reject/downgrade.

## 5. Privacy/offline verification

- All processing local; benchmark ran offline after the first traineddata
  fetch (verified: worker load + recognize on cached data).
- No persistence, no telemetry, no third-party upload. Engine call is opt-in
  only; absent package = `available:false`, zero behavior change.
- `npm audit`: 5 high-severity findings predate this work (`braces`/
  `micromatch` via `eslint-config-next`) — tesseract.js contributed none.

## 6. Validation

- `tsc --noEmit`: 0 errors · `vitest`: 95 chart-analysis tests pass
  (34 new OCR unit tests; benchmark env-gated) · eslint: clean · `next build`: pass.
- Defect fixed during implementation: parallel-edit corruption in
  `ocr-runtime.ts` / `ocr-fixtures.ts` (repaired, re-verified).

## 7. Recommendation

**Retain as an opt-in suggestion tool — do not auto-integrate.** Evidence:
78.6% exact-label accuracy on synthetic fixtures, sub-1% calibration error
when accepted, honest rejection on hard/absent cases, decoys never promoted.
Limits: 10-fixture sample is small; 12px font and low-contrast degrade;
comma-grouped integers need a convention decision. A separately-approved
integration could surface anchors as *suggestions for user confirmation* —
manual calibration stays the default and the fallback.
