import type { ComponentType } from "react";
import {
  Copy,
  Database,
  ExternalLink,
  Fingerprint,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Users,
} from "lucide-react";

import {
  NAV,
  SETTINGS_NAV,
  appNav,
  appSettingsNav,
  databaseNav,
  databaseSettingsNav,
  type AppNavFlags,
  type NavItem,
  type NavSection,
} from "@/components/layout/nav-config";
import { foldQuery } from "@/lib/match-query";
import { newAppHref } from "@/lib/overview-links";
import type { Capability, DatabaseType } from "@/lib/types";

/**
 * Everything the palette can reach that is NOT a search result: pages, settings
 * and the safe actions. Derived from nav-config wherever nav-config already
 * spells the label, so the two can never disagree.
 */

/** What choosing a row does. */
export type Run =
  | { kind: "href"; href: string; newTab?: boolean }
  | {
      kind: "mutation";
      query: string;
      variables: Record<string, unknown>;
      success: string;
    }
  | { kind: "copy"; text: string };

export interface Entry {
  /** cmdk's `value` and the recents key: unique, opaque, stable. */
  id: string;
  label: string;
  /** The muted line at the row's right edge. */
  hint?: string;
  icon: ComponentType<{ className?: string }>;
  group: string;
  run: Run;
  requires?: string;
  requiresAny?: string[];
  requiresAdmin?: boolean;
}

function fromSections(
  sections: NavSection[],
  group: (section: NavSection) => string,
  idPrefix = "nav",
): Entry[] {
  return sections.flatMap((section) =>
    section.items
      // A "Back to" row is a way out of a menu, not a destination.
      .filter((item) => !item.back && !item.disabledReason)
      .map((item) => toEntry(item, group(section), idPrefix)),
  );
}

/**
 * One row per destination, the first spelling winning. An app's two navigations
 * overlap - its Settings tab and the settings menu's General are the same page,
 * and not every "Back to" row is flagged as one - and two rows to one URL is
 * noise a palette cannot afford.
 */
function byDestination(entries: Entry[]): Entry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (entry.run.kind !== "href") return true;
    if (seen.has(entry.run.href)) return false;
    seen.add(entry.run.href);
    return true;
  });
}

function toEntry(item: NavItem, group: string, idPrefix: string): Entry {
  return {
    id: `${idPrefix}:${item.href}`,
    label: item.label,
    hint: item.tooltip,
    icon: item.icon,
    group,
    run: { kind: "href", href: item.href },
    requires: item.requires,
    requiresAny: item.requiresAny,
    requiresAdmin: item.requiresAdmin,
  };
}

/**
 * Aliases for settings nav-config has no row of its own for - the words people
 * actually type. Each points at a page already listed above, spelled the way its
 * destination spells it.
 */
const SETTINGS_EXTRAS: Entry[] = [
  {
    id: "setting:password",
    label: "Change password",
    hint: "Account security",
    icon: KeyRound,
    group: "Settings",
    run: { kind: "href", href: "/settings/security" },
  },
  {
    id: "setting:2fa",
    label: "Two-factor authentication",
    hint: "Account security",
    icon: ShieldCheck,
    group: "Settings",
    run: { kind: "href", href: "/settings/security" },
  },
  {
    id: "setting:passkeys",
    label: "Passkeys",
    hint: "Account security",
    icon: Fingerprint,
    group: "Settings",
    run: { kind: "href", href: "/settings/security" },
  },
  {
    id: "setting:picture",
    label: "Profile picture",
    hint: "Your account",
    icon: SlidersHorizontal,
    group: "Settings",
    run: { kind: "href", href: "/settings/account" },
  },
];

/** The safe, reversible verbs that need no resource picked first. */
const GLOBAL_ACTIONS: Entry[] = [
  {
    id: "action:create-app",
    label: "New app",
    icon: Plus,
    group: "Actions",
    run: { kind: "href", href: newAppHref() },
    requires: "create_apps",
  },
  {
    id: "action:create-database",
    label: "New database",
    icon: Database,
    group: "Actions",
    run: { kind: "href", href: "/storage?new=database" },
    requires: "create_databases",
  },
  {
    id: "action:add-member",
    label: "Add member",
    icon: Users,
    group: "Actions",
    run: { kind: "href", href: "/settings/members" },
    requires: "manage_members",
  },
];

/** Every page and command the palette knows without asking the server. */
export function staticEntries(): Entry[] {
  return [
    ...fromSections(NAV, (s) => s.title ?? "Navigation"),
    ...fromSections(SETTINGS_NAV, (s) =>
      s.title ? `Settings · ${s.title}` : "Settings",
    ),
    ...SETTINGS_EXTRAS,
    ...GLOBAL_ACTIONS,
  ];
}

/**
 * What the palette assumes about an app it is not standing inside. Tabs gated by
 * a CAPABILITY stay on (the server is the real gate, and per-app capabilities
 * are unknowable here); tabs behind a FEATURE SWITCH stay off, because with the
 * switch closed those pages are dead ends.
 */
