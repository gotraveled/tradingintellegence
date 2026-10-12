"use client";

import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/field";
import {
  ASSET_CLASSES,
  MARKET_SEGMENTS,
  OPPORTUNITY_STATUSES,
  SETUP_STATUS_LABEL,
  SETUP_TYPES,
  TIMEFRAMES,
} from "@/lib/constants";
import type { OpportunityFilter } from "@/lib/utils";

const ALL = "all";

const MIN_SCORES = [
  { value: ALL, label: "Any score" },
  { value: "50", label: "50+" },
  { value: "60", label: "60+" },
  { value: "70", label: "70+" },
  { value: "80", label: "80+" },
];

interface ScannerFilterBarProps {
  value: OpportunityFilter;
  /** Filters fixed by the active tab; shown but not editable. */
  locked: OpportunityFilter;
  onChange: (next: OpportunityFilter) => void;
  onReset: () => void;
  canReset: boolean;
}

type FilterKey = keyof OpportunityFilter;

export function ScannerFilterBar({
  value,
  locked,
  onChange,
  onReset,
  canReset,
}: ScannerFilterBarProps) {
  const merged = { ...value, ...locked };

  const set = (key: FilterKey, raw: string) => {
    const next = { ...value };
    if (raw === ALL) {
      delete next[key];
    } else if (key === "minScore") {
      next.minScore = Number(raw);
    } else {
      (next as Record<FilterKey, unknown>)[key] = raw;
    }
    onChange(next);
  };

  const control = (
    key: FilterKey,
    label: string,
    options: { value: string; label: string }[],
    allLabel: string,
  ) => {
    const isLocked = locked[key] !== undefined;
    const current = merged[key];
    const id = `scanner-filter-${key}`;
    return (
      <div className="min-w-0 space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <Select
          id={id}
          value={current === undefined ? ALL : String(current)}
          disabled={isLocked}
          title={isLocked ? "Set by the selected tab" : undefined}
          onChange={(event) => set(key, event.target.value)}
        >
          {key === "minScore" ? null : <option value={ALL}>{allLabel}</option>}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
    );
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7">
        {control(
          "market",
          "Market",
          MARKET_SEGMENTS.map((segment) => ({ value: segment.id, label: segment.label })),
          "All markets",
        )}
        {control("assetClass", "Asset class", ASSET_CLASSES, "All asset classes")}
        {control("timeframe", "Timeframe", TIMEFRAMES, "All timeframes")}
        {control("setupType", "Setup type", SETUP_TYPES, "All setup types")}
        {control("minScore", "Minimum score", MIN_SCORES, "Any score")}
        {control(
          "direction",
          "Direction",
          [
            { value: "bullish", label: "Bullish" },
            { value: "bearish", label: "Bearish" },
          ],
          "Both directions",
        )}
        {control(
          "status",
          "Status",
          OPPORTUNITY_STATUSES.map((status) => ({
            value: status,
            label: SETUP_STATUS_LABEL[status],
          })),
          "All statuses",
        )}
      </div>
      <div className="mt-3 flex justify-end">
        <Button variant="ghost" size="sm" onClick={onReset} disabled={!canReset}>
          <RotateCcw aria-hidden="true" />
          Reset filters
        </Button>
      </div>
    </div>
  );
}
