import Link from "next/link";
import { NAV_ITEMS, SETTINGS_NAV_ITEM } from "@/lib/constants";
import type { NavItem } from "@/lib/types";
import { NavGroup } from "./nav-group";
import { navItemClasses, NavItemContent } from "./nav-item";

interface NavListProps {
  pathname: string | null;
  onNavigate?: () => void;
}

function isActive(pathname: string | null, href: string) {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={navItemClasses(active)}
    >
      <NavItemContent item={item} active={active} />
    </Link>
  );
}

const GROUP_LABEL: Record<string, string> = {
  available: "Research tools",
  preview: "Provider-gated",
  sample: "Sample data",
  planned: "Planned",
};

/** Pure navigation renderer. Active state is derived from the provided pathname. */
export function NavList({ pathname, onNavigate }: NavListProps) {
  return (
    <nav aria-label="Primary" className="flex flex-1 flex-col gap-6">
      <ul className="space-y-0.5">
        {NAV_ITEMS.map((item, index) => {
          const active = isActive(pathname, item.href);
          const showGroup =
            index === 0 || NAV_ITEMS[index - 1].availability !== item.availability;
          return (
            <li key={item.href}>
              {showGroup ? (
                <p className="px-3 pt-4 pb-1 text-[10px] font-medium tracking-wider text-subtle-foreground uppercase first:pt-0">
                  {GROUP_LABEL[item.availability] ?? item.availability}
                </p>
              ) : null}
              {item.children?.length ? (
                <NavGroup
                  href={item.href}
                  pathname={pathname}
                  sectionActive={active}
                  onNavigate={onNavigate}
                />
              ) : (
                <NavLink item={item} active={active} onNavigate={onNavigate} />
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-auto">
        <NavLink
          item={SETTINGS_NAV_ITEM}
          active={isActive(pathname, SETTINGS_NAV_ITEM.href)}
          onNavigate={onNavigate}
        />
      </div>
    </nav>
  );
}
