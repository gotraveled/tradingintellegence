import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { MarketsWorkspace } from "@/components/markets/markets-workspace";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getMarketSegment, MARKET_SEGMENTS } from "@/lib/constants";

export function generateStaticParams() {
  return MARKET_SEGMENTS.map((segment) => ({ segment: segment.id }));
}

export async function generateMetadata(props: PageProps<"/markets/[segment]">): Promise<Metadata> {
  const { segment } = await props.params;
  const match = getMarketSegment(segment);
  return { title: match ? `Markets · ${match.label}` : "Markets" };
}

async function MarketSegmentContent({ params }: { params: Promise<{ segment: string }> }) {
  const { segment } = await params;
  const match = getMarketSegment(segment);
  if (!match) notFound();
  return <MarketsWorkspace segment={match} />;
}

export default function MarketSegmentPage(props: PageProps<"/markets/[segment]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <MarketSegmentContent params={props.params} />
    </Suspense>
  );
}
