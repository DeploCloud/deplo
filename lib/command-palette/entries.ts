import type { ComponentType } from "react";
import {
  Fingerprint,
  KeyRound,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
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
 * Every page the palette can reach that is NOT a search result. Derived from
 * nav-config wherever nav-config already spells the label, so the two can never
 * disagree. Every row is a destination: the palette navigates, it never acts.
 */

/** The resource a page belongs to, when it is not a page of Deplo itself. */
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
  /** Words people type for this that its own label and description do not say. */
  keywords?: string;
  icon: ComponentType<{ className?: string }>;
  group: string;
  href: string;
  /**
   * Whose page this is. The row then wears the resource's own logo with
   * {@link Entry.icon} badged onto it, so "deplo-web's Variables" cannot be
   * mistaken for Deplo's own.
   */
  owner?: EntryOwner;
  /**
   * Folded text naming {@link Entry.owner}, computed once when the row is built.
   * Two apps may share a display name - the same app in two environments - so
   * this cannot be looked up by name at match time.
   */
  ownerSearch?: string[];
  /**
   * The team this page belongs to, when it is not the active one. Choosing it
   * switches team first, the same way a cross-team search hit does.
   */
  team?: { id: string; name: string; avatarUrl?: string | null };
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
    if (seen.has(entry.href)) return false;
    seen.add(entry.href);
    return true;
  });
}

/**
 * What a nav row is missing to be findable. Measured, not guessed: each of these
 * is a word that reached nothing while its page sat right there.
 */
const EXTRA_KEYWORDS: Record<string, string> = {
  "/settings/security": "2fa totp otp mfa webauthn",
  "/settings/account": "avatar picture profile",
  "/settings/notifications": "smtp alert",
  "/settings/registries": "registry ghcr dockerhub image pull",
  "/settings/servers": "cleanup prune disk fleet agent",
  "/settings/roles": "permission permissions capability access",
  "/settings/tokens": "apikey bearer cli automation",
  "/settings/migrations": "import migrate move",
  "/deployments": "rollback release build history",
};

/**
 * The same, for a page that belongs to an app or a database: their hrefs carry
 * the slug, so these are keyed on what comes after it.
 */
const EXTRA_KEYWORDS_BY_TAB: Record<string, string> = {
  "/domains": "ssl tls https certificate dns route",
  "/deployments": "build rollback release history",
  "/console": "shell terminal exec command",
  "/settings/storage": "volume mount disk file",
  "/settings/resources": "cpu memory ram limit quota",
  "/settings/connection": "connection string uri host port password",
};

/** What a nav item is findable by beyond its own words, whatever page it is. */
function keywordsFor(href: string): string | undefined {
  const own = EXTRA_KEYWORDS[href];
  if (own) return own;
  const tab =
    href.match(/^\/apps\/[^/]+(\/.+)$/) ??
    href.match(/^\/storage\/databases\/[^/]+(\/.+)$/);
  return tab ? EXTRA_KEYWORDS_BY_TAB[tab[1]!] : undefined;
}

function toEntry(item: NavItem, group: string, idPrefix: string): Entry {
  return {
    id: `${idPrefix}:${item.href}`,
    label: item.label,
    hint: item.tooltip,
    keywords: keywordsFor(item.href),
    icon: item.icon,
    group,
    href: item.href,
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
    keywords: "password credentials sign in",
    label: "Change password",
    hint: "Account security",
    icon: KeyRound,
    group: "Settings",
    href: "/settings/security",
  },
  {
    id: "setting:2fa",
    keywords: "2fa totp otp mfa authenticator",
    label: "Two-factor authentication",
    hint: "Account security",
    icon: ShieldCheck,
    group: "Settings",
    href: "/settings/security",
  },
  {
    id: "setting:passkeys",
    keywords: "passkey webauthn fido security key",
    label: "Passkeys",
    hint: "Account security",
    icon: Fingerprint,
    group: "Settings",
    href: "/settings/security",
  },
  {
    id: "setting:picture",
    keywords: "avatar photo profile",
    label: "Profile picture",
    hint: "Your account",
    icon: SlidersHorizontal,
    group: "Settings",
    href: "/settings/account",
  },
];

/** The wizard has no nav row of its own, and it is the product's main verb. */
const NEW_APP: Entry = {
  id: "page:new-app",
  label: "New app",
  keywords: "create add deploy",
  icon: Plus,
  group: "Navigation",
  href: newAppHref(),
  requires: "create_apps",
};

/** Every page the palette knows without asking the server. */
export function staticEntries(): Entry[] {
  return [
    ...fromSections(NAV, (s) => s.title ?? "Navigation"),
    ...fromSections(SETTINGS_NAV, (s) =>
      s.title ? `Settings · ${s.title}` : "Settings",
    ),
    ...SETTINGS_EXTRAS,
    NEW_APP,
  ];
}

