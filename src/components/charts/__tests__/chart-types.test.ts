import { describe, expect, it } from "vitest";
import type { AnalysisSnapshot, BacktestOpportunity } from "@/lib/types";
import {
  selectChartOverlays,
  selectTradePlanView,
  toChartOverlays,
  type OverlayLayer,
} from "../chart-types";

const ALL_LAYERS: Record<OverlayLayer, boolean> = {
  structure: true,
  zones: true,
  liquidity: true,
  imbalance: true,
};

/** Minimal snapshot carrying one zone, one liquidity event, one structure level. */
const SNAPSHOT = {
  symbol: "BTCUSDT",
  timeframe: "4h",
  zones: {
    data: [
      {
        id: "z1",
        type: "demand",
        timeframe: "1D",
        upperPrice: 60400,
        lowerPrice: 59800,
      },
    ],
  },
  liquidity: {
    data: [{ id: "l1", side: "sell_side", price: 60200 }],
  },
  structure: {
    data: {
      lastBreak: { type: "BOS", direction: "bearish", price: 61400 },
      keyLevels: [{ label: "Protected high", price: 64900 }],
    },
  },
} as unknown as AnalysisSnapshot;

const LIVE_OPPORTUNITY = {
  setupId: "live-1",
  direction: "bearish",
  plan: { entry: 61300, stopLoss: 61700, targets: [{ price: 60000 }] },
} as unknown as BacktestOpportunity;

const LIVE_NO_PLAN = {
  setupId: "live-2",
  direction: "bullish",
  plan: undefined,
} as unknown as BacktestOpportunity;

describe("selectChartOverlays — live replaces reference, never merges", () => {
  it("without a live result, returns layer-filtered snapshot overlays", () => {
    const overlays = selectChartOverlays(undefined, SNAPSHOT, ALL_LAYERS);
    expect(overlays).toEqual(toChartOverlays(SNAPSHOT));
    expect(overlays.length).toBeGreaterThan(0);
  });

  it("respects layer toggles only on the snapshot path", () => {
    const overlays = selectChartOverlays(undefined, SNAPSHOT, {
      ...ALL_LAYERS,
      zones: false,
    });
    expect(overlays.some((o) => o.layer === "zones")).toBe(false);
  });

  it("a matching live opportunity replaces every snapshot overlay", () => {
    const overlays = selectChartOverlays([LIVE_OPPORTUNITY], SNAPSHOT, ALL_LAYERS);
    const demoIds = new Set(toChartOverlays(SNAPSHOT).map((o) => o.id));
    expect(overlays.length).toBeGreaterThan(0);
    for (const overlay of overlays) {
      expect(demoIds.has(overlay.id)).toBe(false);
      expect(overlay.label).toMatch(/^Engine /);
    }
  });

  it("a live verdict with no qualifying setup yields an empty canvas — demo cannot resurface", () => {
    expect(selectChartOverlays([], SNAPSHOT, ALL_LAYERS)).toEqual([]);
  });

  it("a live opportunity without plan fields draws nothing — no fabricated levels", () => {
    expect(selectChartOverlays([LIVE_NO_PLAN], SNAPSHOT, ALL_LAYERS)).toEqual([]);
  });

  it("uses only the top-ranked live opportunity", () => {
    const second = { ...LIVE_OPPORTUNITY, setupId: "live-9", plan: { entry: 1 } };
    const overlays = selectChartOverlays(
      [LIVE_OPPORTUNITY, second] as BacktestOpportunity[],
      SNAPSHOT,
      ALL_LAYERS,
    );
    expect(overlays.every((o) => o.id.startsWith("live-1-"))).toBe(true);
  });

  it("no snapshot and no live result means no overlays", () => {
    expect(selectChartOverlays(undefined, undefined, ALL_LAYERS)).toEqual([]);
  });
});

describe("selectTradePlanView — demo placeholder can never pose as a verdict", () => {
  it("pre-analysis with a snapshot plan → preview (expanded, demo-labeled)", () => {
    expect(selectTradePlanView(true, false)).toBe("preview");
  });

  it("pre-analysis without a snapshot plan → empty — no fabricated developing state", () => {
    expect(selectTradePlanView(false, false)).toBe("empty");
  });

  it("any live result subordinates the snapshot plan to a collapsed reference", () => {
    // Covers no-opportunity, developing-only, and real-opportunity verdicts alike —
    // the panel keys on the result existing, not on what it found.
    expect(selectTradePlanView(true, true)).toBe("reference");
  });

  it("live result without a snapshot plan → no_plan, never fabricated levels", () => {
    expect(selectTradePlanView(false, true)).toBe("no_plan");
  });
});
