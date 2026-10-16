"use client";

/**
 * Research Desk (Phase P4) — official public feeds, sourced and linked.
 * Headlines only: no interpretation, no fabricated signal — the desk surfaces
 * what official sources actually published, with attribution.
 */
import { useEffect, useMemo, useState } from "react";
import { Newspaper, RefreshCw } from "lucide-react";
import type { ResearchItem, ResearchSourceResult } from "@/lib/services/research-feeds";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";

interface DeskResult {
  sources: ResearchSourceResult[];
  itemCount: number;
  provenance: string;
}

export function ResearchDesk() {
  const [data, setData] = useState<DeskResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [source, setSource] = useState("");

  const fetchDesk = async (): Promise<DeskResult> => {
    const res = await fetch("/api/research", { cache: "no-store" });
    const body = (await res.json()) as { result?: DeskResult; error?: { message?: string } };
    if (!res.ok || !body.result) {
      throw new Error(body.error?.message ?? `research desk failed (HTTP ${res.status})`);
    }
    return body.result;
  };

  const refresh = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setData(await fetchDesk());
    } catch (e) {
      setError(e instanceof Error ? e.message : "The research service could not be reached.");
    }
    setLoading(false);
  };

  // Initial fetch — setStates run only after awaits; `loading` starts true.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await fetchDesk();
        if (!cancelled) setData(result);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "The research service could not be reached.");
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sources = useMemo(() => data?.sources ?? [], [data]);
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sources
      .filter((r) => source === "" || r.source.id === source)
      .map((r) => ({
        ...r,
        items: needle
          ? r.items.filter(
              (i: ResearchItem) =>
                i.title.toLowerCase().includes(needle) ||
                (i.summary ?? "").toLowerCase().includes(needle),
            )
          : r.items,
      }));
  }, [sources, q, source]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter headlines…"
          className="w-64 rounded-md border border-border bg-surface px-2 py-1.5 text-xs"
        />
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs"
        >
          <option value="">All sources</option>
          {sources.map((r) => (
            <option key={r.source.id} value={r.source.id}>{r.source.name}</option>
          ))}
        </select>
        <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
        <p className="text-xs text-muted-foreground">{data?.provenance}</p>
      </div>

      {error ? <Notice tone="error" title="Research desk unavailable">{error}</Notice> : null}

      {!loading && !error && data?.itemCount === 0 ? (
        <EmptyState
          icon={Newspaper}
          title="No items right now"
          description="The feeds returned nothing — check back later or filter less."
        />
      ) : null}

      {visible.map((r) => (
        <Card key={r.source.id}>
          <CardHeader
            title={r.source.name}
            description={
              r.ok
                ? `${r.source.scope} — ${r.items.length} item(s), fetched ${new Date(r.fetchedAt).toLocaleString()}`
                : `unavailable — ${r.error ?? "unknown error"}`
            }
          />
          {r.ok && r.items.length > 0 ? (
            <CardContent className="p-0">
              <ul className="divide-y divide-border/50">
                {r.items.slice(0, 25).map((i) => (
                  <li key={i.id} className="px-5 py-3">
                    <a
                      href={i.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-foreground hover:underline"
                    >
                      {i.title}
                    </a>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{i.sourceName}</span>
                      {i.publishedAt ? <span>{new Date(i.publishedAt).toLocaleString()}</span> : null}
                    </div>
                    {i.summary ? <p className="mt-1 text-xs text-muted-foreground">{i.summary}</p> : null}
                  </li>
                ))}
              </ul>
            </CardContent>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
