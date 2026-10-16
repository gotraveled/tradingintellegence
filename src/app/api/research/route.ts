/**
 * GET /api/research — Research Desk feed aggregation (Phase P4).
 *
 * Serves the curated RESEARCH_SOURCES registry: official, publicly syndicated
 * RSS/Atom feeds only. Query params: `q` (title/summary filter), `source`
 * (registry id). Sources fail independently — a dead feed is an error row,
 * never a substitute dataset. Server-side cache (5 min) respects each feed.
 * Every item carries source name, link, and published timestamp — attributed,
 * never editorialized.
 */
import { fetchResearchDesk, RESEARCH_SOURCES } from "@/lib/services/research-feeds";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const sourceFilter = url.searchParams.get("source")?.trim();

  const sources = sourceFilter
    ? RESEARCH_SOURCES.filter((s) => s.id === sourceFilter)
    : RESEARCH_SOURCES;
  if (sourceFilter && sources.length === 0) {
    return Response.json(
      { error: { message: `unknown source '${sourceFilter}'.` } },
      { status: 400 },
    );
  }

  const results = await fetchResearchDesk();
  const filtered = results
    .filter((r) => sources.some((s) => s.id === r.source.id))
    .map((r) => ({
      ...r,
      items: q
        ? r.items.filter(
            (i) =>
              i.title.toLowerCase().includes(q) ||
              (i.summary ?? "").toLowerCase().includes(q),
          )
        : r.items,
    }));

  return Response.json({
    result: {
      sources: filtered,
      itemCount: filtered.reduce((n, r) => n + r.items.length, 0),
      provenance:
        "official public feeds — headlines link to the source; no article bodies are stored or copied",
    },
  });
}
