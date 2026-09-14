import type { ComponentType } from "react";
import {
  Fingerprint,
  KeyRound,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";

import {
  appNav,
  appSettingsNav,
  type AppNavFlags,
} from "@/components/layout/nav-config/app-nav";
import {
  databaseNav,
  databaseSettingsNav,
} from "@/components/layout/nav-config/database-nav";
import { NAV } from "@/components/layout/nav-config/main-nav";
import type {
  NavItem,
  NavSection,
} from "@/components/layout/nav-config/nav-item";
import { SETTINGS_NAV } from "@/components/layout/nav-config/settings-nav";
import { CAPABILITY_META } from "@/lib/capabilities";
import { foldQuery } from "@/lib/match-query";
import { newAppHref } from "@/lib/overview-links";
import type { DatabaseType } from "@/lib/types/database";
import type { Capability } from "@/lib/types/identity";

// The resource a page belongs to, when it is not a page of Deplo itself.
export type EntryOwner =
  | {
      kind: "app";
      name: string;
      slug: string;
      logo: string | null;
    }
  | { kind: "database"; name: string; logo: string | null; type: DatabaseType };

export interface Entry {
  // cmdk's `value` and the recents key: unique, opaque, stable.
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon: ComponentType<{ className?: string }>;
  group: string;
  href: string;
  owner?: EntryOwner;
  // Two apps may share a display name, so this cannot be looked up by name at match time.
  ownerSearch?: string[];
  // Set ⇒ choosing this row switches team first, the way a cross-team search hit does.
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
      .filter((item) => !item.back && !item.disabledReason)
      .map((item) => toEntry(item, group(section), idPrefix)),
  );
}

// An app's two navigations overlap and not every "Back to" row is flagged, so two rows can share one URL.
function byDestination(entries: Entry[]): Entry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.href)) return false;
    seen.add(entry.href);
    return true;
  });
}

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

const EXTRA_KEYWORDS_BY_TAB: Record<string, string> = {
  "/domains": "ssl tls https certificate dns route",
  "/deployments": "build rollback release history",
  "/console": "shell terminal exec command",
  "/settings/storage": "volume mount disk file",
  "/settings/resources": "cpu memory ram limit quota",
  "/settings/connection": "connection string uri host port password",
};

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

// The wizard has no nav row of its own.
const NEW_APP: Entry = {
  id: "page:new-app",
  label: "New app",
  keywords: "create add deploy",
  icon: Plus,
  group: "Navigation",
  href: newAppHref(),
  requires: "create_apps",
};

// Every page the palette knows without asking the server.
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

// Only the Team section: Account is one person's and System the whole instance's, so neither is copied per team.
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

// Capability-gated tabs stay on (the server is the real gate); feature-switch tabs stay off.
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

// Where you can go inside one app.
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

// Where you can go inside one database.
export function dbPageEntries(
  id: string,
  flags: typeof PALETTE_DB_FLAGS = PALETTE_DB_FLAGS,
): Entry[] {
  return byDestination([
    ...fromSections(databaseNav(id, flags), () => "Pages", `db:${id}`),
    ...fromSections(databaseSettingsNav(id), () => "Settings", `db:${id}`),
  ]);
}

// What the palette knows about a resource without asking the server.
export interface KnownApp {
  id: string;
  slug: string;
  name: string;
  logo?: string | null;
  features?: { pullRequests: boolean; cronJobs: boolean; console: boolean };
}

export interface KnownDatabase {
  id: string;
  name: string;
  type: string;
  logo?: string | null;
}

// Every page of every app and database, as one flat list, built once per team snapshot.
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
    // `running` is deliberately true: it is live state the breadcrumb has no business carrying.
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

// At least one word must name the PAGE, or typing an app's name buries the app under its own pages.
export function matchOwnedPages(
  entries: Entry[],
  query: string,
  limit = 6,
): Entry[] {
  const words = queryTerms(query);
  if (words.length === 0) return [];

  // "deplo" is a prefix of "deployments": without this, an app's name would list every other app's Deployments page.
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
    // Otherwise one app named "logs" would stop `logs` reaching any app's Logs page, for everyone.
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
  return out
    .sort(
      // `sort` is stable, so ties keep catalogue order - the order the apps are in.
      (a, b) => Number(a.group === "Settings") - Number(b.group === "Settings"),
    )
    .slice(0, limit);
}

// How many owned pages the query would reach if nothing were capped.
export function countOwnedPages(entries: Entry[], query: string): number {
  return matchOwnedPages(entries, query, Number.POSITIVE_INFINITY).length;
}

// Split what was typed into the words it is made of, folded.
export function queryTerms(query: string): string[] {
  return query.trim().split(/\s+/).map(foldQuery).filter(Boolean);
}

// Descriptions stay out: they are sentences, and would match on anything.
function capabilityText(entry: Entry): string {
  const caps = [entry.requires, ...(entry.requiresAny ?? [])];
  let out = "";
  for (const cap of caps) {
    const meta = cap ? CAPABILITY_META[cap as Capability] : undefined;
    if (meta) out += ` ${meta.label} ${meta.keywords ?? ""}`;
  }
  return out;
}

// Folding a row into ONE string invents words across the joins: "access login" then answers to "ssl".
interface Searchable {
  pieces: string[];
  exact: ReadonlySet<string>;
}

// Keyed on the row, which is rebuilt only when the team snapshot changes.
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

const covers = (pieces: string[], terms: string[]): boolean =>
  terms.every((term) => pieces.some((piece) => piece.includes(term)));

function rankTerm(entry: Entry, term: string): number {
  const label = foldQuery(entry.label);
  if (label.startsWith(term)) return 3;
  if (entry.label.split(/\s+/).some((w) => foldQuery(w).startsWith(term)))
    return 2;
  if (label.includes(term)) return 1;
  return 0;
}

// Folding the whole query into one needle meant "team settings" found nothing: its words live in the heading and the label separately.
export function matchEntries(entries: Entry[], query: string): Entry[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return entries;
  const scored: [Entry, number][] = [];
  for (const entry of entries) {
    if (!covers(searchPieces(entry), terms)) continue;
    scored.push([entry, rankTerm(entry, terms[0]!)]);
  }
  // `sort` is stable, so ties keep catalogue order.
  return scored.sort((a, b) => b[1] - a[1]).map(([entry]) => entry);
}
