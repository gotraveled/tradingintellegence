import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EVIDENCE_CATEGORIES } from "@/lib/constants";

export function EvidenceFrameworkPanel() {
  return (
    <Card>
      <CardHeader
        title="Evidence framework"
        description="Independent evidence categories that an opportunity will be assessed against."
      />
      <CardContent className="grid gap-px bg-border p-0 sm:grid-cols-2 xl:grid-cols-3">
        {EVIDENCE_CATEGORIES.map((category) => {
          const Icon = category.icon;
          return (
            <div key={category.id} className="space-y-2 bg-surface px-5 py-4">
              <div className="flex items-center gap-2">
                <Icon className="size-4 text-info" aria-hidden="true" />
                <p className="text-sm font-medium">{category.label}</p>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {category.description}
              </p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
