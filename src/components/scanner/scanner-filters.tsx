import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { ASSET_CLASSES, DEFAULT_TIMEFRAME, SETUP_TYPES, TIMEFRAMES } from "@/lib/constants";
import type { SetupType } from "@/lib/types";

export function ScannerFilters({ defaultSetup }: { defaultSetup?: SetupType }) {
  return (
    <Card>
      <CardHeader
        title="Scan criteria"
        description="Controls are disabled until the analysis engine is connected."
      />
      <CardContent>
        <fieldset disabled className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <legend className="sr-only">Scan criteria</legend>
          <div className="space-y-1.5">
            <Label htmlFor="scan-asset-class">Asset class</Label>
            <Select id="scan-asset-class" defaultValue="all">
              <option value="all">All asset classes</option>
              {ASSET_CLASSES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="scan-timeframe">Timeframe</Label>
            <Select id="scan-timeframe" defaultValue={DEFAULT_TIMEFRAME}>
              {TIMEFRAMES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="scan-setup">Setup type</Label>
            <Select id="scan-setup" defaultValue={defaultSetup ?? "all"}>
              <option value="all">All setup types</option>
              {SETUP_TYPES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="scan-min-score">Minimum confluence</Label>
            <Select id="scan-min-score" defaultValue="60">
              <option value="0">Any</option>
              <option value="40">40+</option>
              <option value="60">60+</option>
              <option value="80">80+</option>
            </Select>
          </div>
          <div className="flex items-end">
            <Button className="w-full">Run scan</Button>
          </div>
        </fieldset>
      </CardContent>
    </Card>
  );
}
