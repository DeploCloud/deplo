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
import { CAPABILITY_META } from "@/lib/capabilities";
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

/** The resource a page belongs to, when it is not a page of deplo itself. */
export type EntryOwner =
  | {
      kind: "app";
      name: string;
      /** Searched alongside the name, exactly as the server's own search does. */
      slug: string;
      logo: string | null;
    }
  | { kind: "database"; name: string; logo: string | null; type: DatabaseType };

export interface Entry {
  /** cmdk's `value` and the recents key: unique, opaque, stable. */
  id: string;
  label: string;
  /** The muted line at the row's right edge. */
  hint?: string;
  icon: ComponentType<{ className?: string }>;
  group: string;
  run: Run;
  /**
   * Colours the glyph. Only the verbs that act on a running container carry
   * one, and only inside that resource's own menu - so the colour means "this
   * touches the thing", never decoration.
   */
  tone?: "info" | "success" | "warning" | "violet";
  /**
   * Whose page this is. The row then wears the resource's own logo with
   * {@link Entry.icon} badged onto it, so "deplo-web's Variables" cannot be
   * mistaken for deplo's own.
   */
  owner?: EntryOwner;
  /**
   * The team this page belongs to, when it is not the active one. Choosing it
   * switches team first, the same way a cross-team search hit does.
   */
  team?: { id: string; name: string };
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
 * The Team section of the settings menu, once per team the caller can reach.
 * Account is one person's and System is the whole instance's, so neither is
 * copied - saying "Security, in team Acme" would be a lie.
 */
export function teamPageEntries(
  teams: { id: string; name: string }[],
  activeTeamId: string,
): Entry[] {
  const team = SETTINGS_NAV.find((s) => s.title === "Team");
  if (!team) return [];
  return teams
    .filter((t) => t.id !== activeTeamId)
    .flatMap((t) =>
      fromSections([team], () => "Settings", `team:${t.id}`).map((entry) => ({
        ...entry,
        hint: t.name,
        team: { id: t.id, name: t.name },
      })),
    );
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
  tone: NonNullable<Entry["tone"]>;
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
    tone: "info",
    icon: RotateCw,
    requires: "deploy_apps",
    query: `mutation($id: String!) { redeploy(appId: $id) { id } }`,
    success: "Redeploy started",
  },
  {
    id: "start",
    label: "Start",
    tone: "success",
    icon: Play,
    requires: "control_apps",
    query: `mutation($id: String!) { startApp(id: $id) { id } }`,
    success: "App started",
  },
  {
    id: "stop",
    label: "Stop",
    tone: "warning",
    icon: Square,
    requires: "control_apps",
    query: `mutation($id: String!) { stopApp(id: $id) { id } }`,
    success: "App stopped",
  },
  {
    id: "reload",
    label: "Reload",
    tone: "violet",
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
    tone: "info",
    icon: RotateCw,
    requires: "control_databases",
    query: `mutation($id: String!) { redeployDatabase(id: $id) { id } }`,
    success: "Redeploy started",
  },
  {
    id: "restart",
    label: "Restart",
    tone: "violet",
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
    tone: a.tone,
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
    ...appFramePages(app.slug, flags),
  ];
}

/** Where you can go inside one app. Shared with {@link ownedPageEntries}. */
export function appFramePages(
  slug: string,
  flags: AppNavFlags = PALETTE_APP_FLAGS,
): Entry[] {
  return byDestination([
    ...fromSections(appNav(slug, flags), () => "Pages", `app:${slug}`),
    ...fromSections(
      appSettingsNav(slug, flags.isGithubApp),
      () => "Settings",
      `app:${slug}`,
    ),
  ]);
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
  return [...actionEntries(DB_ACTIONS, db.id), ...dbFramePages(db.id, flags)];
}

/** Where you can go inside one database. Shared with {@link ownedPageEntries}. */
export function dbFramePages(
  id: string,
  flags: typeof PALETTE_DB_FLAGS = PALETTE_DB_FLAGS,
): Entry[] {
  return byDestination([
    ...fromSections(databaseNav(id, flags), () => "Pages", `db:${id}`),
    ...fromSections(databaseSettingsNav(id), () => "Settings", `db:${id}`),
  ]);
}

/* ------------------------------------------------------------------ */
/* One resource's pages, reachable without stepping into it            */
/* ------------------------------------------------------------------ */

/** What the palette knows about a resource without asking the server. */
export interface KnownApp {
  id: string;
  slug: string;
  name: string;
  logo?: string | null;
}

export interface KnownDatabase {
  id: string;
  name: string;
  type: string;
  logo?: string | null;
}

/**
 * Every page of every app and database, as one flat list. Built once per team
 * snapshot, not per keystroke: it is roughly fifteen rows per resource, and
 * {@link matchOwnedPages} is what keeps all but a handful off the screen.
 */
