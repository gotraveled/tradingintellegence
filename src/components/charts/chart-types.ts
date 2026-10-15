import type {
  AnalysisSnapshot,
  BacktestOpportunity,
  BacktestPlan,
  Candle,
  Direction,
  Price,
  Timeframe,
  ZoneType,
} from "@/lib/types";

export type OverlayLayer = "structure" | "zones" | "liquidity" | "imbalance";

/**
 * Library-agnostic overlay primitives. The chart implementation translates these into its own
 * drawing API (price lines, rectangles, markers), so the page never depends on a chart library.
 */
export type ChartOverlay =
  | {
      kind: "zone";
      id: string;
      layer: OverlayLayer;
      zoneType: ZoneType;
      upper: Price;
      lower: Price;
      label: string;
    }
  | {
      kind: "level";
      id: string;
      layer: OverlayLayer;
      price: Price;
      label: string;
      direction?: Direction;
    };

/** Props contract every chart implementation must satisfy. */
export interface PriceChartProps {
  symbol: string;
  timeframe: Timeframe;
  candles?: Candle[];
  overlays?: ChartOverlay[];
  chartStyle?: "candles" | "line";
  pricePrecision?: number;
  className?: string;
  /** Imperative handle for view controls (fit/zoom) once the chart exists. */
  onChartReady?: (handle: import("./candlestick-chart").CandlestickChartHandle | undefined) => void;
}

/** Maps a domain analysis snapshot into chart overlays. */
export function toChartOverlays(snapshot: AnalysisSnapshot | undefined): ChartOverlay[] {
  if (!snapshot) return [];
  const overlays: ChartOverlay[] = [];

  for (const zone of snapshot.zones.data) {
    overlays.push({
      kind: "zone",
      id: zone.id,
      layer: "zones",
      zoneType: zone.type,
      upper: zone.upperPrice,
      lower: zone.lowerPrice,
      label: `${zone.timeframe} ${zone.type}`,
    });
  }

  for (const event of snapshot.liquidity.data) {
    overlays.push({
      kind: "level",
      id: event.id,
      layer: "liquidity",
      price: event.price,
      label: event.side === "buy_side" ? "Buy-side liquidity" : "Sell-side liquidity",
    });
  }

  const lastBreak = snapshot.structure.data.lastBreak;
  if (lastBreak) {
    overlays.push({
      kind: "level",
      id: `${snapshot.symbol}-last-break`,
      layer: "structure",
      price: lastBreak.price,
      label: `${lastBreak.type} (${lastBreak.direction})`,
      direction: lastBreak.direction,
    });
  }

  for (const level of snapshot.structure.data.keyLevels ?? []) {
    overlays.push({
      kind: "level",
      id: `${snapshot.symbol}-${level.label}`,
      layer: "structure",
      price: level.price,
      label: level.label,
    });
  }

  return overlays;
}

/**
 * Live engine overlays — the matched `BacktestOpportunity.plan` projected onto the
 * chart as labeled price lines. The "Engine" prefix distinguishes these from demo
 * snapshot overlays: entry/stop draw on the structure layer, targets alongside.
 * Missing plan fields simply produce no line — levels are never fabricated.
 */
export function toChartPlanOverlays(
  setupId: string,
  direction: Direction | undefined,
  plan: BacktestPlan | undefined,
): ChartOverlay[] {
  if (!plan) return [];
  const overlays: ChartOverlay[] = [];
  const level = (id: string, price: number | undefined, label: string) => {
    if (price === undefined) return;
    overlays.push({
      kind: "level",
      id: `${setupId}-${id}`,
      layer: "structure",
      price,
      label,
      direction,
    });
  };
  level("entry", plan.entry, "Engine entry");
  level("stop", plan.stopLoss, "Engine stop");
  (plan.targets ?? []).forEach((target, index) => {
    if (target.price === undefined) return;
    overlays.push({
      kind: "level",
      id: `${setupId}-target-${index}`,
      layer: "structure",
      price: target.price,
      label: `Engine ${target.label ?? `target ${index + 1}`}`,
      direction,
    });
  });
  return overlays;
}

/**
 * Overlay source-of-truth for the chart: once an engine analysis of the current
 * selection exists (`live` is the scoped opportunity list — possibly empty), it
 * REPLACES the reference-snapshot overlays outright. A live result with no
 * qualifying setup yields no overlays — demo levels must never resurface as
 * corroboration beside a real verdict, and missing plan fields draw nothing.
 * Only the snapshot path is layer-filtered; engine overlays are the analysis
 * result itself and are not user-toggleable decoration.
 */
export function selectChartOverlays(
  live: readonly BacktestOpportunity[] | undefined,
  snapshot: AnalysisSnapshot | undefined,
  layers: Record<OverlayLayer, boolean>,
): ChartOverlay[] {
  if (live !== undefined) {
    const top = live[0];
    return top ? toChartPlanOverlays(top.setupId, top.direction, top.plan) : [];
  }
  return toChartOverlays(snapshot).filter((overlay) => layers[overlay.layer]);
}

/**
 * Standalone trade-plan panel states. The panel has exactly one truthful source
 * of levels — a precomputed snapshot — so it can only ever be preview or
 * reference content; it must never synthesize a "developing" verdict before the
 * engine has run, and once the engine has spoken it defers behind a disclosure.
 *
 * - `preview`   — no live result, snapshot plan exists: expanded, demo-labeled.
 * - `empty`     — no live result, nothing to preview: honest "run Analyze" state.
 * - `reference` — live result exists, snapshot plan exists: collapsed disclosure.
 * - `no_plan`   — live result exists, no snapshot plan: honest note, no levels.
 */
export type TradePlanView = "preview" | "empty" | "reference" | "no_plan";

export function selectTradePlanView(
  hasSnapshotPlan: boolean,
  hasLiveResult: boolean,
): TradePlanView {
  if (hasLiveResult) return hasSnapshotPlan ? "reference" : "no_plan";
  return hasSnapshotPlan ? "preview" : "empty";
}
