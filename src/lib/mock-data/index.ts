/**
 * This is development/demo data and must be replaced by the market intelligence API.
 *
 * Shaped like the eventual API responses so service boundaries stay identical when real data
 * arrives. Prices, scores, timestamps, and regimes are invented and must never be presented
 * without a visible "Demo" label. Only `src/lib/services/*` may import this module
 * (enforced by ESLint).
 */
export { DEMO_ALERT_EVENTS, DEMO_ALERTS } from "./alerts";
export { DEMO_ANALYSIS } from "./analysis";
export { DEMO_OPPORTUNITIES } from "./opportunities";
export { DEMO_MARKET_REGIMES } from "./regimes";
export { DEMO_BACKTEST_RESULT, DEMO_STRATEGIES } from "./strategies";
export { DEMO_WATCHLIST } from "./watchlist";
