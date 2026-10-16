/**
 * research-feeds — parser + aggregation tests (Phase P4).
 * Deterministic: canned RSS2/Atom XML in, structured items out. Fetch is
 * injected so no network is touched — a feed failure must degrade to an
 * error row, never fabricated items.
 */
import { describe, expect, it } from "vitest";
import {
  fetchResearchDesk,
  fetchResearchSource,
  parseFeedXml,
  RESEARCH_SOURCES,
  type ResearchSource,
} from "../research-feeds";

const SRC: ResearchSource = {
  id: "test-src",
  name: "Test Feed",
  url: "https://example.test/feed.xml",
  scope: "test",
  termsNote: "test",
};

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Fed holds rates steady</title>
    <link>https://example.test/1</link>
    <pubDate>Tue, 15 Oct 2026 14:00:00 GMT</pubDate>
    <guid>guid-1</guid>
    <description>&lt;p&gt;Statement text&lt;/p&gt;</description>
  </item>
  <item>
    <title><![CDATA[CPI rises 0.3% in September]]></title>
    <link>https://example.test/2</link>
    <pubDate>Mon, 14 Oct 2026 12:30:00 GMT</pubDate>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>SEC filing: Form 8-K</title>
    <link href="https://example.test/filing/1" rel="alternate"/>
    <updated>2026-10-15T10:00:00Z</updated>
    <id>urn:sec:1</id>
    <summary>Current report filed.</summary>
  </entry>
</feed>`;

describe("parseFeedXml", () => {
  it("parses RSS2 items with title/link/date/summary", () => {
    const items = parseFeedXml(RSS, SRC);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      sourceId: "test-src",
      sourceName: "Test Feed",
      title: "Fed holds rates steady",
      url: "https://example.test/1",
      publishedAt: "2026-10-15T14:00:00.000Z",
    });
    expect(items[0].summary).toBe("Statement text"); // HTML stripped
    expect(items[1].title).toContain("CPI"); // CDATA unwrapped
  });

  it("parses Atom entries", () => {
    const items = parseFeedXml(ATOM, SRC);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "SEC filing: Form 8-K",
      url: "https://example.test/filing/1",
      publishedAt: "2026-10-15T10:00:00.000Z",
    });
  });

  it("skips items missing title or link — never emits half-items", () => {
    const xml = `<rss><channel>
      <item><title>no link</title></item>
      <item><link>https://x.test</link></item>
    </channel></rss>`;
    expect(parseFeedXml(xml, SRC)).toHaveLength(0);
  });

  it("omits publishedAt for unparseable dates — never invents a timestamp", () => {
    const xml = `<rss><channel><item>
      <title>x</title><link>https://x.test</link><pubDate>not a date</pubDate>
    </item></channel></rss>`;
    const [item] = parseFeedXml(xml, SRC);
    expect(item.publishedAt).toBeUndefined();
  });
});

describe("fetchResearchSource — failure honesty", () => {
  const okFetch = async () => new Response(RSS, { status: 200 });

  it("returns items on a good fetch", async () => {
    const r = await fetchResearchSource({ ...SRC, id: "ok-1" }, okFetch as typeof fetch);
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(2);
  });

  it("degrades to an error row on HTTP failure", async () => {
    const r = await fetchResearchSource(
      { ...SRC, id: "fail-1" },
      (async () => new Response("oops", { status: 503 })) as typeof fetch,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("HTTP 503");
    expect(r.items).toHaveLength(0);
  });

  it("degrades to an error row on network failure — never throws", async () => {
    const r = await fetchResearchSource(
      { ...SRC, id: "fail-2" },
      (async () => { throw new Error("boom"); }) as typeof fetch,
    );
    expect(r.ok).toBe(false);
    expect(r.items).toHaveLength(0);
  });
});

describe("fetchResearchDesk — registry + dedup", () => {
  it("registered sources are official public feeds only", () => {
    for (const s of RESEARCH_SOURCES) {
      expect(s.url.startsWith("https://")).toBe(true);
      expect(s.termsNote.length).toBeGreaterThan(0); // basis recorded per source
    }
  });

  it("deduplicates identical items across sources — first source wins", async () => {
    const sameRss = RSS; // identical items in every source
    const stub = (async () => new Response(sameRss, { status: 200 })) as typeof fetch;
    const results = await fetchResearchDesk(stub);
    const total = results.reduce((n, r) => n + r.items.length, 0);
    // 4 registry sources × 2 identical items → only 2 survive the cross-source dedup.
    expect(total).toBe(2);
  });
});