export function ownedPageEntries(
  apps: KnownApp[],
  databases: KnownDatabase[],
): Entry[] {
  const out: Entry[] = [];
  for (const app of apps) {
    const owner: EntryOwner = {
      kind: "app",
      name: app.name,
      slug: app.slug,
      logo: app.logo ?? null,
    };
    for (const page of appFramePages(app.slug)) {
      out.push({ ...page, id: `owned:${app.id}:${page.id}`, owner });
    }
  }
  for (const db of databases) {
    const owner: EntryOwner = {
      kind: "database",
      name: db.name,
      logo: db.logo ?? null,
      type: db.type as DatabaseType,
    };
    for (const page of dbFramePages(db.id)) {
      out.push({ ...page, id: `owned:${db.id}:${page.id}`, owner });
    }
  }
  return out;
}

/**
 * `deployments` lists every app's Deployments page; `deplo variables` narrows to
 * one app's. Pages are matched on their description as well as their name,
 * because nav-config calls that one "Environment" and nobody types that.
 *
 * At least one word must name the PAGE: without that rule, typing an app's name
 * would bury the app itself under its own fourteen pages.
 */
export function matchOwnedPages(
  entries: Entry[],
  query: string,
  limit = 6,
): Entry[] {
  const words = queryTerms(query);
  if (words.length === 0) return [];

  // A word that names ANY resource is spent naming it, for the whole query.
  // "deplo" is a prefix of "deployments", so without this rule typing an app's
  // name would list every OTHER app's Deployments page underneath it.
  const ownerText = new Map<string, string>();
  const ownerWords = new Set<string>();
  for (const entry of entries) {
    if (!entry.owner) continue;
    const key = entry.owner.name;
    let hay = ownerText.get(key);
    if (hay === undefined) {
      hay = foldQuery(
        entry.owner.kind === "app"
          ? `${entry.owner.name} ${entry.owner.slug}`
          : entry.owner.name,
      );
      ownerText.set(key, hay);
      for (const word of words) if (hay.includes(word)) ownerWords.add(word);
    }
  }

  const out: Entry[] = [];
  for (const entry of entries) {
    if (!entry.owner) continue;
    const owner = ownerText.get(entry.owner.name)!;
    const page = foldQuery(
      `${entry.label} ${entry.hint ?? ""}${capabilityText(entry)}`,
    );
    let namesPage = false;
    let covered = true;
    for (const word of words) {
      const hitOwner = owner.includes(word);
      const hitPage = !ownerWords.has(word) && page.includes(word);
      if (!hitOwner && !hitPage) {
        covered = false;
        break;
      }
      namesPage ||= hitPage;
    }
    if (covered && namesPage) out.push(entry);
  }
  // A resource's own tab before the same name buried in its settings, then
  // catalogue order - which is the order the apps themselves are in.
  return out
    .sort(
      (a, b) => Number(a.group === "Settings") - Number(b.group === "Settings"),
    )
    .slice(0, limit);
}

/**
 * How many owned pages the query would reach if nothing were capped. Feeds the
 * "show the rest" row, which has to say how many are behind it.
 */
export function countOwnedPages(entries: Entry[], query: string): number {
  return matchOwnedPages(entries, query, Number.POSITIVE_INFINITY).length;
}

/** Split what was typed into the words it is made of, folded. */
export function queryTerms(query: string): string[] {
  return query.trim().split(/\s+/).map(foldQuery).filter(Boolean);
}

/**
 * What the capability behind a row is CALLED, plus the words the catalogue
 * already lists for it. "manage mcp" reaches the MCP Server page that way, and
 * so does "claude" - the word is nowhere on the row, only in `manage_mcp`.
 * Descriptions stay out: they are sentences, and would match on anything.
 */
function capabilityText(entry: Entry): string {
  const caps = [entry.requires, ...(entry.requiresAny ?? [])];
  let out = "";
  for (const cap of caps) {
    const meta = cap ? CAPABILITY_META[cap as Capability] : undefined;
    if (meta) out += ` ${meta.label} ${meta.keywords ?? ""}`;
  }
  return out;
}

/** Everything a row can be found by, including the heading it sits under. */
const searchText = (entry: Entry) =>
  foldQuery(
    `${entry.label} ${entry.hint ?? ""} ${entry.group}${capabilityText(entry)}`,
  );

/** How well one term matched: the label first, its description last. */
function rankTerm(entry: Entry, term: string): number {
  const label = foldQuery(entry.label);
  if (label.startsWith(term)) return 3;
  if (entry.label.split(/\s+/).some((w) => foldQuery(w).startsWith(term)))
    return 2;
  if (label.includes(term)) return 1;
  return 0;
}

/**
 * Every word has to land somewhere, in any order - the same rule
 * `searchCapabilities` uses. Folding the whole query into one needle instead
 * meant "team settings" found nothing at all, because no row is called that:
 * the words live in the heading and the label separately.
 */
export function matchEntries(entries: Entry[], query: string): Entry[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return entries;
  const scored: [Entry, number][] = [];
  for (const entry of entries) {
    const hay = searchText(entry);
    if (!terms.every((t) => hay.includes(t))) continue;
    // Ranked on the first word: what you started typing is what you meant.
    scored.push([entry, rankTerm(entry, terms[0]!)]);
  }
  // `sort` is stable, so ties keep catalogue order.
  return scored.sort((a, b) => b[1] - a[1]).map(([entry]) => entry);
}
