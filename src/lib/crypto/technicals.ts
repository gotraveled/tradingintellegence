import type { Candle, Direction, Timeframe, TrendState } from "@/lib/types";
import { analyzeImbalances } from "@/lib/engines/imbalances";
import { analyzeLiquidity } from "@/lib/engines/liquidity";
import { analyzeStructure } from "@/lib/engines/structure";
import { detectSwings } from "@/lib/engines/swing";
import { defaultConfig } from "@/lib/services/engine-defaults";

/**
 * Pro-analysis context — the same ICT/SMC engine suite used elsewhere in the
 * platform (specs 02–08), distilled for the live crypto chart. Everything
 * here is causal: swings confirm only after `rightBars`, sweeps only after
 * reclaim, FVGs only on a complete triplet — no look-ahead, ever.
 *
 * This is EVIDENCE, displayed beside the signal engine's confluence score;
 * it does not itself veto or force trades.
 */

export interface TechnicalBreak {
  type: "BOS" | "CHOCH";
  direction: Direction;
  price: number;
  at: string;
  failed: boolean;
}

export interface TechnicalPool {
  side: "buy_side" | "sell_side";
  price: number;
  strength: number;
  touches: number;
  status: string;
}

export interface TechnicalSweep {
  /** Which side's liquidity was taken — sell-side sweep often precedes a long. */
  side: "buy_side" | "sell_side";
  level: number;
  at: string;
}

export interface TechnicalFvg {
  direction: Direction;
  lower: number;
  upper: number;
  status: string;
}

export interface TechnicalContext {
  /** Engine-classified market structure. */
  trend: TrendState;
  lastBreak?: TechnicalBreak;
  /** Recent confirmed liquidity sweeps, newest first (max 3). */
  sweeps: TechnicalSweep[];
  /** Resting liquidity above/below last price — where stops likely sit. */
  poolsAbove: TechnicalPool[];
  poolsBelow: TechnicalPool[];
  /** Open/partially-filled fair value gaps near price (max 3, nearest first). */
  fvgs: TechnicalFvg[];
  /** One-line human reads, e.g. "CHOCH bearish at 82,100 — last BOS failed". */
  notes: string[];
}

const NEAR_ATR = 2.5;

export function analyzeTechnicals(
  candles: Candle[],
  symbol: string,
  timeframe: Timeframe,
): TechnicalContext | undefined {
  if (candles.length < 60) return undefined;
  const cfg = defaultConfig();
  const version = cfg.version;

  const swings = detectSwings(candles, symbol, timeframe, cfg.swing, version).swings;
  const structure = analyzeStructure(
    candles,
    swings,
    symbol,
    timeframe,
    cfg.structure,
    version,
  );
  const liquidity = analyzeLiquidity(
    candles,
    structure.structure,
    symbol,
    timeframe,
    cfg.liquidity,
    version,
  );
  const imbalances = analyzeImbalances(candles, symbol, timeframe, cfg.fvg, version);

  const price = candles[candles.length - 1].close;
  const atr = meanTr(candles, cfg.swing.atrLength);
  const near = atr * NEAR_ATR;

  const lastBreakRaw = structure.structure.lastBreak;
  const lastBreak: TechnicalBreak | undefined =
    lastBreakRaw === undefined
      ? undefined
      : {
          type: lastBreakRaw.type,
          direction: lastBreakRaw.direction,
          price: lastBreakRaw.refPrice ?? lastBreakRaw.price,
          at: lastBreakRaw.time,
          failed: lastBreakRaw.failed === true,
        };

  const sweeps: TechnicalSweep[] = liquidity.events
    .filter((e) => e.kind === "sweep_confirmed")
    .slice(-3)
    .reverse()
    .map((e) => ({
      side: (e.metadata?.side === "buy_side" ? "buy_side" : "sell_side") as TechnicalSweep["side"],
      level: typeof e.metadata?.level === "number" ? e.metadata.level : 0,
      at: e.at,
    }));

  const poolOf = (side: "buy_side" | "sell_side") =>
    liquidity.pools
      .filter((p) => p.side === side && (p.status === "resting" || p.status === "approaching"))
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
      .slice(0, 3)
      .map((p) => ({
        side: p.side,
        price: p.price,
        strength: Math.round(p.strength),
        touches: p.touches,
        status: p.status,
      }));

  const fvgs: TechnicalFvg[] = imbalances.imbalances
    .filter((f) => f.status === "open" || f.status === "partially_filled")
    .filter((f) => Math.min(Math.abs(f.lowerPrice - price), Math.abs(f.upperPrice - price)) < near)
    .sort(
      (a, b) =>
        Math.min(Math.abs(a.lowerPrice - price), Math.abs(a.upperPrice - price)) -
        Math.min(Math.abs(b.lowerPrice - price), Math.abs(b.upperPrice - price)),
    )
    .slice(0, 3)
    .map((f) => ({
      direction: f.direction,
      lower: f.lowerPrice,
      upper: f.upperPrice,
      status: f.status,
    }));

  const notes: string[] = [];
  notes.push(
    `Structure: ${structure.structure.trend}` +
      (lastBreak
        ? ` — last ${lastBreak.type} ${lastBreak.direction}${lastBreak.failed ? " (failed)" : ""}`
        : ""),
  );
  for (const s of sweeps) {
    notes.push(
      `Sweep: ${s.side === "sell_side" ? "sell-side" : "buy-side"} liquidity taken at ${s.level}`,
    );
  }
  const poolsAbove = poolOf("buy_side");
  const poolsBelow = poolOf("sell_side");
  if (poolsAbove[0] !== undefined) notes.push(`Buy-side liquidity resting at ${poolsAbove[0].price}`);
  if (poolsBelow[0] !== undefined) notes.push(`Sell-side liquidity resting at ${poolsBelow[0].price}`);
  if (fvgs[0] !== undefined) {
    notes.push(
      `Nearest ${fvgs[0].direction} FVG ${fvgs[0].lower}–${fvgs[0].upper} (${fvgs[0].status.replace("_", " ")})`,
    );
  }

  return {
    trend: structure.structure.trend,
    lastBreak,
    sweeps,
    poolsAbove,
    poolsBelow,
    fvgs,
    notes,
  };
}

/** Mean true range over the last `length` bars — matches the engines' ATR. */
function meanTr(candles: readonly Candle[], length: number): number {
  const n = candles.length;
  let sum = 0;
  let cnt = 0;
  for (let i = Math.max(1, n - length); i < n; i += 1) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    cnt += 1;
  }
  return cnt > 0 ? sum / cnt : 0;
}
