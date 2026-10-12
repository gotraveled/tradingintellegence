import type { Metadata } from "next";
import { PublicPage, PublicSection } from "@/components/marketing/public-page";
import { SITE } from "@/lib/constants";

export const metadata: Metadata = {
  title: "Risk Disclosure",
  description:
    "Trading involves substantial risk of loss. AI Trading Intelligence provides analysis, not advice, and no outcome is guaranteed.",
};

export default function RiskDisclosurePage() {
  return (
    <PublicPage
      eyebrow="Legal"
      title="Risk disclosure"
      description="Please read this carefully before using the platform."
    >
      <PublicSection title="The product">
        <p>
          {SITE.name} is market analysis and trading intelligence software. It detects and organises
          market evidence — structure, liquidity, zones, momentum — and presents it with quality
          scores, context, and historical validation.
        </p>
      </PublicSection>
      <PublicSection title="Not financial advice">
        <p>
          Nothing on this platform is financial, investment, legal, or tax advice. No content is a
          recommendation to buy, sell, or hold any instrument, and none of it considers your
          personal circumstances. Users are solely responsible for their own trading decisions.
        </p>
      </PublicSection>
      <PublicSection title="Analysis, not predictions">
        <p>
          Setups, scores, and alerts describe the quality of evidence at a point in time. They are
          not guaranteed predictions of future price movement. Every setup can fail, and confirmed
          setups fail too — that is why invalidation conditions are published alongside them.
        </p>
      </PublicSection>
      <PublicSection title="Historical performance">
        <p>
          Backtest results — including any demo or illustrative figures — do not guarantee future
          outcomes. Markets change, models are imperfect, and costs, slippage, and liquidity can
          differ materially between simulation and live trading.
        </p>
      </PublicSection>
      <PublicSection title="Substantial risk of loss">
        <p>
          Trading and investing involve substantial risk of loss, including the loss of more than
          your initial investment in leveraged markets. You should only trade with capital you can
          afford to lose, and you should seek independent professional advice if you are unsure
          whether trading is appropriate for you.
        </p>
      </PublicSection>
      <PublicSection title="Your responsibility">
        <p>
          By using the platform you accept that all trading decisions are your own. If the
          platform&apos;s analysis is incomplete, delayed, or incorrect, the responsibility for
          acting on it still rests with you.
        </p>
      </PublicSection>
    </PublicPage>
  );
}
