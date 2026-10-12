import { describe, expect, it } from "vitest";
import type {
  Bias,
  Candle,
  MarketStructure,
  LiquidityConfig,
  Momentum,
  MomentumConfig,
  MTFConfig,
  MtfAlignmentState,
  MtfVote,
  Timeframe,
} from "@/lib/types";
import {
  alignFrames,
  barCloseTime,
  causalAlignAt,
  causalFramesAt,
  classifyVotes,
  closedIndexAt,
  createMultiTimeframeEngine,
  voteOf,
  type FrameSnapshot,
  type FrameSource,
} from "../mtf";
import { momentumStateAt } from "../momentum";
import { imbalanceStateAt } from "../imbalances";
import { liquidityStateAt } from "../liquidity";
import { FIXTURE_EPOCH as E } from "@/lib/market-data";

const H1 = 3_600_000;

const CFG: MTFConfig = {
  set: { htf: "4h", itf: "1h", etf: "15m" },
  weights: { htf: 0.5, itf: 0.3, etf: 0.2 },
};

const MOM_CFG: MomentumConfig = {
  lookback: 10,
  atrLength: 14,
  trendShift: 20,
  vol: { fast: 5, slow: 20 },
  state: { strengthMoveAtr: 1.5, strengthBodyAtr: 0.6, weakenFactor: 0.7, biasMoveAtr: 0.5 },
  disp: {
    bars: 3,
    threshold: 60,
    weights: { body: 0.2, range: 0.15, close: 0.15, dir: 0.15, move: 0.15, vol: 0.05, struct: 0.15 },
  },
};

const FVG_CFG = { atrLength: 5, minGapAtr: 0.15, minMidBodyAtr: 0.3, partialFillPct: 50, invalidateAtr: 0.1, expiryBars: 200 };

const LIQ_CFG: LiquidityConfig = {
  equalToleranceAtr: 0.25,
  clusterMinCount: 2,
  clusterWidthAtr: 0.5,
  poolExpiryBars: 100,
  sweep: { minPenetrationAtr: 0.1, maxReclaimBars: 3, displacementBars: 3, displacementBodyAtr: 0.3, displacementRangeAtr: 0.5 },
  break: { minCloseAtr: 0.1, holdBars: 2, retestWindow: 5 },
  range: { lookbackBars: 60 },
};

const ms = (bias: Bias, tf: Timeframe = "1h", updatedAt = E): MarketStructure => ({
  symbol: "T",
  timeframe: tf,
  trend: bias === "bullish" ? "uptrend" : bias === "bearish" ? "downtrend" : "range",
  bias,
  swings: [],
  updatedAt: new Date(updatedAt).toISOString(),
});
const mom = (bias: Bias): Momentum => ({ state: "neutral", bias });
const frame = (tf: Timeframe, sBias: Bias, mBias: Bias = "neutral") => ({
  timeframe: tf,
  structure: ms(sBias, tf),
  momentum: mom(mBias),
});

const c = (o: number, h: number, l: number, cl: number, i: number, tf = H1): Candle => ({
  time: E + i * tf,
  open: o,
  high: h,
  low: l,
  close: cl,
});

const align = (h: Bias, i: Bias, e: Bias) =>
  alignFrames("T", { htf: frame("4h", h), itf: frame("1h", i), etf: frame("15m", e) }, CFG.weights)
    .alignment;

