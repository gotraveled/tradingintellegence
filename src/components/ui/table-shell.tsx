import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface TableColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  className?: string;
}

interface TableShellProps {
  columns: TableColumn[];
  children?: ReactNode;
  empty?: ReactNode;
  caption?: string;
  className?: string;
}

/** Table frame with consistent header styling and an empty-state slot. */
export function TableShell({ columns, children, empty, caption, className }: TableShellProps) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full min-w-[640px] border-collapse text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr className="border-b border-border">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  "px-5 py-2.5 text-[11px] font-medium tracking-wide text-subtle-foreground uppercase",
                  column.align === "right" ? "text-right" : "text-left",
                  column.className,
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {children ?? (
            <tr>
              <td colSpan={columns.length}>{empty}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
