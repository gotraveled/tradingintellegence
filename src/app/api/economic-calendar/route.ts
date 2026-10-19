import { NextResponse } from "next/server";

/**
 * High-impact economic calendar — mirrors the same release data Forex
 * Factory publishes (ff_calendar_thisweek.json is the community-standard
 * weekly mirror; FF itself offers no public API). Cached upstream for 6h
 * via Next's fetch revalidation; events are informational context only —
 * the engine never fabricates a "news score".
 */

export interface CalendarEvent {
  title: string;
  currency: string;
  /** ISO timestamp of the release. */
  time: string;
  impact: "High" | "Medium" | "Low" | "Holiday" | string;
  forecast?: string;
  previous?: string;
}

interface FfRow {
  title?: string;
  country?: string;
  date?: string;
  impact?: string;
  forecast?: string;
  previous?: string;
}

const SOURCE = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

export async function GET() {
  try {
    const res = await fetch(SOURCE, { next: { revalidate: 21_600 } });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Calendar upstream ${res.status}`, events: [] },
        { status: 502 },
      );
    }
    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) {
      return NextResponse.json({ error: "Unexpected calendar payload", events: [] }, { status: 502 });
    }
    const events: CalendarEvent[] = (raw as FfRow[])
      .filter(
        (r): r is Required<Pick<FfRow, "title" | "country" | "date" | "impact">> & FfRow =>
          typeof r.title === "string" &&
          typeof r.country === "string" &&
          typeof r.date === "string" &&
          typeof r.impact === "string" &&
          !Number.isNaN(Date.parse(r.date)),
      )
      .map((r) => ({
        title: r.title,
        currency: r.country,
        time: new Date(r.date).toISOString(),
        impact: r.impact,
        ...(r.forecast !== undefined && r.forecast !== "" ? { forecast: r.forecast } : {}),
        ...(r.previous !== undefined && r.previous !== "" ? { previous: r.previous } : {}),
      }));
    return NextResponse.json({ events });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Calendar fetch failed", events: [] },
      { status: 502 },
    );
  }
}