describe("truth table — 27 vote combos", () => {
  const cases: [MtfVote, MtfVote, MtfVote, MtfAlignmentState][] = [
    [1, 1, 1, "aligned_bull"], [1, 1, 0, "aligned_bull"], [1, 1, -1, "pullback_in_trend_bull"],
    [-1, -1, -1, "aligned_bear"], [-1, -1, 0, "aligned_bear"], [-1, -1, 1, "pullback_in_trend_bear"],
    [1, -1, 1, "realigning_bull"], [1, -1, 0, "countertrend_bear"], [1, -1, -1, "countertrend_bear"],
    [-1, 1, -1, "realigning_bear"], [-1, 1, 0, "countertrend_bull"], [-1, 1, 1, "countertrend_bull"],
    [1, 0, 1, "htf_dominant"], [1, 0, 0, "htf_dominant"], [1, 0, -1, "htf_dominant"],
    [-1, 0, 1, "htf_dominant"], [-1, 0, 0, "htf_dominant"], [-1, 0, -1, "htf_dominant"],
    [0, 1, 1, "ltf_directed"], [0, 1, 0, "ltf_directed"], [0, 1, -1, "ltf_directed"],
    [0, -1, 1, "ltf_directed"], [0, -1, 0, "ltf_directed"], [0, -1, -1, "ltf_directed"],
    [0, 0, 1, "no_context"], [0, 0, -1, "no_context"], [0, 0, 0, "neutral"],
  ];
  it.each(cases)("votes (%i, %i, %i) → %s", (h, i, e, expected) => {
    expect(classifyVotes(h, i, e)).toBe(expected);
  });
});

describe("votes + alignment", () => {
  it("aligned_bull — score = 1.0, sources recorded", () => {
    const a = align("bullish", "bullish", "bullish");
    expect(a.state).toBe("aligned_bull");
    expect(a.votes).toEqual({ htf: 1, itf: 1, etf: 1 });
    expect(a.alignmentScore).toBeCloseTo(1.0);
    expect(a.sources).toEqual({ htf: "structure", itf: "structure", etf: "structure" });
  });

  it("realigning_bull — the spec example (+,−,+) is a watch state, never a bias", () => {
    const a = align("bullish", "bearish", "bullish");
    expect(a.state).toBe("realigning_bull");
    expect(a.alignmentScore).toBeCloseTo(0.5 - 0.3 + 0.2); // 0.4 — capped context
  });

  it("pullback_in_trend_bull — (+,+,−)", () => {
    const a = align("bullish", "bullish", "bearish");
    expect(a.state).toBe("pullback_in_trend_bull");
    expect(a.alignmentScore).toBeCloseTo(0.5 + 0.3 - 0.2);
  });

  it("countertrend_bull — full disagreement (−,+,+)", () => {
    const a = align("bearish", "bullish", "bullish");
    expect(a.state).toBe("countertrend_bull");
    expect(a.alignmentScore).toBeCloseTo(-0.5 + 0.3 + 0.2);
  });

  it("momentum supplies the vote only when structure is neutral — source recorded", () => {
    const { vote, source } = voteOf(ms("neutral"), mom("bullish"));
    expect(vote).toBe(1);
    expect(source).toBe("momentum");
    expect(voteOf(ms("bearish"), mom("bullish")).source).toBe("structure");
    expect(voteOf(ms("neutral"), mom("neutral"))).toEqual({ vote: 0, source: "none" });
  });

  it("missing/insufficient frame data is explicit — never fabricated", () => {
    const a = align("neutral", "bearish", "neutral");
    expect(a.state).toBe("ltf_directed");
    expect(a.votes.htf).toBe(0);
  });

  it("computedAt is deterministic — latest upstream updatedAt", () => {
    const later = frame("4h", "bullish");
    later.structure.updatedAt = new Date(E + 5 * H1).toISOString();
    const { alignment } = alignFrames("T", { htf: later, itf: frame("1h", "bullish"), etf: frame("15m", "bullish") }, CFG.weights);
    expect(alignment.computedAt).toBe(new Date(E + 5 * H1).toISOString());
  });
});

