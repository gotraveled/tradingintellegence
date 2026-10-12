export const SITE = {
  name: "AI Trading Intelligence",
  shortName: "ATI",
  tagline: "See the market before the move",
  description:
    "Identify high-quality reversals, breakouts and trend continuations using market structure, liquidity, price action and historical intelligence.",
} as const;

export const RISK_DISCLAIMER =
  "AI Trading Intelligence is an analytical tool. It does not provide financial advice, and no analysis, score, or historical result guarantees future outcomes. Trading involves substantial risk of loss.";

export const RISK_DISCLAIMER_SHORT =
  "Analysis only. Not financial advice. No outcome is guaranteed.";

/** Public marketing/content pages. `/markets` is the platform's public Markets overview. */
export const PUBLIC_ROUTES = {
  home: "/",
  about: "/about",
  features: "/features",
  markets: "/markets",
  methodology: "/methodology",
  pricing: "/pricing",
  riskDisclosure: "/risk-disclosure",
  privacyPolicy: "/privacy-policy",
  terms: "/terms",
  contact: "/contact",
} as const;
