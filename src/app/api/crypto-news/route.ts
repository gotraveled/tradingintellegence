/**
 * GET /api/crypto-news — top public crypto headlines, proxied server-side.
 *
 * Source: CryptoCompare's public news endpoint (no key required, browser CORS
 * blocks direct calls so the request runs server-side). Responses are cached
 * in-process for 5 minutes; failures return an honest error, never fabricated
 * headlines.
 */

const SOURCE_URL = "https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=BTC,ETH,Altcoin,Market,Blockchain,Regulation";
const TIMEOUT_MS = 8_000;
const LIMIT = 15;
const CACHE_MS = 300_000; // 5 minutes

interface RemoteItem {
  title?: string;
  url?: string;
  source?: string;
  published_on?: number;
}

interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt?: number;
}

let cache: { items: NewsItem[]; fetchedAt: number } | undefined;

export async function GET(): Promise<Response> {
  if (cache !== undefined && Date.now() - cache.fetchedAt < CACHE_MS) {
    return Response.json({ items: cache.items });
  }
  try {
    const res = await fetch(SOURCE_URL, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      return Response.json(
        { error: { message: `news source answered HTTP ${res.status}` }, items: [] },
        { status: 502 },
      );
    }
    const body = (await res.json()) as { Data?: RemoteItem[] };
    const items: NewsItem[] = (body.Data ?? [])
      .filter((i) => typeof i.title === "string" && typeof i.url === "string")
      .slice(0, LIMIT)
      .map((i) => ({
        title: i.title as string,
        url: i.url as string,
        source: typeof i.source === "string" ? i.source : "unknown",
        publishedAt: typeof i.published_on === "number" ? i.published_on * 1000 : undefined,
      }));
    cache = { items, fetchedAt: Date.now() };
    return Response.json({ items });
  } catch {
    return Response.json(
      { error: { message: "news source unreachable — try again later" }, items: [] },
      { status: 502 },
    );
  }
}
