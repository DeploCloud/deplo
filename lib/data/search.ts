import "server-only";

import { assertUser } from "../auth";
import {
  currentIdentity,
  runWithIdentity,
  type RequestIdentity,
} from "../auth/request-context";
import { foldQuery, matchRank, matchesQuery } from "../match-query";
import { getActiveTeamId } from "../membership";
import type {
  AppStatus,
  DatabaseStatus,
  DatabaseType,
  DomainStatus,
  ID,
  ServerStatus,
} from "../types";
import { listCatalog } from "@/templates/catalog";
import { listApps } from "./apps";
import { listTeamCronJobs } from "./crons";
import { listDatabases } from "./databases";
import { listDomains } from "./domains";
import { listAllEnvironmentsForTeam } from "./environments";
import { listFolders } from "./folders";
import { listMembers } from "./members";
import { listProjects } from "./projects";
import { listRoles } from "./roles";
import { listServers } from "./servers";
import { listMyTeams } from "./teams";

/**
 * Find anything in deplo by name, slug or id, across every team the caller can
 * reach. Backs the command palette and the MCP `find` tool.
 */

/** The team a hit was found in - what the caller actually asked for. */
export interface SearchTeam {
  id: ID;
  name: string;
  slug: string;
  avatarUrl: string | null;
}

/** Enough to recognise an app and to call `getApp`/`app(slug:)` next. */
export interface SearchApp {
  id: ID;
  name: string;
  slug: string;
  logo: string | null;
  status: AppStatus;
  productionUrl: string | null;
  team: SearchTeam;
}

export interface SearchDatabase {
  id: ID;
  name: string;
  logo: string | null;
  type: DatabaseType;
  status: DatabaseStatus;
  team: SearchTeam;
}

/** Servers are the one resource shared across teams, so a hit names no team. */
export interface SearchServer {
  id: ID;
  name: string;
  host: string;
  status: ServerStatus;
}

export interface SearchProject {
  id: ID;
  name: string;
  slug: string;
  appCount: number;
  team: SearchTeam;
}

export interface SearchEnvironment {
  id: ID;
  name: string;
  slug: string;
  kind: string;
  projectId: ID;
  projectName: string;
  team: SearchTeam;
}

export interface SearchFolder {
  id: ID;
  name: string;
  appCount: number;
  team: SearchTeam;
}

export interface SearchDomain {
  id: ID;
  name: string;
  appSlug: string;
  appName: string;
  status: DomainStatus;
  team: SearchTeam;
}

export interface SearchRole {
  id: ID;
  name: string;
  description: string | null;
  memberCount: number;
  team: SearchTeam;
}

export interface SearchMember {
  userId: ID;
  name: string;
  username: string;
  roleName: string | null;
  /** Their picture, already resolved (upload, else Gravatar, else null). */
  avatarUrl: string | null;
  /** The monogram's fill, for when there is no picture. */
  avatarColor: string;
  team: SearchTeam;
}

export interface SearchCron {
  id: ID;
  name: string;
  schedule: string;
  enabled: boolean;
  targetKind: string;
  /** The App's slug or the Database's id - the deep link, either way. */
  targetRef: string;
  targetName: string;
  team: SearchTeam;
}

/** The catalogue is public and has no team. */
export interface SearchTemplate {
  slug: string;
  name: string;
  logo: string | null;
}

export interface SearchResults {
  apps: SearchApp[];
  databases: SearchDatabase[];
  servers: SearchServer[];
  projects: SearchProject[];
  environments: SearchEnvironment[];
  folders: SearchFolder[];
  domains: SearchDomain[];
  members: SearchMember[];
  roles: SearchRole[];
  cronJobs: SearchCron[];
  templates: SearchTemplate[];
}

export type SearchKind =
  | "app"
  | "database"
  | "server"
  | "project"
  | "environment"
  | "folder"
  | "domain"
  | "member"
  | "role"
  | "cron"
  | "template";

export const ALL_SEARCH_KINDS: SearchKind[] = [
  "app",
  "database",
  "server",
  "project",
  "environment",
  "folder",
  "domain",
  "member",
  "role",
  "cron",
  "template",
];

