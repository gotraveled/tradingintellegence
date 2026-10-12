import type { Metadata } from "next";
import { PublicPage, PublicSection } from "@/components/marketing/public-page";
import { SITE } from "@/lib/constants";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How AI Trading Intelligence handles data while in development.",
};

export default function PrivacyPolicyPage() {
  return (
    <PublicPage
      eyebrow="Legal"
      title="Privacy policy"
      description="This is a baseline policy for the development phase and will be expanded before launch."
    >
      <PublicSection title="Scope">
        <p>
          {SITE.name} is currently in development. There are no user accounts and the platform does
          not collect personal information, market preferences, or trading activity.
        </p>
      </PublicSection>
      <PublicSection title="Data stored on your device">
        <p>
          Watchlists and alert rules you create are held in your browser session only and are not
          transmitted to or stored on our servers. Preferences such as theme may be stored locally
          in your browser.
        </p>
      </PublicSection>
      <PublicSection title="Analytics and third parties">
        <p>
          We do not currently run advertising or analytics trackers. When accounts, payments, or
          market-data integrations are added in later phases, this policy will be updated to
          describe what is collected, why, and how to exercise your rights.
        </p>
      </PublicSection>
      <PublicSection title="Contact">
        <p>Questions about this policy can be sent through the contact page.</p>
      </PublicSection>
    </PublicPage>
  );
}
