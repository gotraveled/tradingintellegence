import type { ReactNode } from "react";

interface PublicPageProps {
  eyebrow?: string;
  title: string;
  description?: string;
  children: ReactNode;
}

/** Shared shell for public content pages: header plus readable measure. */
export function PublicPage({ eyebrow, title, description, children }: PublicPageProps) {
  return (
    <div className="mx-auto max-w-3xl space-y-12 px-4 py-16 sm:px-6 sm:py-20">
      <header className="space-y-4">
        {eyebrow ? (
          <p className="text-xs font-medium tracking-[0.16em] text-info uppercase">{eyebrow}</p>
        ) : null}
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h1>
        {description ? (
          <p className="text-base leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </header>
      <div className="space-y-10">{children}</div>
    </div>
  );
}

/** Content section with a heading and flow text. */
export function PublicSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}