/**
 * The Team section of the settings menu, once per team the caller can reach.
 * Account is one person's and System is the whole instance's, so neither is
 * copied - saying "Security, in team Acme" would be a lie.
 */
export function teamPageEntries(
  teams: { id: string; name: string; avatarUrl?: string | null }[],
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
        team: { id: t.id, name: t.name, avatarUrl: t.avatarUrl ?? null },
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

/** Where you can go inside one app. Shared with {@link ownedPageEntries}. */
export function appPageEntries(
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

/** Where you can go inside one database. Shared with {@link ownedPageEntries}. */
export function dbPageEntries(
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
  /** The tabs this app has switched on. Absent ⇒ assume none of them. */
  features?: { pullRequests: boolean; cronJobs: boolean; console: boolean };
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
    // The app's REAL switches, so a console someone turned on is reachable and
    // one nobody did is not offered. `running` is deliberately true: it is live
    // state the breadcrumb has no business carrying, and the console page says
    // "not running" better than a missing row does.
    const flags: AppNavFlags = {
      ...PALETTE_APP_FLAGS,
      running: true,
      isGithubApp: app.features?.pullRequests ?? false,
      previewsEnabled: app.features?.pullRequests ?? false,
      cronsEnabled: app.features?.cronJobs ?? false,
      consoleEnabled: app.features?.console ?? false,
    };
    const ownerSearch = [app.name, app.slug].map(foldQuery).filter(Boolean);
    for (const page of appPageEntries(app.slug, flags)) {
      out.push({
        ...page,
        id: `owned:${app.id}:${page.id}`,
        owner,
        ownerSearch,
      });
    }
  }
  for (const db of databases) {
    const owner: EntryOwner = {
      kind: "database",
      name: db.name,
      logo: db.logo ?? null,
      type: db.type as DatabaseType,
    };
    const ownerSearch = [foldQuery(db.name)].filter(Boolean);
    for (const page of dbPageEntries(db.id)) {
      out.push({
        ...page,
        id: `owned:${db.id}:${page.id}`,
        owner,
        ownerSearch,
      });
    }
  }
  return out;
}

/**
 * `deployments` lists every app's Deployments page; `Deplo variables` narrows to
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
  const ownerWords = new Set<string>();
  for (const entry of entries) {
    if (!entry.ownerSearch) continue;
    for (const word of words) {
      if (entry.ownerSearch.some((piece) => piece.includes(word))) {
        ownerWords.add(word);
      }
    }
  }

  const out: Entry[] = [];
  for (const entry of entries) {
    if (!entry.owner) continue;
    const owner = entry.ownerSearch ?? [];
    // A word that IS one of the page's words names the page even when a
    // resource happens to be called that too - otherwise one app named "logs"
    // would stop `logs` reaching any app's Logs page, for everyone.
    const { pieces, exact } = searchable(entry);
    let namesPage = false;
    let covered = true;
    for (const word of words) {
      const hitOwner = owner.some((piece) => piece.includes(word));
      const hitPage =
        exact.has(word) ||
        (!ownerWords.has(word) && pieces.some((p) => p.includes(word)));
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

/**
 * Everything a row can be found by, as separate folded WORDS. Folding the whole
 * thing into one string invents words across the joins - "access login" becomes
 * "...accesslogin...", which answers to "ssl" - while a hyphen inside one word
 * still folds away, so "better auth" keeps finding `better-auth-docs`.
 */
interface Searchable {
  pieces: string[];
  /** The same, as a set: a term that IS one of them names the page outright. */
  exact: ReadonlySet<string>;
}

// Keyed on the row itself, which is rebuilt only when the team snapshot
// changes - so a fleet's worth of rows is folded once, not on every keystroke.
const folded = new WeakMap<Entry, Searchable>();

function searchable(entry: Entry): Searchable {
  const hit = folded.get(entry);
  if (hit) return hit;
  const pieces = (
    `${entry.label} ${entry.hint ?? ""} ${entry.keywords ?? ""} ${entry.group}` +
    capabilityText(entry)
  )
    .split(/\s+/)
    .map(foldQuery)
    .filter(Boolean);
  const made = { pieces, exact: new Set(pieces) };
  folded.set(entry, made);
  return made;
}

const searchPieces = (entry: Entry): string[] => searchable(entry).pieces;

/** Does every word the person typed land in one of `pieces`? */
const covers = (pieces: string[], terms: string[]): boolean =>
  terms.every((term) => pieces.some((piece) => piece.includes(term)));

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
    if (!covers(searchPieces(entry), terms)) continue;
    // Ranked on the first word: what you started typing is what you meant.
    scored.push([entry, rankTerm(entry, terms[0]!)]);
  }
  // `sort` is stable, so ties keep catalogue order.
  return scored.sort((a, b) => b[1] - a[1]).map(([entry]) => entry);
}
