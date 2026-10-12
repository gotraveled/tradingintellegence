"use client";

import { Radar } from "lucide-react";
import { useMemo, useState } from "react";
import { OpportunityCard } from "@/components/opportunities/opportunity-card";
import { DemoBadge } from "@/components/shared/demo";
import { EmptyState } from "@/components/ui/empty-state";
import type { ScannerView } from "@/lib/constants";
import type { DataSource } from "@/lib/services/intelligence";
import type { Opportunity } from "@/lib/types";
import { filterOpportunities, sortOpportunities, type OpportunityFilter } from "@/lib/utils";
import { ScannerFilterBar } from "./scanner-filter-bar";
import { ScannerTable, type SortState } from "./scanner-table";

interface ScannerResultsProps {
  opportunities: Opportunity[];
  source: DataSource;
  view?: ScannerView;
}

/**
 * Client-side filtering and sorting of an already-fetched result set.
 * This is presentation logic only — no scanning or detection happens here.
 */
export function ScannerResults({ opportunities, source, view }: ScannerResultsProps) {
  const [filter, setFilter] = useState<OpportunityFilter>({});
  const [sort, setSort] = useState<SortState>({ key: "score", order: "desc" });

  const locked = useMemo<OpportunityFilter>(
    () => ({
      ...(view?.setupType ? { setupType: view.setupType } : {}),
      ...(view?.status ? { status: view.status } : {}),
    }),
    [view],
  );

  const results = useMemo(
    () =>
      sortOpportunities(
        filterOpportunities(opportunities, { ...filter, ...locked }),
        sort.key,
        sort.order,
      ),
    [opportunities, filter, locked, sort],
  );

  const canReset = Object.keys(filter).length > 0;

  return (
    <div className="space-y-4">
      <ScannerFilterBar
        value={filter}
        locked={locked}
        onChange={setFilter}
        onReset={() => setFilter({})}
        canReset={canReset}
      />

      <section aria-label="Scanner results" className="rounded-lg border border-border bg-surface">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Results</h2>
            <span className="numeric text-xs text-muted-foreground" aria-live="polite">
              {results.length} of {opportunities.length}
            </span>
            {source === "demo" ? <DemoBadge /> : null}
          </div>
          <p className="text-xs text-subtle-foreground">
            Scores describe evidence quality, not the probability of profit.
          </p>
        </header>

        {results.length === 0 ? (
          <EmptyState
            icon={Radar}
            title="No setups match these filters"
            description="Adjust or reset the filters to see more results."
          />
        ) : (
          <>
            <div className="hidden md:block">
              <ScannerTable opportunities={results} sort={sort} onSortChange={setSort} />
            </div>
            <div className="grid gap-3 p-3 md:hidden">
              {results.map((opportunity) => (
                <OpportunityCard
                  key={opportunity.id}
                  opportunity={opportunity}
                  demo={source === "demo"}
                />
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
