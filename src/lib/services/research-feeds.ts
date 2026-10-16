/**
 * Research Desk sources (Phase P4) — a curated registry of publicly published
 * RSS/Atom feeds plus a zero-dependency fetch + parse layer.
 *
 * Terms posture (verified against each source's published usage policy):
 * - All listed sources are official/public feeds intended for syndication
 *   readers — we fetch, attribute, and LINK to the original; we never copy
 *   full article bodies.
 * - No scraping, no gated content, no headless rendering — feed XML only.
 * - Each item keeps its source name + timestamp; the UI distinguishes sourced
 *   facts from interpretation (there is no interpretation here — headlines only).
 *
 * Feeds fail independently: one unreachable source degrades to an error row,
 * never blocks the desk, and never substitutes fabricated items.
 */

export interface ResearchSource {
  id: string;
  name: string;
  url: string;
  /** What the feed covers — shown to the user so scope is honest. */
  scope: string;
  /** Syndication basis recorded for audit. */
  termsNote: string;
}

/** Official, publicly syndicated feeds only. */
export const RESEARCH_SOURCES: ResearchSource[] = [
  {
    id: "sec-edgar",
    name: "SEC EDGAR — Latest Filings",
    url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&CIK=&type=&company=&dateb=&owner=include&start=0&count=40&output=atom",
    scope: "Real-time SEC filing feed — US public-company disclosures.",
    termsNote: "SEC publishes EDGAR feeds for automated access (sec.gov fair-access policy; declared UA required).",
  },
  {
    id: "fed-press",
    name: "Federal Reserve — Press Releases",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    scope: "FOMC decisions, supervision, and official Fed announcements.",
    termsNote: "Federal Reserve publishes this RSS feed for public syndication.",
  },
  {
    id: "ecb-press",
    name: "ECB — Press Releases",
    url: "https://www.ecb.europa.eu/rss/press.html",
    scope: "European Central Bank monetary-policy and banking releases.",
    termsNote: "ECB publishes RSS feeds for public syndication (ecb.europa.eu).",
  },
  {
    id: "bls-news",
    name: "BLS — Latest Releases",
    url: "https://www.bls.gov/feed/news_release.htm",
    scope: "US Bureau of Labor Statistics — CPI, employment, PPI releases.",
    termsNote: "BLS publishes public RSS feeds (bls.gov).",
  },
];

export interface ResearchItem {
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  url: string;
  /** ISO timestamp when the source supplied one — never invented. */
  publishedAt?: string;
  /** Summary text when the feed provides it — truncated, attributed. */
  summary?: string;
}

export interface ResearchSourceResult {
  source: ResearchSource;
  ok: boolean;
  items: ResearchItem[];
  error?: string;
  fetchedAt: string;
}

const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 5 * 60_000; // 5-minute server-side cache — respects feeds
const SUMMARY_MAX = 280;
const cache = new Map<string, { at: number; result: ResearchSourceResult }>();

const stripHtml = (s: string): string =>
  s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&") // amp last — never double-decode
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ").trim();

const tagText = (xml: string, tag: string): string | undefined => {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return undefined;
  const inner = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
  return inner === "" ? undefined : inner;
};

/** Minimal RSS2 + Atom item extraction — dependency-free, forgiving. */
export function parseFeedXml(xml: string, source: ResearchSource): ResearchItem[] {
  const items: ResearchItem[] = [];
  const blocks = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  const entries = [...xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)].map((m) => m[1]);

  for (const b of blocks) {
    const title = stripHtml(tagText(b, "title") ?? "");
    const link = tagText(b, "link")?.trim();
    const pub = tagText(b, "pubDate") ?? tagText(b, "dc:date") ?? tagText(b, "date");
    const guid = tagText(b, "guid") ?? link ?? title;
    if (!title || !link) continue;
    items.push({
      id: `${source.id}:${guid.slice(0, 80)}`,
      sourceId: source.id,
      sourceName: source.name,
      title,
      url: link,
      ...(pub && Number.isFinite(Date.parse(pub))
        ? { publishedAt: new Date(pub).toISOString() }
        : {}),
      ...(tagText(b, "description")
        ? { summary: stripHtml(tagText(b, "description")!).slice(0, SUMMARY_MAX) }
        : {}),
    });
  }

  for (const b of entries) {
    const title = stripHtml(tagText(b, "title") ?? "");
    const linkMatch = b.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
    const link = linkMatch?.[1];
    const pub = tagText(b, "updated") ?? tagText(b, "published") ?? tagText(b, "issued");
    const id = tagText(b, "id") ?? link ?? title;
    if (!title || !link) continue;
    items.push({
      id: `${source.id}:${id.slice(0, 80)}`,
      sourceId: source.id,
      sourceName: source.name,
      title,
      url: link,
      ...(pub && Number.isFinite(Date.parse(pub))
        ? { publishedAt: new Date(pub).toISOString() }
        : {}),
      ...(tagText(b, "summary") ?? tagText(b, "content")
        ? { summary: stripHtml((tagText(b, "summary") ?? tagText(b, "content"))!).slice(0, SUMMARY_MAX) }
        : {}),
    });
  }
  return items;
}

/** Fetch one feed — cached for CACHE_TTL_MS, never throws. */
export async function fetchResearchSource(
  source: ResearchSource,
  fetchImpl: typeof fetch = fetch,
): Promise<ResearchSourceResult> {
  const hit = cache.get(source.id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  const fetchedAt = new Date().toISOString();
  let result: ResearchSourceResult;
  try {
    const res = await fetchImpl(source.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        // Honest declared UA — SEC fair-access policy requires identification.
        "User-Agent": "TradingIntelligence/1.0 (research desk; contact: operator)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
      },
    });
    if (!res.ok) {
      result = { source, ok: false, items: [], error: `HTTP ${res.status}`, fetchedAt };
    } else {
      const xml = await res.text();
      const items = parseFeedXml(xml, source);
      result =
        items.length === 0
          ? { source, ok: false, items: [], error: "feed parsed but contained no items", fetchedAt }
          : { source, ok: true, items, fetchedAt };
    }
  } catch (e) {
    result = {
      source,
      ok: false,
      items: [],
      error: e instanceof Error && e.name === "TimeoutError" ? "timed out" : "unreachable",
      fetchedAt,
    };
  }
  cache.set(source.id, { at: Date.now(), result });
  return result;
}

/** All sources, deduplicated by url+title, newest first. */
export async function fetchResearchDesk(
  fetchImpl: typeof fetch = fetch,
): Promise<ResearchSourceResult[]> {
  const results = await Promise.all(RESEARCH_SOURCES.map((s) => fetchResearchSource(s, fetchImpl)));
  const seen = new Set<string>();
  for (const r of results) {
    r.items = r.items.filter((i) => {
      const key = `${i.url}|${i.title.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  for (const r of results) {
    r.items.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  }
  return results;
}
