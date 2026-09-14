import { ArrowLeft } from "lucide-react";
import type { ComponentType } from "react";

import type { DatabaseType } from "@/lib/types/database";

export interface NavItem {
  label: string;
  href: string;
  // Any glyph that takes a className - lucide's icons and Deplo's own mark.
  icon: ComponentType<{ className?: string }>;
  tooltip: string;
  // exact match for active state (default: startsWith)
  exact?: boolean;
  // A picture that stands in for `icon`: the app's or database's own logo.
  mark?:
    | { kind: "app"; logo: string | null }
    | { kind: "database"; logo: string | null; type: DatabaseType };
  // A "back" escape hatch: the sidebar routes a plain click through the browser's
  // back, and `href` is the fallback when there is no in-app page to go back to.
  back?: boolean;
  // Per-team capability required to SEE this item. Absent ⇒ always visible; the
  // destination page guards server-side anyway. Matches lib/types/identity.ts Capability.
  requires?: string;
  // Visible when the member holds ANY ONE of these.
  requiresAny?: string[];
  // Visible only to instance admins (orthogonal to team capabilities).
  requiresAdmin?: boolean;
  // Render the entry but do NOT link it, with this sentence as its tooltip.
  // Unlike `requires`, which hides, this cannot be granted.
  disabledReason?: string;
}

// canSee - the one visibility rule, shared by the sidebar and the command palette
// so the two can never disagree about what is reachable.
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
  // Render this section's entries as plain text, no icons.
  iconless?: boolean;
}

// backSection - the "back" row every sub-menu opens with.
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

// itemIf - an entry the nav lists only under a condition, spread into its section.
export function itemIf(condition: boolean, item: NavItem): NavItem[] {
  return condition ? [item] : [];
}
