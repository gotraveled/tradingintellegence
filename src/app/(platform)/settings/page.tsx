import type { Metadata } from "next";
import { SystemStatusPanel } from "@/components/dashboard/system-status-panel";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/field";
import {
  DEFAULT_TIMEFRAME,
  getNavItem,
  RISK_DISCLAIMER,
  ROUTES,
  TIMEFRAMES,
} from "@/lib/constants";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <PageContainer>
      <PageHeader module={getNavItem(ROUTES.settings)} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Preferences"
            description="Preferences are not persisted until user accounts are introduced."
          />
          <CardContent>
            <fieldset disabled className="space-y-4">
              <legend className="sr-only">Preferences</legend>
              <div className="space-y-1.5">
                <Label htmlFor="pref-theme">Theme</Label>
                <Select id="pref-theme" defaultValue="dark">
                  <option value="dark">Dark</option>
                  <option value="light">Light (coming later)</option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pref-timeframe">Default timeframe</Label>
                <Select id="pref-timeframe" defaultValue={DEFAULT_TIMEFRAME}>
                  {TIMEFRAMES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </Select>
              </div>
            </fieldset>
          </CardContent>
        </Card>
        <SystemStatusPanel />
      </div>
      <Card>
        <CardHeader title="Risk disclosure" />
        <CardContent>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {RISK_DISCLAIMER}
          </p>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
