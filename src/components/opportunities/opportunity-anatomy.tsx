import { FileText, Gauge, History, ListChecks, ShieldAlert, type LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

const SECTIONS: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: ListChecks,
    title: "Evidence",
    description:
      "Each independent piece of evidence, its timeframe, and whether it supports or conflicts with the setup.",
  },
  {
    icon: Gauge,
    title: "Confluence score",
    description:
      "A 0–100 measure of evidence quality and agreement. It is not a probability of profit.",
  },
  {
    icon: History,
    title: "Historical validation",
    description:
      "Sample size, observed hit rate, and reward-to-risk distribution of comparable past setups.",
  },
  {
    icon: ShieldAlert,
    title: "Invalidation",
    description: "The condition that would make the setup no longer valid, stated explicitly.",
  },
  {
    icon: FileText,
    title: "Explanation",
    description: "A plain-language summary of why the setup qualifies, including its weaknesses.",
  },
];

export function OpportunityAnatomy() {
  return (
    <Card>
      <CardHeader
        title="How an opportunity is presented"
        description="Every qualified setup will include the following, so you can judge it yourself."
      />
      <CardContent className="grid gap-px bg-border p-0 sm:grid-cols-2 xl:grid-cols-5">
        {SECTIONS.map(({ icon: Icon, title, description }) => (
          <div key={title} className="space-y-2 bg-surface px-5 py-4">
            <Icon className="size-4 text-info" aria-hidden="true" />
            <p className="text-sm font-medium">{title}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
