import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ConnectionBadge } from "@/components/ui/status";
import { getSystemStatus } from "@/lib/services/system-status";

export function SystemStatusPanel() {
  const services = getSystemStatus();

  return (
    <Card>
      <CardHeader
        title="System status"
        description="Platform dependencies and their current state."
      />
      <CardContent className="p-0">
        <ul className="divide-y divide-border">
          {services.map((service) => (
            <li key={service.id} className="flex items-center justify-between gap-4 px-5 py-3.5">
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-medium">{service.name}</p>
                <p className="truncate text-xs text-muted-foreground">{service.description}</p>
              </div>
              <ConnectionBadge status={service.status} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