/**
 * The most results one search may answer with, per kind. The cap matters because
 * the caller with the strongest reason to search is an AI agent, and a two-letter
 * query across a big instance would otherwise return every app it can see.
 */
const MAX_HITS = 50;

const EMPTY: SearchResults = {
  apps: [],
  databases: [],
  servers: [],
  projects: [],
  environments: [],
  folders: [],
  domains: [],
  members: [],
  roles: [],
  cronJobs: [],
  templates: [],
};

/** A hit, annotated with what orders it. `home` is 0 for the active team. */
interface Ranked<T> {
  home: 0 | 1;
  rank: number;
  hit: T;
}

/**
 * Keep the rows that match, annotated with how well. {@link matchesQuery} stays
 * the gate; the rank only orders what it let through.
 */
function rank<S, T>(
  rows: S[],
  fieldsOf: (row: S) => string[],
  toHit: (row: S) => T,
  query: string,
  home: 0 | 1,
): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  for (const row of rows) {
    const fields = fieldsOf(row);
    if (!matchesQuery(query, ...fields)) continue;
    out.push({ home, rank: matchRank(query, ...fields), hit: toHit(row) });
  }
  return out;
}

/**
 * Active team first, then how well it matched. Ties keep the incoming order,
 * which is each list's own manual order - what the user already arranged.
 * `key` dedupes a row reachable from several teams (a server on `all_teams`).
 */
function top<T>(rows: Ranked<T>[], key?: (hit: T) => string): T[] {
  const sorted = rows
    .sort((a, b) => a.home - b.home || a.rank - b.rank)
    .map((r) => r.hit);
  if (!key) return sorted.slice(0, MAX_HITS);
  const seen = new Map<string, T>();
  for (const hit of sorted) if (!seen.has(key(hit))) seen.set(key(hit), hit);
  return [...seen.values()].slice(0, MAX_HITS);
}

/**
 * Run a team-scoped read as this caller, in `teamId`, answering `[]` when that
 * team refuses. A gate that throws for one kind must not cost the others.
 */
async function inTeam<T>(
  identity: RequestIdentity | null,
  userId: ID,
  teamId: ID,
  read: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await runWithIdentity(
      // The token grant rides along untouched when there is one, so a bearer
      // client stays clamped in every team it reaches. A cookie session has no
      // grant and is unclamped, exactly as it is anywhere else.
      { ...(identity ?? {}), userId, teamId },
      read,
    );
  } catch {
    return [];
  }
}