describe("temporal join — HTF candle-close protection", () => {
  // 1h bars at E, E+1h, E+2h: bar 0 closes E+1h, bar 1 closes E+2h, bar 2 closes E+3h.
  const htf = [c(10, 10.5, 9.5, 10.2, 0), c(10.2, 11, 10, 10.8, 1), c(10.8, 11.5, 10.5, 11.2, 2)];

  it("barCloseTime — fixed timeframe adds duration", () => {
    expect(barCloseTime(htf[0], "1h")).toBe(E + H1);
    expect(barCloseTime(htf[1], "1h")).toBe(E + 2 * H1);
  });

  it("1M — calendar close at the next UTC month start (Feb ≠ 30 days)", () => {
    const feb = { time: Date.UTC(2024, 1, 1), open: 1, high: 1, low: 1, close: 1 };
    expect(barCloseTime(feb, "1M")).toBe(Date.UTC(2024, 2, 1)); // Feb 2024 → Mar 1, not +30d
    const jan = { time: Date.UTC(2024, 0, 1), open: 1, high: 1, low: 1, close: 1 };
    expect(barCloseTime(jan, "1M")).toBe(Date.UTC(2024, 1, 1));
  });

  it("a still-forming HTF bar is invisible; it appears at its close", () => {
    expect(closedIndexAt(htf, "1h", E + H1 + 30 * 60_000)).toBe(0); // mid bar 1 — only bar 0 closed
    expect(closedIndexAt(htf, "1h", E + 2 * H1)).toBe(1); // bar 1 closes exactly at asOf → visible
    expect(closedIndexAt(htf, "1h", E + 2 * H1 - 1)).toBe(0); // one ms earlier — still forming
    expect(closedIndexAt(htf, "1h", E + 30 * 60_000)).toBe(-1); // before first close
  });

  it("temporal join is monotonic — later asOf never returns an earlier index", () => {
    const seq = [E + H1 / 2, E + H1, E + 1.5 * H1, E + 2 * H1, E + 3 * H1];
    const idx = seq.map((t) => closedIndexAt(htf, "1h", t));
    for (let k = 1; k < idx.length; k += 1) expect(idx[k]).toBeGreaterThanOrEqual(idx[k - 1]);
  });
});

describe("causality — real primitive snapshots at the joined index", () => {
  // 1h HTF candles where a bullish FVG forms at bar 7 and momentum builds.
  const flat = (n: number, from: number, at = 10) =>
    Array.from({ length: n }, (_, k) => c(at, at + 0.5, at - 0.5, at, from + k));
  const htfCandles = [
    ...flat(5, 0),
    c(10, 10.5, 9.5, 10, 5),
    c(10.2, 11.6, 10.0, 11.5, 6),
    c(11.3, 11.8, 10.9, 11.4, 7), // C candle — FVG knowable at 7h close
    ...flat(8, 8, 11.4),
  ];

  it("HTF FVG formed mid-bar is invisible until that bar closes", () => {
    const asOfForming = E + 7 * H1 + 45 * 60_000; // 15m into bar 7's hour — still forming
    const idxForming = closedIndexAt(htfCandles, "1h", asOfForming);
    expect(idxForming).toBe(6); // bar 7 excluded
    expect(imbalanceStateAt(htfCandles.slice(0, idxForming + 1), "T", "1h", FVG_CFG, "v1", idxForming)).toHaveLength(0);
    const idxClosed = closedIndexAt(htfCandles, "1h", E + 8 * H1);
    expect(imbalanceStateAt(htfCandles.slice(0, idxClosed + 1), "T", "1h", FVG_CFG, "v1", idxClosed)).toHaveLength(1);
  });

  it("HTF momentum at a mid-bar timestamp uses closed bars only", () => {
    const forming = momentumStateAt(htfCandles, "T", "1h", MOM_CFG, "v1", 7);
    const asOf = E + 7 * H1 + 30 * 60_000; // bar 7 still forming
    const idx = closedIndexAt(htfCandles, "1h", asOf);
    const causal = momentumStateAt(htfCandles.slice(0, idx + 1), "T", "1h", MOM_CFG, "v1", idx);
    expect(idx).toBe(6);
    expect(JSON.stringify(causal)).toBe(JSON.stringify(momentumStateAt(htfCandles.slice(0, 7), "T", "1h", MOM_CFG, "v1", 6)));
    // the forming bar IS different if wrongly included
    expect(JSON.stringify(causal)).not.toBe(JSON.stringify(forming));
  });

  it("snapshot equality — align from stateAt snapshots equals truncated-series pipeline", () => {
    const asOf = E + 7 * H1 + 30 * 60_000;
    const idx = closedIndexAt(htfCandles, "1h", asOf);
    const sliceMomentum = momentumStateAt(htfCandles, "T", "1h", MOM_CFG, "v1", idx);
    const prefixMomentum = momentumStateAt(htfCandles.slice(0, idx + 1), "T", "1h", MOM_CFG, "v1", idx);
    expect(JSON.stringify(sliceMomentum)).toBe(JSON.stringify(prefixMomentum));
  });
});

