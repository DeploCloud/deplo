import { Database, House, Menu, Rocket } from "lucide-react";

import type { NavItem } from "./nav-item";

export type MobileTabId = "home" | "deployments" | "storage" | "more";

export interface MobileTab extends Pick<NavItem, "label" | "icon"> {
  id: MobileTabId;
  // No href: the More tab opens a panel instead of a page.
  href?: string;
}

// Four equal slots, the same for every member: nothing here is Capability-gated.
export const MOBILE_TABS: MobileTab[] = [
  { id: "home", label: "Home", href: "/", icon: House },
  {
    id: "deployments",
    label: "Deployments",
    href: "/deployments",
    icon: Rocket,
  },
  { id: "storage", label: "Storage", href: "/storage", icon: Database },
  { id: "more", label: "More", icon: Menu },
];

const MORE_SECTIONS =
  /^\/(logs|variables|templates|activity|monitoring|settings)(\/|$)/;

// An App or a Project drill-in lives under Home; the sections only More opens light More.
export function activeMobileTab(pathname: string): MobileTabId {
  if (/^\/deployments(\/|$)/.test(pathname)) return "deployments";
  if (/^\/storage(\/|$)/.test(pathname)) return "storage";
  if (MORE_SECTIONS.test(pathname)) return "more";
  return "home";
}

export type TabPlaces = Partial<Record<MobileTabId, string>>;

/** Like a phone app: a tab reopens where you left it, and tapping the tab you are in goes to its root. */
export function tabHref(
  tab: MobileTab,
  active: MobileTabId,
  places: TabPlaces,
): string | undefined {
  if (!tab.href) return undefined;
  return tab.id === active ? tab.href : (places[tab.id] ?? tab.href);
}
