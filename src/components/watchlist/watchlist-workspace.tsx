"use client";

import { CircleMinus, Plus, Star, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { SetupStatusBadge } from "@/components/opportunities/status-badge";
import { BiasBadge } from "@/components/shared/bias-badge";
import { DemoBadge } from "@/components/shared/demo";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/field";
import { StatusBadge } from "@/components/ui/status";
import { TableShell } from "@/components/ui/table-shell";
import {
  describeSetup,
  FEATURED_INSTRUMENTS,
  getMarketSegment,
  NO_SETUP_LABEL,
} from "@/lib/constants";
import type { DataSource } from "@/lib/services/types";
import type { MarketSegmentId, WatchlistItem } from "@/lib/types";
import { formatDateTimeUTC } from "@/lib/utils";

const COLUMNS = [
  { key: "symbol", label: "Symbol" },
  { key: "market", label: "Market" },
  { key: "status", label: "Current status" },
  { key: "setup", label: "Setup" },
  { key: "score", label: "Score", align: "right" as const },
  { key: "updated", label: "Last update", align: "right" as const },
  { key: "actions", label: "Actions", align: "right" as const },
];

function StatusCell({ item }: { item: WatchlistItem }) {
  return item.status === "no_setup" ? (
    <StatusBadge tone="inactive" label={NO_SETUP_LABEL} icon={CircleMinus} />
  ) : (
    <SetupStatusBadge status={item.status} />
  );
}

function SetupCell({ item }: { item: WatchlistItem }) {
  if (!item.setupType || !item.direction || item.status === "no_setup") {
    return <span className="text-subtle-foreground">—</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span>{describeSetup(item.direction, item.setupType, item.status)}</span>
      <BiasBadge bias={item.direction} />
    </div>
  );
}

interface WatchlistWorkspaceProps {
  initialItems: WatchlistItem[];
  source: DataSource;
}

export function WatchlistWorkspace({ initialItems, source }: WatchlistWorkspaceProps) {
  const [items, setItems] = useState(initialItems);
  const available = FEATURED_INSTRUMENTS.filter(
    (asset) => !items.some((item) => item.symbol === asset.symbol),
  );
  const [selected, setSelected] = useState("");

  const add = (event: FormEvent) => {
    event.preventDefault();
    const asset = available.find((item) => item.symbol === selected);
    if (!asset) return;
    const now = new Date().toISOString();
    setItems((prev) => [
      ...prev,
      {
        id: `local-${asset.id}`,
        symbol: asset.symbol,
        market: asset.marketId as MarketSegmentId,
        assetClass: asset.assetClass,
        status: "no_setup",
        lastUpdate: now,
        createdAt: now,
      },
    ]);
    setSelected("");
  };

  const remove = (id: string) => setItems((prev) => prev.filter((item) => item.id !== id));
  const marketLabel = (id: MarketSegmentId) => getMarketSegment(id)?.label ?? id;
  const demo = source === "demo";

  return (
    <section
      aria-labelledby="watchlist-heading"
      className="rounded-lg border border-border bg-surface"
    >
      <header className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h2 id="watchlist-heading" className="text-sm font-semibold">
            Tracked instruments
          </h2>
          <span className="numeric text-xs text-muted-foreground">{items.length}</span>
          {demo ? <DemoBadge /> : null}
        </div>
        <form onSubmit={add} className="flex items-center gap-2" aria-label="Add to watchlist">
          <label htmlFor="watchlist-add" className="sr-only">
            Instrument to add
          </label>
          <Select
            id="watchlist-add"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            className="h-8 w-44"
            disabled={available.length === 0}
          >
            <option value="">{available.length ? "Select instrument" : "All added"}</option>
            {available.map((asset) => (
              <option key={asset.id} value={asset.symbol}>
                {asset.symbol}
              </option>
            ))}
          </Select>
          <Button type="submit" size="sm" disabled={!selected}>
            <Plus aria-hidden="true" />
            Add
          </Button>
        </form>
      </header>

      {items.length === 0 ? (
        <EmptyState
          icon={Star}
          title="Your watchlist is empty"
          description="Add an instrument to track its setup status and score."
        />
      ) : (
        <>
          <div className="hidden md:block">
            <TableShell caption="Watchlist" columns={COLUMNS}>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-border last:border-b-0">
                  <th scope="row" className="px-5 py-3 text-left numeric font-semibold">
                    {item.symbol}
                  </th>
                  <td className="px-5 py-3 text-muted-foreground">{marketLabel(item.market)}</td>
                  <td className="px-5 py-3">
                    <StatusCell item={item} />
                  </td>
                  <td className="px-5 py-3">
                    <SetupCell item={item} />
                  </td>
                  <td className="px-5 py-3 text-right numeric">
                    {item.score ?? <span className="text-subtle-foreground">—</span>}
                  </td>
                  <td className="px-5 py-3 text-right numeric text-xs text-muted-foreground">
                    <time dateTime={item.lastUpdate}>{formatDateTimeUTC(item.lastUpdate)}</time>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => remove(item.id)}
                      aria-label={`Remove ${item.symbol} from watchlist`}
                    >
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              ))}
            </TableShell>
          </div>

          <ul className="divide-y divide-border md:hidden">
            {items.map((item) => (
              <li key={item.id} className="space-y-2.5 px-4 py-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="numeric font-semibold">{item.symbol}</p>
                    <p className="text-xs text-muted-foreground">{marketLabel(item.market)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {item.score !== undefined ? (
                      <span className="numeric text-sm font-semibold">
                        {item.score}
                        <span className="text-subtle-foreground">/100</span>
                      </span>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => remove(item.id)}
                      aria-label={`Remove ${item.symbol} from watchlist`}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                <StatusCell item={item} />
                <div className="text-sm">
                  <SetupCell item={item} />
                </div>
                <p className="text-[11px] text-subtle-foreground">
                  Updated{" "}
                  <time dateTime={item.lastUpdate} className="numeric">
                    {formatDateTimeUTC(item.lastUpdate)}
                  </time>
                </p>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="border-t border-border px-4 py-2.5 text-[11px] text-subtle-foreground">
        Changes are kept in this session only. Persistence arrives with user accounts.
      </p>
    </section>
  );
}
