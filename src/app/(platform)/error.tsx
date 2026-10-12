"use client";

import { useEffect } from "react";
import Link from "next/link";
import { PageContainer } from "@/components/layout/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { ROUTES } from "@/lib/constants";

export default function PlatformError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageContainer>
      <Notice
        tone="error"
        title="This page could not be loaded"
        action={
          <>
            <Button size="sm" variant="secondary" onClick={() => retry()}>
              Try again
            </Button>
            <Link
              href={ROUTES.dashboard}
              className={buttonVariants({ size: "sm", variant: "ghost" })}
            >
              Go to dashboard
            </Link>
          </>
        }
      >
        An unexpected error occurred.
        {error.digest ? (
          <>
            {" "}
            Reference: <span className="numeric">{error.digest}</span>
          </>
        ) : null}
      </Notice>
    </PageContainer>
  );
}
