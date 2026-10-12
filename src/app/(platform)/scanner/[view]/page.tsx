import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ScannerWorkspace } from "@/components/scanner/scanner-workspace";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getScannerView, SCANNER_VIEWS } from "@/lib/constants";

export function generateStaticParams() {
  return SCANNER_VIEWS.map((view) => ({ view: view.id }));
}

export async function generateMetadata(props: PageProps<"/scanner/[view]">): Promise<Metadata> {
  const { view } = await props.params;
  const match = getScannerView(view);
  return { title: match ? `Scanner · ${match.label}` : "Scanner" };
}

async function ScannerViewContent({ params }: { params: Promise<{ view: string }> }) {
  const { view } = await params;
  const match = getScannerView(view);
  if (!match) notFound();
  return <ScannerWorkspace view={match} />;
}

export default function ScannerViewPage(props: PageProps<"/scanner/[view]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ScannerViewContent params={props.params} />
    </Suspense>
  );
}
