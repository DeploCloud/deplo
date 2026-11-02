import { Database, House, Logs, Menu, Rocket } from "lucide-react";

import { canSee, type NavItem } from "./nav-item";

export type MobileTabId = "home" | "deployments" | "storage" | "logs" | "more";

export interface MobileTab extends Pick<
  NavItem,
  "label" | "icon" | "requires"
> {
  id: MobileTabId;
  // No href: the More tab opens a panel instead of a page.
  href?: string;
}

export const MOBILE_TABS: MobileTab[] = [
  { id: "home", label: "Home", href: "/", icon: House },
  {
    id: "deployments",
    label: "Deployments",
    href: "/deployments",
    icon: Rocket,
  },
  { id: "storage", label: "Storage", href: "/storage", icon: Database },
  {
    id: "logs",
    label: "Logs",
    href: "/logs",
    icon: Logs,
    requires: "view_logs",
  },
  { id: "more", label: "More", icon: Menu },
];

export function visibleMobileTabs(caps: ReadonlySet<string>): MobileTab[] {
  return MOBILE_TABS.filter((t) => canSee(t, caps, false));
}

const MORE_SECTIONS =
  /^\/(variables|templates|activity|monitoring|settings)(\/|$)/;

// An App or a Project drill-in lives under Home; the sections only More opens light More.
export function activeMobileTab(pathname: string): MobileTabId {
  if (/^\/deployments(\/|$)/.test(pathname)) return "deployments";
  if (/^\/storage(\/|$)/.test(pathname)) return "storage";
  if (/^\/logs(\/|$)/.test(pathname)) return "logs";
  if (MORE_SECTIONS.test(pathname)) return "more";
  return "home";
}
