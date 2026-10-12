import type { Metadata } from "next";
import { PublicPage, PublicSection } from "@/components/marketing/public-page";
import { SITE } from "@/lib/constants";

export const metadata: Metadata = {
  title: "Terms of Use",
  description: "Terms governing use of the AI Trading Intelligence platform.",
};

export default function TermsPage() {
  return (
    <PublicPage
      eyebrow="Legal"
      title="Terms of use"
      description="Baseline terms for the development phase; these will be expanded before launch."
    >
      <PublicSection title="The service">
        <p>
          {SITE.name} provides market analysis and trading intelligence software. It is provided
          &quot;as is&quot; while in development, and features may be incomplete, change, or be
          removed without notice.
        </p>
      </PublicSection>
      <PublicSection title="Acceptable use">
        <p>
          You may not scrape, resell, or redistribute the platform&#39;s content, attempt to disrupt
          the service, or misrepresent analysis as a guarantee of future performance.
        </p>
      </PublicSection>
      <PublicSection title="No advice; no warranty">
        <p>
          The platform does not provide financial advice and makes no warranty that its analysis is
          accurate, complete, or timely. To the fullest extent permitted by law, {SITE.name} is not
          liable for trading losses or decisions made using the platform. See the risk disclosure.
        </p>
      </PublicSection>
      <PublicSection title="Demo data">
        <p>
          Content labelled &ldquo;Demo&rdquo; is illustrative development data and does not reflect
          real market conditions.
        </p>
      </PublicSection>
      <PublicSection title="Changes">
        <p>
          These terms may be updated as the product evolves. Continued use after a change
          constitutes acceptance.
        </p>
      </PublicSection>
    </PublicPage>
  );
}