export async function search(
  query: string,
  kinds: SearchKind[] = ALL_SEARCH_KINDS,
): Promise<SearchResults> {
  if (!foldQuery(query)) return EMPTY;

  const want = new Set(kinds);
  // Resolved once, up front: React `cache()` is inert outside a render, so every
  // read below would otherwise re-resolve the session it already knows.
  const identity = currentIdentity();
  const user = await assertUser();
  const activeTeamId = await getActiveTeamId();
  // Already clamped to the teams a bearer token's scope names, so a token that
  // reaches one team searches one team.
  const teams = await listMyTeams();

  const found = await Promise.all(
    teams.map(async (t) => {
      const team: SearchTeam = {
        id: t.id,
        name: t.name,
        slug: t.slug,
        avatarUrl: t.avatarUrl,
      };
      const home: 0 | 1 = t.id === activeTeamId ? 0 : 1;
      const on = <T>(kind: SearchKind, read: () => Promise<T[]>) =>
        want.has(kind)
          ? inTeam(identity, user.id, t.id, read)
          : Promise.resolve<T[]>([]);

      const [
        apps,
        databases,
        servers,
        projects,
        environments,
        folders,
        domains,
        members,
        roles,
        crons,
      ] = await Promise.all([
        on("app", listApps),
        on("database", listDatabases),
        on("server", listServers),
        on("project", listProjects),
        on("environment", listAllEnvironmentsForTeam),
        on("folder", listFolders),
        on("domain", () => listDomains()),
        on("member", listMembers),
        on("role", listRoles),
        on("cron", listTeamCronJobs),
      ]);

      // The `teamId` check is belt and braces, and worth the line: were this ever
      // called from an RSC, the zero-arg `cache()` on the team resolution would
      // hand every branch the first team's rows, and this turns that into missing
      // results rather than another team's. Only the DTOs that carry a teamId can
      // do it - TeamEnvironment, Domain, MemberDTO and Server have none.
      const mine = <R extends { teamId: string }>(rows: R[]) =>
        rows.filter((r) => r.teamId === t.id);

      return {
        apps: rank(
          mine(apps),
          (a) => [a.name, a.slug, a.id],
          (a) => ({
            id: a.id,
            name: a.name,
            slug: a.slug,
            logo: a.logo,
            status: a.status,
            productionUrl: a.productionUrl,
            team,
          }),
          query,
          home,
        ),
        databases: rank(
          mine(databases),
          (d) => [d.name, d.id],
          (d) => ({
            id: d.id,
            name: d.name,
            logo: d.logo,
            type: d.type,
            status: d.status,
            team,
          }),
          query,
          home,
        ),
        servers: rank(
          servers,
          (s) => [s.name, s.host, s.id],
          (s) => ({ id: s.id, name: s.name, host: s.host, status: s.status }),
          query,
          home,
        ),
        projects: rank(
          mine(projects),
          (p) => [p.name, p.slug, p.id],
          (p) => ({
            id: p.id,
            name: p.name,
            slug: p.slug,
            appCount: p.appCount,
            team,
          }),
          query,
          home,
        ),
        environments: rank(
          environments,
          (e) => [e.name, e.slug, e.projectName],
          (e) => ({
            id: e.id,
            name: e.name,
            slug: e.slug,
            kind: e.kind,
            projectId: e.projectId,
            projectName: e.projectName,
            team,
          }),
          query,
          home,
        ),
        folders: rank(
          mine(folders),
          (f) => [f.name, f.id],
          (f) => ({ id: f.id, name: f.name, appCount: f.appCount, team }),
          query,
          home,
        ),
        domains: rank(
          domains,
          (d) => [d.name, d.id],
          (d) => ({
            id: d.id,
            name: d.name,
            appSlug: d.appSlug,
            appName: d.serviceName,
            status: d.status,
            team,
          }),
          query,
          home,
        ),
        members: rank(
          members,
          // Never the email: a search must not turn a name into an address.
          (m) => [m.name, m.username],
          (m) => ({
            userId: m.userId,
            name: m.name,
            username: m.username,
            roleName: m.roleName,
            avatarUrl: m.avatarUrl,
            avatarColor: m.avatarColor,
            team,
          }),
          query,
          home,
        ),
        roles: rank(
          roles,
          (r) => [r.name, r.description ?? ""],
          (r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            memberCount: r.memberCount,
            team,
          }),
          query,
          home,
        ),
        cronJobs: rank(
          mine(crons),
          (c) => [c.name, c.targetName, c.id],
          (c) => ({
            id: c.id,
            name: c.name,
            schedule: c.schedule,
            enabled: c.enabled,
            targetKind: c.targetKind,
            targetRef: c.targetRef,
            targetName: c.targetName,
            team,
          }),
          query,
          home,
        ),
      };
    }),
  );

  // The catalogue is public and identical in every team, so it is read once - and
  // a dead catalogue service must not fail the whole search.
  const templates = want.has("template")
    ? rank(
        await listCatalog().catch(() => []),
        (c) => [c.name, c.slug],
        (c) => ({ slug: c.slug, name: c.name, logo: c.logo }),
        query,
        0,
      )
    : [];

  return {
    apps: top(found.flatMap((f) => f.apps)),
    databases: top(found.flatMap((f) => f.databases)),
    // A server on `all_teams` is reachable from every team, so it would
    // otherwise come back once per team.
    servers: top(
      found.flatMap((f) => f.servers),
      (s) => s.id,
    ),
    projects: top(found.flatMap((f) => f.projects)),
    environments: top(found.flatMap((f) => f.environments)),
    folders: top(found.flatMap((f) => f.folders)),
    domains: top(found.flatMap((f) => f.domains)),
    members: top(found.flatMap((f) => f.members)),
    roles: top(found.flatMap((f) => f.roles)),
    cronJobs: top(found.flatMap((f) => f.cronJobs)),
    templates: top(templates),
  };
}