describe("canonical causal join — causalFramesAt", () => {
  const flat = (n: number, from: number, at = 10) =>
    Array.from({ length: n }, (_, k) => c(at, at + 0.5, at - 0.5, at, from + k));
  const htfCandles = [...flat(5, 0), c(10, 10.5, 9.5, 10, 5), c(10.2, 11.6, 10, 11.5, 6), c(11.3, 11.8, 10.9, 11.4, 7)];
  const src = (candles: Candle[], timeframe: Timeframe, snap: (i: number) => FrameSnapshot | null): FrameSource =>
    ({ timeframe, candles, at: snap });
  const momSrc = (candles: Candle[], timeframe: Timeframe): FrameSource =>
    src(candles, timeframe, (i) => ({ momentum: momentumStateAt(candles, "T", timeframe, MOM_CFG, "v1", i) }));

  it("boundary ±1ms — bar visible only once closed", () => {
    const close = barCloseTime(htfCandles[2], "1h"); // E + 3h
    const roles = { htf: momSrc(htfCandles, "1h"), itf: momSrc(htfCandles, "1h"), etf: momSrc(htfCandles, "1h") };
    expect(causalFramesAt(roles, close - 1).htf?.barIndex).toBe(1); // 1ms before close — forming
    expect(causalFramesAt(roles, close).htf?.barIndex).toBe(2);     // exact close — visible
    expect(causalFramesAt(roles, close + 1).htf?.barIndex).toBe(2); // after close — visible
  });

  it("no closed bar → frame is null, never fabricated", () => {
    const roles = { htf: momSrc(htfCandles, "1h"), itf: momSrc(htfCandles, "1h"), etf: momSrc(htfCandles, "1h") };
    const joined = causalFramesAt(roles, E + 30 * 60_000); // first bar closes at E+1h
    expect(joined.htf).toBeNull();
    expect(causalAlignAt("T", roles, CFG.weights, E + 30 * 60_000).alignment.state).toBe("neutral");
    expect(causalAlignAt("T", roles, CFG.weights, E + 30 * 60_000).diagnostics.framesAvailable).toBe(0);
  });

  it("forming-bar FVG and liquidity cannot leak into the joined frame", () => {
    const joined = causalFramesAt(
      {
        htf: src(htfCandles, "1h", (i) => ({
          imbalances: imbalanceStateAt(htfCandles, "T", "1h", FVG_CFG, "v1", i),
          liquidity: liquidityStateAt(htfCandles, ms("bullish"), "T", "1h", LIQ_CFG, "v1", i),
          momentum: momentumStateAt(htfCandles, "T", "1h", MOM_CFG, "v1", i),
        })),
        itf: momSrc(htfCandles, "1h"),
        etf: momSrc(htfCandles, "1h"),
      },
      E + 7 * H1 + 45 * 60_000, // bar 7 (the FVG C candle) still forming
    );
    expect(joined.htf?.barIndex).toBe(6);
    expect(joined.htf?.snapshot.imbalances).toHaveLength(0); // FVG at bar 7 not yet knowable
    const after = causalFramesAt(
      { htf: src(htfCandles, "1h", (i) => ({ imbalances: imbalanceStateAt(htfCandles, "T", "1h", FVG_CFG, "v1", i) })), itf: momSrc(htfCandles, "1h"), etf: momSrc(htfCandles, "1h") },
      E + 8 * H1,
    );
    expect(after.htf?.snapshot.imbalances).toHaveLength(1); // knowable once bar 7 closes
  });

  it("historical equivalence — full replay == prefix replay == stateAt(T)", () => {
    const asOf = E + 6 * H1 + 30 * 60_000;
    const roles = { htf: momSrc(htfCandles, "1h"), itf: momSrc(htfCandles, "1h"), etf: momSrc(htfCandles, "1h") };
    const full = causalAlignAt("T", roles, CFG.weights, asOf).alignment;
    const idx = closedIndexAt(htfCandles, "1h", asOf);
    const truncated = { ...roles, htf: momSrc(htfCandles.slice(0, idx + 1), "1h") };
    const prefix = causalAlignAt("T", truncated, CFG.weights, asOf).alignment;
    expect(JSON.stringify(full)).toBe(JSON.stringify(prefix));
    // truncation — removing future candles changes nothing at T
    const cut = { ...roles, htf: momSrc(htfCandles.slice(0, idx + 1), "1h") };
    expect(JSON.stringify(causalAlignAt("T", cut, CFG.weights, asOf).alignment)).toBe(JSON.stringify(full));
  });

  it("1M calendar — Dec→Jan, Jan→Feb, Feb-leap→Mar, Feb-nonleap→Mar", () => {
    const m = (y: number, mo: number): Candle => ({ time: Date.UTC(y, mo, 1), open: 1, high: 1, low: 1, close: 1 });
    expect(barCloseTime(m(2024, 0), "1M")).toBe(Date.UTC(2024, 1, 1));  // Jan → Feb
    expect(barCloseTime(m(2024, 1), "1M")).toBe(Date.UTC(2024, 2, 1));  // Feb 2024 leap → Mar
    expect(barCloseTime(m(2023, 1), "1M")).toBe(Date.UTC(2023, 2, 1));  // Feb 2023 → Mar
    expect(barCloseTime(m(2024, 11), "1M")).toBe(Date.UTC(2025, 0, 1)); // Dec → Jan
    const monthly = [m(2024, 0), m(2024, 1)];
    // mid-February: Jan bar closed, Feb bar still forming (28/29 days — never fixed ms)
    expect(closedIndexAt(monthly, "1M", Date.UTC(2024, 1, 15))).toBe(0);
    expect(closedIndexAt(monthly, "1M", Date.UTC(2024, 2, 1))).toBe(1);
    expect(closedIndexAt(monthly, "1M", Date.UTC(2024, 2, 1) - 1)).toBe(0); // 1ms before Mar 1
  });

  it("deterministic — identical inputs give identical alignment", () => {
    const asOf = E + 6 * H1;
    const mk = () => ({ htf: momSrc(htfCandles, "1h"), itf: momSrc(htfCandles, "1h"), etf: momSrc(htfCandles, "1h") });
    expect(JSON.stringify(causalAlignAt("T", mk(), CFG.weights, asOf))).toBe(JSON.stringify(causalAlignAt("T", mk(), CFG.weights, asOf)));
  });
});

