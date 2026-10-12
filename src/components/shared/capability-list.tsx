import { CircleDashed } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

interface CapabilityListProps {
  title?: string;
  description?: string;
  capabilities: { title: string; description: string }[];
}

/** Lists capabilities that a module will provide in a later phase. */
export function CapabilityList({
  title = "Planned capabilities",
  description = "Not active in this phase. Shown so the module scope is clear.",
  capabilities,
}: CapabilityListProps) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <CardContent className="p-0">
        <ul className="divide-y divide-border">
          {capabilities.map((capability) => (
            <li key={capability.title} className="flex gap-3 px-5 py-3.5">
              <CircleDashed
                className="mt-0.5 size-4 shrink-0 text-subtle-foreground"
                aria-hidden="true"
              />
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{capability.title}</p>
                <p className="text-xs text-muted-foreground">{capability.description}</p>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
