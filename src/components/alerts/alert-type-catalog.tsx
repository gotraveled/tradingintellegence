"use client";

import { Plus } from "lucide-react";
import { ALERT_TYPES } from "@/lib/constants";
import type { AlertType } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AlertTypeIcon } from "./alert-type-icon";

interface AlertTypeCatalogProps {
  selected?: AlertType;
  onSelect: (type: AlertType) => void;
}

/** Horizontal scroller on small screens, grid on larger screens. */
export function AlertTypeCatalog({ selected, onSelect }: AlertTypeCatalogProps) {
  return (
    <section aria-labelledby="alert-types-heading" className="space-y-3">
      <div>
        <h2 id="alert-types-heading" className="text-sm font-semibold">
          Alert types
        </h2>
        <p className="text-xs text-muted-foreground">Choose a type to start a new alert rule.</p>
      </div>
      <ul className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-4 2xl:grid-cols-7">
        {ALERT_TYPES.map((type) => {
          const active = selected === type.value;
          return (
            <li key={type.value} className="w-64 shrink-0 snap-start sm:w-auto">
              <button
                type="button"
                onClick={() => onSelect(type.value)}
                aria-pressed={active}
                className={cn(
                  "group flex h-full w-full flex-col gap-3 rounded-lg border bg-surface p-4 text-left transition-colors hover:border-border-strong",
                  active ? "border-primary" : "border-border",
                )}
              >
                <div className="flex items-start justify-between">
                  <AlertTypeIcon type={type.value} />
                  <Plus
                    className="size-4 text-subtle-foreground group-hover:text-foreground"
                    aria-hidden="true"
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">{type.label}</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {type.description}
                  </p>
                </div>
                <span className="mt-auto text-[10px] font-medium tracking-wide text-subtle-foreground uppercase">
                  {type.group}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
