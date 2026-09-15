import { ArrowLeft } from "lucide-react";
import type { ComponentType } from "react";

import type { DatabaseType } from "@/lib/types/database";

export interface NavItem {
  label: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  tooltip: string;
  exact?: boolean;
  mark?:
    | { kind: "app"; logo: string | null }
    | { kind: "database"; logo: string | null; type: DatabaseType };
  back?: boolean;
  requires?: string;
  requiresAny?: string[];
  requiresAdmin?: boolean;
  disabledReason?: string;
}

export function canSee(
  item: Pick<NavItem, "requires" | "requiresAny" | "requiresAdmin">,
  caps: ReadonlySet<string>,
  isAdmin: boolean,
): boolean {
  return (
    (!item.requires || caps.has(item.requires)) &&
    (!item.requiresAny || item.requiresAny.some((c) => caps.has(c))) &&
    (!item.requiresAdmin || isAdmin)
  );
}

export interface NavSection {
  title?: string;
  items: NavItem[];
  iconless?: boolean;
}

export function backSection(
  label: string,
  href: string,
  tooltip: string,
  back = false,
): NavSection {
  return {
    items: [
      {
        label,
        href,
        icon: ArrowLeft,
        tooltip,
        exact: true,
        ...(back ? { back: true } : {}),
      },
    ],
  };
}

export function itemIf(condition: boolean, item: NavItem): NavItem[] {
  return condition ? [item] : [];
}
