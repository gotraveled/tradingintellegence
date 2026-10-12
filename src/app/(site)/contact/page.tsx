import { Mail } from "lucide-react";
import type { Metadata } from "next";
import { PublicPage, PublicSection } from "@/components/marketing/public-page";

export const metadata: Metadata = {
  title: "Contact",
  description: "Get in touch with the AI Trading Intelligence team.",
};

export default function ContactPage() {
  return (
    <PublicPage
      eyebrow="Contact"
      title="Get in touch"
      description="The product is in early development; contact channels are being formalised."
    >
      <PublicSection title="General enquiries">
        <p>
          <a
            href="mailto:hello@tradingintelligence.example"
            className="inline-flex items-center gap-1.5 text-info hover:underline"
          >
            <Mail className="size-4" aria-hidden="true" />
            hello@tradingintelligence.example
          </a>
        </p>
        <p>
          This is a placeholder address until the company domain and support channels are
          configured.
        </p>
      </PublicSection>
      <PublicSection title="Feedback">
        <p>
          If you have used the platform preview, feedback on the interface, the information
          hierarchy, or which modules matter most to you is genuinely useful at this stage.
        </p>
      </PublicSection>
    </PublicPage>
  );
}