describe("engine contract + determinism", () => {
  it("analyze — ok, data, no events (snapshot model), diagnostics", () => {
    const res = createMultiTimeframeEngine().align({
      symbol: "T",
      frames: { htf: frame("4h", "bullish"), itf: frame("1h", "bearish"), etf: frame("15m", "bullish") },
      config: CFG,
    });
    expect(res.ok).toBe(true);
    expect(res.data?.state).toBe("realigning_bull");
    expect(res.meta.stage).toBe("mtf");
    expect(res.meta.events).toHaveLength(0); // snapshot model — recomputed, never eventful
    expect(res.meta.diagnostics?.state).toBe("realigning_bull");
  });

  it("invalid config — weights must sum to 1 and set must match frames", () => {
    const engine = createMultiTimeframeEngine();
    const frames = { htf: frame("4h", "bullish"), itf: frame("1h", "bullish"), etf: frame("15m", "bullish") };
    expect(engine.align({ symbol: "T", frames, config: { ...CFG, weights: { htf: 0.5, itf: 0.5, etf: 0.5 } } }).ok).toBe(false);
    expect(engine.align({ symbol: "T", frames, config: { ...CFG, set: { htf: "1D", itf: "1h", etf: "15m" } } }).ok).toBe(false);
  });

  it("deterministic — identical frames give identical alignment", () => {
    const mk = () => ({ htf: frame("4h", "bullish"), itf: frame("1h", "neutral"), etf: frame("15m", "bearish") });
    const a = createMultiTimeframeEngine().align({ symbol: "T", frames: mk(), config: CFG });
    const b = createMultiTimeframeEngine().align({ symbol: "T", frames: mk(), config: CFG });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
