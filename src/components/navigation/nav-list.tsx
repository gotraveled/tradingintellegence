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

/** Pure navigation renderer. Active state is derived from the provided pathname. */
export function NavList({ pathname, onNavigate }: NavListProps) {
  return (
    <nav aria-label="Primary" className="flex flex-1 flex-col gap-6">
      <ul className="space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href}>
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
