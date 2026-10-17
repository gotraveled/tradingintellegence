/**
 * Optional OCR runtime — EVALUATION-ONLY, never wired into the analysis route.
 *
 * tesseract.js is loaded via dynamic import: if the package is not installed
 * the result is `available: false` and every existing path is unaffected.
 * Nothing here runs unless a caller explicitly invokes `runLocalOcr` — the
 * production route does not call it.
 *
 * Offline note: tesseract.js downloads `eng.traineddata` from a CDN on first
 * use unless `langPath` points at a local copy (OCR_LANG_PATH env or option)
 * with `cacheMethod: "none"`. First-time use therefore performs exactly one
 * documented network fetch; supplying a local traineddata makes it fully
 * offline. See the benchmark report for measured behavior.
 */
import type { OcrWord } from "./ocr";

export interface OcrRuntimeResult {
  available: boolean;
  words: OcrWord[];
  elapsedMs: number;
  reason?: string;
}

export interface OcrRunOptions {
  /** Local directory containing eng.traineddata — enables fully offline runs. */
  langPath?: string;
  /** Soft timeout in ms; on expiry the run reports unavailable. */
  timeoutMs?: number;
}

interface TesseractWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
}

interface TesseractWorker {
  recognize: (
    image: Buffer,
    options?: Record<string, unknown>,
    output?: { blocks?: boolean },
  ) => Promise<{
    data: {
      text?: string;
      blocks?: { paragraphs?: { lines?: { words?: TesseractWord[] }[] }[] }[];
    };
  }>;
  terminate: () => Promise<void>;
}

/** Resolve the optional package — undefined when not installed. */
async function loadEngine(): Promise<{ createWorker: (langs: string[], oem: number, opts: { langPath?: string; cacheMethod: string }) => Promise<TesseractWorker> } | undefined> {
  try {
    // Optional peer: absent by design in production installs. Non-literal
    // specifier keeps tsc/vite from statically resolving or bundling it.
    const pkg = "tesseract.js";
    const mod = await import(/* webpackIgnore: true */ pkg);
    return mod as unknown as { createWorker: (l: string[], o: number, opts: { langPath?: string; cacheMethod: string }) => Promise<TesseractWorker> };
  } catch {
    return undefined;
  }
}

export async function isOcrAvailable(): Promise<boolean> {
  return (await loadEngine()) !== undefined;
}

/**
 * Run OCR on an image buffer. Returns structured words with pixel bboxes.
 * `available:false` covers: engine not installed, worker failure, timeout.
 */
export async function runLocalOcr(image: Buffer, opts: OcrRunOptions = {}): Promise<OcrRuntimeResult> {
  const engine = await loadEngine();
  if (!engine) return { available: false, words: [], elapsedMs: 0, reason: "tesseract.js not installed (optional evaluation dependency)" };

  const timeout = opts.timeoutMs ?? 20000;
  const langPath = opts.langPath ?? process.env.OCR_LANG_PATH;
  let worker: TesseractWorker | undefined;
  const started = Date.now();
  try {
    const work = (async () => {
      worker = await engine.createWorker(["eng"], 1, {
        langPath,
        cacheMethod: langPath ? "none" : "refresh",
      });
      // v7: positional output is opt-in; words arrive nested blocks→paragraphs→lines.
      return worker.recognize(image, {}, { blocks: true });
    })();
    const res = await Promise.race([
      work,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("ocr timeout")), timeout)),
    ]);
    const words: OcrWord[] = (res.data.blocks ?? [])
      .flatMap((b) => b.paragraphs ?? [])
      .flatMap((p) => p.lines ?? [])
      .flatMap((l) => l.words ?? [])
      .filter((w) => typeof w.text === "string" && w.text.trim().length > 0)
      .map((w) => ({ text: w.text.trim(), bbox: w.bbox, confidence: w.confidence }));
    return { available: true, words, elapsedMs: Date.now() - started };
  } catch (e) {
    return { available: false, words: [], elapsedMs: Date.now() - started, reason: `ocr run failed: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    await worker?.terminate().catch(() => undefined);
  }
}