export const PALETTE_APP_FLAGS: AppNavFlags = {
  pathname: "",
  canManageEnv: true,
  canBackup: true,
  running: false,
  showFiles: false,
  isGithubApp: false,
  previewsEnabled: false,
  cronsEnabled: false,
  consoleEnabled: false,
};

export const PALETTE_DB_FLAGS = {
  pathname: "",
  consoleAcknowledged: false,
  cronsEnabled: false,
};

interface ActionSpec {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  requires: Capability;
  query: string;
  success: string;
}

/**
 * deplo's app-level verbs. There is no `restartApp` - Reload re-applies routing,
 * and a full restart is Stop then Start.
 */
export const APP_ACTIONS: ActionSpec[] = [
  {
    id: "redeploy",
    label: "Redeploy",
    icon: RotateCw,
    requires: "deploy_apps",
    query: `mutation($id: String!) { redeploy(appId: $id) { id } }`,
    success: "Redeploy started",
  },
  {
    id: "start",
    label: "Start",
    icon: Play,
    requires: "control_apps",
    query: `mutation($id: String!) { startApp(id: $id) { id } }`,
    success: "App started",
  },
  {
    id: "stop",
    label: "Stop",
    icon: Square,
    requires: "control_apps",
    query: `mutation($id: String!) { stopApp(id: $id) { id } }`,
    success: "App stopped",
  },
  {
    id: "reload",
    label: "Reload",
    icon: RefreshCw,
    requires: "control_apps",
    query: `mutation($id: String!) { reloadApp(id: $id) }`,
    success: "Routing reloaded",
  },
];

export const DB_ACTIONS: ActionSpec[] = [
  {
    id: "redeploy",
    label: "Redeploy",
    icon: RotateCw,
    requires: "control_databases",
    query: `mutation($id: String!) { redeployDatabase(id: $id) { id } }`,
    success: "Redeploy started",
  },
  {
    id: "restart",
    label: "Restart",
    icon: RefreshCw,
    requires: "control_databases",
    query: `mutation($id: String!) { restartDatabase(id: $id) { id } }`,
    success: "Database restarted",
  },
];

const actionEntries = (specs: ActionSpec[], targetId: string): Entry[] =>
  specs.map((a) => ({
    id: `action:${a.id}:${targetId}`,
    label: a.label,
    icon: a.icon,
    group: "Actions",
    run: {
      kind: "mutation" as const,
      query: a.query,
      variables: { id: targetId },
      success: a.success,
    },
    requires: a.requires,
  }));

export interface FrameApp {
  id: string;
  slug: string;
  name: string;
  productionUrl?: string | null;
}

/** An app's own menu: what you can do to it, then where you can go in it. */
export function appFrameEntries(
  app: FrameApp,
  flags: AppNavFlags = PALETTE_APP_FLAGS,
): Entry[] {
  const url = app.productionUrl;
  return [
    ...actionEntries(APP_ACTIONS, app.id),
    ...(url
      ? [
          {
            id: `action:open:${app.id}`,
            label: "Open in a new tab",
            hint: url,
            icon: ExternalLink,
            group: "Actions",
            run: { kind: "href" as const, href: url, newTab: true },
          },
          {
            id: `action:copy-url:${app.id}`,
            label: "Copy URL",
            icon: Copy,
            group: "Actions",
            run: { kind: "copy" as const, text: url },
          },
        ]
      : []),
    ...byDestination([
      ...fromSections(
        appNav(app.slug, flags),
        () => "Pages",
        `app:${app.slug}`,
      ),
      ...fromSections(
        appSettingsNav(app.slug, flags.isGithubApp),
        () => "Settings",
        `app:${app.slug}`,
      ),
    ]),
  ];
}

export interface FrameDatabase {
  id: string;
  name: string;
  type: DatabaseType;
}

export function dbFrameEntries(
  db: FrameDatabase,
  flags: typeof PALETTE_DB_FLAGS = PALETTE_DB_FLAGS,
): Entry[] {
  return [
    ...actionEntries(DB_ACTIONS, db.id),
    ...byDestination([
      ...fromSections(databaseNav(db.id, flags), () => "Pages", `db:${db.id}`),
      ...fromSections(
        databaseSettingsNav(db.id),
        () => "Settings",
        `db:${db.id}`,
      ),
    ]),
  ];
}

/**
 * Rank the catalogue against what was typed: a label that starts with it beats a
 * word inside the label, which beats anything else in the label, which beats the
 * hint. `sort` is stable, so ties keep catalogue order.
 */
export function matchEntries(entries: Entry[], query: string): Entry[] {
  const needle = foldQuery(query);
  if (!needle) return entries;
  const scored: [Entry, number][] = [];
  for (const entry of entries) {
    const label = foldQuery(entry.label);
    const score = label.startsWith(needle)
      ? 3
      : entry.label.split(/\s+/).some((w) => foldQuery(w).startsWith(needle))
        ? 2
        : label.includes(needle)
          ? 1
          : entry.hint && foldQuery(entry.hint).includes(needle)
            ? 0
            : -1;
    if (score >= 0) scored.push([entry, score]);
  }
  return scored.sort((a, b) => b[1] - a[1]).map(([entry]) => entry);
}
