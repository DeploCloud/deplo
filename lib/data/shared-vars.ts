// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// https://deplo.build/docs/guides/config/shared-variables

import { and, eq, exists, inArray, isNull, or } from "drizzle-orm";

import { getDb } from "../db/client";
import type { DbTx } from "../db/client";
import {
  sharedEnvVars as varsTable,
  sharedEnvVarTargets as targetsTable,
  sharedEnvVarEnvironments as envJunction,
  sharedEnvVarProjects as projJunction,
  sharedEnvVarApps as appJunction,
  sharedEnvVarTeams as teamJunction,
  apps as appsTable,
  teams as teamsTable,
  projects as projectsTable,
  environments as environmentsTable,
} from "../db/schema/control-plane";
import { assertUser, getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import {
  holdsTeamWideCapability,
  isInstanceAdmin,
  requireCapability,
  requireMembership,
  reachesWholeTeam,
  requireTeamWide,
  teamsForUser,
} from "../membership";
import { recordActivity } from "./activity";
import {
  appCapabilitiesForTeam,
  hasAppCapability,
  requireAppCapability,
} from "./node-access";
import { authorOf, loadUserIdentities } from "./user-identity";
import { encryptSecret, decryptSecret } from "../crypto";
import { ALL_ENV_TARGETS, sanitizeTargets, secretImmutable } from "../types";
import type { EnvTarget, SharedVar, VarAuthor } from "../types";
import type { SharedVarEntry } from "../deploy/env-resolve";

/**
 * Unified SHARED variables (ADR-0010, opt-in per ADR-0012, multi-team per
 * ADR-0027) - one variable, the replacement for shared-env groups,
 * environment-scoped, team-global and instance-global vars.
 */

const MASK = "••••••••••••";
const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

/**
 * An AVAILABILITY scope of a shared var, as seen from one app: the layer through
 * which the var is offered to it (never the layer it injects through - injection
 * is always the per-app link, ADR-0012).
 */
export type SharedVarScope = "teamWide" | "environment" | "project";

/** Every author id a set of vars references, for one batched identity lookup. */
function authorIds(vars: SharedVar[]): (string | null)[] {
  return vars.flatMap((v) => [v.createdByUserId, v.updatedByUserId]);
}

/**
 * The most SPECIFIC availability scope covering one app - what the app UI shows
 * as the reason a var is suggested there. `null` when no scope covers the app
 * (the var is still linkable; scopes are suggestions, not gates).
 */
function scopeFor(m: {
  byOwnEnv: boolean;
  byProject: boolean;
  /** The var reaches THIS app's team - per viewer, not a property of the row. */
  teamWide: boolean;
}): SharedVarScope | null {
  if (m.byOwnEnv) return "environment";
  if (m.byProject) return "project";
  if (m.teamWide) return "teamWide";
  return null;
}

/* ------------------------------------------------------------------ */
/* Internal loaders (no auth gate) - stitch vars + their junction sets. */
/* ------------------------------------------------------------------ */

/**
 * A team SEES a variable it owns, or one shared into it. Every READ uses this;
 * a write keeps its own `eq(teamId)`, because seeing is not editing (ADR-0027).
 */
function visibleTo(teamId: string) {
  return or(
    eq(varsTable.teamId, teamId),
    exists(
      getDb()
        .select({ one: teamJunction.varId })
        .from(teamJunction)
        .where(
          and(
            eq(teamJunction.varId, varsTable.id),
            eq(teamJunction.teamId, teamId),
          ),
        ),
    ),
  );
}

/** The variables one team SEES: owned by it, or shared into it. */
async function loadVisibleToTeam(teamId: string): Promise<SharedVar[]> {
  return stitch(
    await getDb().select().from(varsTable).where(visibleTo(teamId)),
  );
}

/**
 * Every shared variable the team SEES, by key. No auth gate: the only caller is a
 * migration import, already gated, and it needs the keys a team would DUPLICATE -
 * which includes a variable another team shared in under that name.
 */
export async function visibleSharedVarIdsByKey(
  teamId: string,
): Promise<Map<string, string>> {
  const rows = await getDb()
    .select({ id: varsTable.id, key: varsTable.key })
    .from(varsTable)
    .where(visibleTo(teamId));
  return new Map(rows.map((r) => [r.key, r.id] as const));
}

/** Stitch var rows to their five junction sets. */
async function stitch(
  rows: (typeof varsTable.$inferSelect)[],
): Promise<SharedVar[]> {
  const db = getDb();
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [targets, envs, projs, apps, teams] = await Promise.all([
    db.select().from(targetsTable).where(inArray(targetsTable.varId, ids)),
    db.select().from(envJunction).where(inArray(envJunction.varId, ids)),
    db.select().from(projJunction).where(inArray(projJunction.varId, ids)),
    db.select().from(appJunction).where(inArray(appJunction.varId, ids)),
    db.select().from(teamJunction).where(inArray(teamJunction.varId, ids)),
  ]);
  const group = <T, V>(list: T[], key: (t: T) => string, val: (t: T) => V) => {
    const m = new Map<string, V[]>();
    for (const item of list) {
      const k = key(item);
      const arr = m.get(k) ?? [];
      arr.push(val(item));
      m.set(k, arr);
    }
    return m;
  };
  const targetsBy = group(
    targets,
    (t) => t.varId,
    (t) => t.target as EnvTarget,
  );
  const envsBy = group(
    envs,
    (e) => e.varId,
    (e) => e.environmentId,
  );
  const projsBy = group(
    projs,
    (p) => p.varId,
    (p) => p.projectId,
  );
  const appsBy = group(
    apps,
    (a) => a.varId,
    (a) => a.appId,
  );
  const teamsBy = group(
    teams,
    (t) => t.varId,
    (t) => t.teamId,
  );
  return rows.map((r) => ({
    id: r.id,
    teamId: r.teamId,
    key: r.key,
    valueEnc: r.valueEnc,
    type: r.type as "plain" | "secret",
    teamIds: teamsBy.get(r.id) ?? [],
    autoInject: r.autoInject,
    environmentIds: envsBy.get(r.id) ?? [],
    projectIds: projsBy.get(r.id) ?? [],
    appIds: appsBy.get(r.id) ?? [],
    targets: targetsBy.get(r.id) ?? [],
    createdByUserId: r.createdByUserId,
    updatedByUserId: r.updatedByUserId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/* ------------------------------------------------------------------ */
/* Reads - gated `manage_env`, scoped to the active team.              */
/* ------------------------------------------------------------------ */

export interface SharedVarDTO {
  id: string;
  key: string;
  value: string; // masked for secrets
  masked: boolean;
  type: "plain" | "secret";
  targets: EnvTarget[];
  /** The variable reaches the VIEWER's team - the old team-wide sharing mode. */
  teamWide: boolean;
  /** Every team it reaches. Two or more ⇒ it injects with no link. */
  teamIds: string[];
  teams: { id: string; name: string }[];
  /** Injects into every app of every team above, with no per-app link. */
  autoInject: boolean;
  /** The owning team, or null when the instance owns it. */
  ownerTeam: { id: string; name: string } | null;
  /** The viewer's team owns it (or an instance admin owns the instance one). */
  editable: boolean;
  environmentIds: string[];
  projectIds: string[];
  appIds: string[];
  /** Decorations for the Shared-tab display (names never leak secret values). */
  environments: { id: string; name: string; projectName: string }[];
  projects: { id: string; name: string; slug: string }[];
  apps: { id: string; name: string; slug: string; logo: string | null }[];
  createdBy: VarAuthor | null;
  updatedBy: VarAuthor | null;
  createdAt: string;
  updatedAt: string;
}

/** The team's projects/environments/apps keyed by id (DTO decorations). */
async function teamLookups(teamId: string): Promise<{
  environments: Map<string, { id: string; name: string; projectName: string }>;
  projects: Map<string, { id: string; name: string; slug: string }>;
  apps: Map<
    string,
    { id: string; name: string; slug: string; logo: string | null }
  >;
}> {
  const db = getDb();
  const [envRows, projRows, appRows] = await Promise.all([
    db
      .select({
        id: environmentsTable.id,
        name: environmentsTable.name,
        projectName: projectsTable.name,
      })
      .from(environmentsTable)
      .innerJoin(
        projectsTable,
        eq(environmentsTable.projectId, projectsTable.id),
      )
      .where(eq(projectsTable.teamId, teamId)),
    db
      .select({
        id: projectsTable.id,
        name: projectsTable.name,
        slug: projectsTable.slug,
      })
      .from(projectsTable)
      .where(eq(projectsTable.teamId, teamId)),
    db
      .select({
        id: appsTable.id,
        name: appsTable.name,
        slug: appsTable.slug,
        logo: appsTable.logo,
      })
      .from(appsTable)
      .where(eq(appsTable.teamId, teamId)),
  ]);
  return {
    environments: new Map(envRows.map((e) => [e.id, e] as const)),
    projects: new Map(projRows.map((p) => [p.id, p] as const)),
    apps: new Map(appRows.map((a) => [a.id, a] as const)),
  };
}

/** Every team a set of vars names, for the owner badge and the Teams chips. */
async function teamNames(
  vars: SharedVar[],
): Promise<Map<string, { id: string; name: string }>> {
  const ids = [
    ...new Set(vars.flatMap((v) => [...v.teamIds, v.teamId ?? ""])),
  ].filter(Boolean);
  if (ids.length === 0) return new Map();
  const rows = await getDb()
    .select({ id: teamsTable.id, name: teamsTable.name })
    .from(teamsTable)
    .where(inArray(teamsTable.id, ids));
  return new Map(rows.map((t) => [t.id, t] as const));
}

/**
 * Every shared variable the active team sees, key-sorted, decorated for the UI.
 * A variable another team owns comes back READ-ONLY and stripped of that team's
 * object graph: `editable` false, and its project/environment/app ids blanked,
 * because those name rows this team has no business enumerating.
 */
export async function listSharedVars(): Promise<SharedVarDTO[]> {
  await requireTeamWide("shared variables");
  const { teamId } = await requireCapability("manage_env");
  const [vars, lookups, admin] = await Promise.all([
    loadVisibleToTeam(teamId),
    teamLookups(teamId),
    isInstanceAdmin(),
  ]);
  // One identity query for the whole list.
  const [authors, teams] = await Promise.all([
    loadUserIdentities(authorIds(vars)),
    teamNames(vars),
  ]);
  return vars
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((v) => {
      const editable = v.teamId === teamId || (v.teamId === null && admin);
      // A foreign variable's scopes point at ITS team's rows.
      const environmentIds = editable ? v.environmentIds : [];
      const projectIds = editable ? v.projectIds : [];
      const appIds = editable ? v.appIds : [];
      // And the ROSTER is not ours either: a team that merely receives the variable
      // is told who owns it (ADR-0027 §2), not which other teams also run on it.
      const teamIds = editable
        ? v.teamIds
        : v.teamIds.filter((id) => id === teamId);
      return {
        id: v.id,
        key: v.key,
        value: v.type === "secret" ? MASK : decryptSecret(v.valueEnc),
        masked: v.type === "secret",
        type: v.type,
        targets: sanitizeTargets(v.targets),
        teamWide: v.teamIds.includes(teamId),
        teamIds,
        teams: teamIds
          .map((id) => teams.get(id))
          .filter((t): t is NonNullable<typeof t> => Boolean(t)),
        autoInject: v.autoInject,
        ownerTeam: v.teamId ? (teams.get(v.teamId) ?? null) : null,
        editable,
        environmentIds,
        projectIds,
        appIds,
        environments: environmentIds
          .map((id) => lookups.environments.get(id))
          .filter((e): e is NonNullable<typeof e> => Boolean(e)),
        projects: projectIds
          .map((id) => lookups.projects.get(id))
          .filter((p): p is NonNullable<typeof p> => Boolean(p)),
        apps: appIds
          .map((id) => lookups.apps.get(id))
          .filter((a): a is NonNullable<typeof a> => Boolean(a)),
        // Authorship is metadata, not value - safe alongside a masked `value`.
        createdBy: authorOf(v.createdByUserId, authors),
        updatedBy: authorOf(v.updatedByUserId, authors),
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      };
    });
}

/**
 * A shared var as seen from ONE app: whether the app has opted into it (`linked` -
 * the ONLY thing that makes it inject, ADR-0012), and whether an availability
 * scope offers it here (`inScope` + `scope`, the "suggested" signal the
 * Add-variable modal shows).
 */
export interface AppSharedVarDTO {
  id: string;
  key: string;
  /** Masked for secrets - a secret still has no reveal path here. */
  value: string;
  masked: boolean;
  type: "plain" | "secret";
  targets: EnvTarget[];
  /** The app has explicitly opted in - the var injects on its next deploy. */
  linked: boolean;
  /** An availability scope (team-wide / environment / project) covers this app. */
  inScope: boolean;
  /**
   * It lands in this app with NO link and cannot be removed here: another team
   * shares it, or an instance admin does (ADR-0027). Read-only in the app UI.
   */
  autoInject: boolean;
  /** The team that owns an auto-injected variable, for the read-only row. */
  ownerTeamName: string | null;
  /** The most specific covering scope; null when none does. */
  scope: SharedVarScope | null;
  updatedBy: VarAuthor | null;
  updatedAt: string;
}

/**
 * EVERY shared var of the team, as seen from one app: its opt-in state (`linked`)
 * and whether a scope suggests it here (`inScope`/`scope`).
 */
/**
 * Whether one shared var pertains to one app: linked to it, or suggested by a
 * project or environment the app lives in.
 */
function reachableFromApp(
  v: {
    appIds: string[];
    projectIds: string[];
    environmentIds: string[];
    autoInject: boolean;
    teamIds: string[];
  },
  app: {
    appId: string;
    teamId: string;
    projectId: string | null;
    environmentId: string | null;
  },
): boolean {
  return (
    v.appIds.includes(app.appId) ||
    (app.projectId != null && v.projectIds.includes(app.projectId)) ||
    (app.environmentId != null &&
      v.environmentIds.includes(app.environmentId)) ||
    // A variable that lands in this container with no link of its own must not be
    // invisible to the one person allowed to see the app's variables. A team-wide
    // one that does NOT auto-inject stays hidden on purpose - see authz-escape.test.
    (v.autoInject && v.teamIds.includes(app.teamId))
  );
}

export async function listSharedVarsForApp(
  appId: string,
): Promise<AppSharedVarDTO[]> {
  const { teamId } = await requireMembership();
  if (!(await hasAppCapability(appId, "manage_env"))) return [];
  const app = (
    await getDb()
      .select({
        projectId: appsTable.projectId,
        environmentId: appsTable.environmentId,
      })
      .from(appsTable)
      .where(eq(appsTable.id, appId))
      .limit(1)
  )[0];
  const projectId = app?.projectId ?? null;
  const environmentId = app?.environmentId ?? null;
  const all = await loadVisibleToTeam(teamId);
  // Both principals, one rule: a narrowed token and a member on a limited role
  // reach the same part of the team, so they see the same variables.
  const vars = (await reachesWholeTeam())
    ? all
    : all.filter((v) =>
        reachableFromApp(v, { appId, teamId, projectId, environmentId }),
      );
  // One identity query for every shared row on the app's Environment page.
  const [authors, teams] = await Promise.all([
    loadUserIdentities(authorIds(vars)),
    teamNames(vars),
  ]);
  return vars
    .map((v) => {
      const byProject = projectId != null && v.projectIds.includes(projectId);
      const byOwnEnv =
        environmentId != null && v.environmentIds.includes(environmentId);
      const linked = v.appIds.includes(appId);
      const teamWide = v.teamIds.includes(teamId);
      // A covering scope only SUGGESTS the var here - injection is the link, unless
      // the variable auto-injects (ADR-0027), which needs no opt-in at all.
      const inScope = teamWide || byProject || byOwnEnv;
      return {
        id: v.id,
        key: v.key,
        value: v.type === "secret" ? MASK : decryptSecret(v.valueEnc),
        masked: v.type === "secret",
        type: v.type,
        targets: sanitizeTargets(v.targets),
        linked,
        inScope,
        autoInject: v.autoInject && teamWide,
        ownerTeamName: v.teamId ? (teams.get(v.teamId)?.name ?? null) : null,
        scope: scopeFor({ byOwnEnv, byProject, teamWide }),
        // Falls back to the creator so "Last modified" never shows a timestamp
        // with no author.
        updatedBy: authorOf(v.updatedByUserId ?? v.createdByUserId, authors),
        updatedAt: v.updatedAt,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** One opted-in shared var as seen on the aggregate App tab. */
export interface AppliedSharedVarDTO {
  appId: string;
  id: string;
  key: string;
  /** Masked for secrets, like every other variable table (see AppSharedVarDTO). */
  value: string;
  masked: boolean;
  targets: EnvTarget[];
  updatedBy: VarAuthor | null;
  updatedAt: string;
}

/**
 * Every (app, shared var) pair that currently injects - i.e. every per-app LINK
 * (ADR-0012: only an explicit opt-in injects) - across the team: the read-only
 * "shared" rows on the aggregate App tab.
 */
export async function listAppliedSharedVarsByApp(): Promise<
  AppliedSharedVarDTO[]
> {
  await requireTeamWide("shared variables");
  const { teamId } = await requireCapability("manage_env");
  const vars = await loadVisibleToTeam(teamId);
  // One identity query for every card on the page.
  const authors = await loadUserIdentities(authorIds(vars));
  // Node scope, mirroring `listAllAppEnv`: a link into an app the caller can't
  // `manage_env` is dropped instead of surfacing that app's applied rows through the
  // aggregate tab (its card is filtered out there too).
  const linkedAppIds = [...new Set(vars.flatMap((v) => v.appIds))];
  const appRows = linkedAppIds.length
    ? await getDb()
        .select({
          id: appsTable.id,
          folderId: appsTable.folderId,
          projectId: appsTable.projectId,
          environmentId: appsTable.environmentId,
        })
        .from(appsTable)
        .where(
          and(
            inArray(appsTable.id, linkedAppIds),
            eq(appsTable.teamId, teamId),
          ),
        )
    : [];
  const reach = await appCapabilitiesForTeam(teamId, appRows);
  // A var linked to SEVERAL apps repeats below, so decrypt each value once here
  // rather than once per (app, var) pair.
  const shown = new Map(
    vars.map(
      (v) =>
        [v.id, v.type === "secret" ? MASK : decryptSecret(v.valueEnc)] as const,
    ),
  );
  const out: AppliedSharedVarDTO[] = [];
  for (const v of vars) {
    for (const appId of v.appIds) {
      // A dangling/cross-team link reads as no app; an app the caller can't
      // manage_env drops the row.
      if (!reach.get(appId)?.includes("manage_env")) continue;
      out.push({
        appId,
        id: v.id,
        key: v.key,
        value: shown.get(v.id)!,
        masked: v.type === "secret",
        targets: sanitizeTargets(v.targets),
        // Falls back to the creator so "Last modified" never shows a timestamp
        // with no author.
        updatedBy: authorOf(v.updatedByUserId ?? v.createdByUserId, authors),
        updatedAt: v.updatedAt,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Mutations - gated `manage_env`, scoped to the active team.          */
/* ------------------------------------------------------------------ */

/**
 * Whole-set replace of the targets junction, but ONLY when the caller sent a
 * set. `null` leaves the stored targets untouched (see `saveSharedVar`).
 */
async function replaceTargets(
  tx: DbTx,
  varId: string,
  targets: EnvTarget[] | null,
): Promise<void> {
  if (!targets) return;
  await tx.delete(targetsTable).where(eq(targetsTable.varId, varId));
  if (targets.length > 0)
    await tx
      .insert(targetsTable)
      .values(targets.map((target) => ({ varId, target })));
}

/** Whole-set replace of a var's environment/project junctions. */
async function insertScopeChildren(
  tx: DbTx,
  varId: string,
  environmentIds: string[],
  projectIds: string[],
): Promise<void> {
  if (environmentIds.length > 0)
    await tx
      .insert(envJunction)
      .values(
        environmentIds.map((environmentId) => ({ varId, environmentId })),
      );
  if (projectIds.length > 0)
    await tx
      .insert(projJunction)
      .values(projectIds.map((projectId) => ({ varId, projectId })));
}

/** Whole-set replace of the team-reach junction. */
async function replaceTeams(
  tx: DbTx,
  varId: string,
  teamIds: string[],
): Promise<void> {
  await tx.delete(teamJunction).where(eq(teamJunction.varId, varId));
  if (teamIds.length > 0)
    await tx
      .insert(teamJunction)
      .values(teamIds.map((teamId) => ({ varId, teamId })));
}

/**
 * Whole-set replace of the per-app links, but ONLY when the caller sent a set.
 * `undefined` leaves the junction untouched (see `saveSharedVar`'s `appIds`).
 */
async function replaceAppLinks(
  tx: DbTx,
  varId: string,
  appIds: string[] | undefined,
  /** The acting team's stored links - the ONLY rows this replace may delete. */
  storedLinks: string[],
): Promise<void> {
  if (!appIds) return;
  if (storedLinks.length > 0)
    await tx
      .delete(appJunction)
      .where(
        and(
          eq(appJunction.varId, varId),
          inArray(appJunction.appId, storedLinks),
        ),
      );
  if (appIds.length > 0)
    await tx
      .insert(appJunction)
      .values(appIds.map((appId) => ({ varId, appId })));
}

/**
 * The var's per-app links IN THE ACTING TEAM. Scoped by the APP's team, never the
 * variable's owner: counting a receiving team's opt-in here made the owner's own
 * save ask for `manage_env` on an app in another team, and be refused forever.
 */
async function currentAppLinks(
  teamId: string,
  varId: string | undefined,
): Promise<string[]> {
  if (!varId) return [];
  const rows = await getDb()
    .select({ appId: appJunction.appId })
    .from(appJunction)
    .innerJoin(appsTable, eq(appsTable.id, appJunction.appId))
    .where(and(eq(appJunction.varId, varId), eq(appsTable.teamId, teamId)));
  return rows.map((r) => r.appId);
}

/** What a stored variable reaches now (all empty for one that doesn't exist yet). */
async function currentReach(varId: string | undefined): Promise<{
  teams: string[];
  environments: string[];
  projects: string[];
}> {
  if (!varId) return { teams: [], environments: [], projects: [] };
  const db = getDb();
  const [teams, environments, projects] = await Promise.all([
    db
      .select({ id: teamJunction.teamId })
      .from(teamJunction)
      .where(eq(teamJunction.varId, varId)),
    db
      .select({ id: envJunction.environmentId })
      .from(envJunction)
      .where(eq(envJunction.varId, varId)),
    db
      .select({ id: projJunction.projectId })
      .from(projJunction)
      .where(eq(projJunction.varId, varId)),
  ]);
  return {
    teams: teams.map((r) => r.id),
    environments: environments.map((r) => r.id),
    projects: projects.map((r) => r.id),
  };
}

export async function saveSharedVar(input: {
  id?: string;
  key: string;
  value: string;
  type: "plain" | "secret";
  /**
   * Omitted (the UI no longer asks): a NEW var gets every runtime; an EDIT keeps
   * whatever targets the var already has - an edit must never widen them.
   */
  targets?: EnvTarget[];
  /**
   * Every team whose apps this variable reaches. One ⇒ it is only SUGGESTED there
   * (the per-app link injects, ADR-0012); two or more ⇒ it is injected into every
   * app of every one of them, with no link, at the lowest precedence (ADR-0027).
   */
  teamIds: string[];
  environmentIds: string[];
  projectIds: string[];
  /**
   * The per-app links, as a whole set.
   */
  appIds?: string[];
}): Promise<string> {
  // A team-wide var is injected into every app in the team at the highest deploy
  // precedence, so authoring one from a project-scoped token would be that token
  // setting variables on apps outside its own boundary.
  await requireTeamWide("shared variables");
  const { teamId, userId } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  // Every OTHER team is its own gate, held across the whole of that team. The
  // refusal is the same words as an unknown id: the picker must never be an oracle
  // for which teams exist, nor for who is in them.
  const teamIds = [...new Set(input.teamIds)];
  const reach = await currentReach(input.id);
  for (const t of teamIds) {
    // Keeping a team the variable already reaches is no escalation: the gate stops
    // someone ADDING one they do not hold. Re-asking made an instance-wide variable
    // unsavable by any admin who is not a member of every team on the instance.
    if (t === teamId || reach.teams.includes(t)) continue;
    if (!(await holdsTeamWideCapability(t, "manage_env")))
      throw new Error("Team not found");
  }
  const adminHere = await isInstanceAdmin();
  const key = input.key.trim();
  if (!KEY_RE.test(key)) throw new Error("Invalid variable name");
  // An omitted target set defaults to every runtime on INSERT, but on UPDATE it means
  // "leave the stored targets alone" (null below) - the dialogs no longer ask, and
  // silently widening a legacy production-only secret would leak it into runtimes it
  // was never meant to reach.
  const targets = input.targets?.length ? sanitizeTargets(input.targets) : null;

  // Keep only environments/projects/apps that belong to the active team.
  const environmentIds = await filterTeamEnvironments(
    teamId,
    input.environmentIds,
  );
  const projectIds = await filterTeamProjects(teamId, input.projectIds);
  const appIds = input.appIds
    ? await filterTeamApps(teamId, input.appIds)
    : undefined;
  // Reaching more than one team is what makes a variable inject with no link. On an
  // EDIT the stored column decides instead (ADR-0027 §4) - see the update branch.
  const autoInject = teamIds.length > 1;
  // The teams this save takes the reach away from. The acting team is excluded: its
  // own per-app links are the `appIds` whole-set's business, not this cleanup's.
  const lostTeams = reach.teams.filter(
    (t) => t !== teamId && !teamIds.includes(t),
  );
  const storedLinks = await currentAppLinks(teamId, input.id);

  // Both halves of the whole-set link replace are folder-gated writes, exactly like
  // setSharedVarAppLink: ADDING a link injects this var into the app at the HIGHEST
  // deploy precedence (lib/deploy/env-resolve.ts), REMOVING one strips a variable off
  // the app's next deploy.
  if (appIds) {
    const incoming = new Set(appIds);
    const changed = [
      ...appIds.filter((id) => !storedLinks.includes(id)),
      ...storedLinks.filter((id) => !incoming.has(id)),
    ];
    for (const appId of changed)
      await requireAppCapability(appId, "manage_env");
  }

  // A shared var must be shared WITH something: offered through ≥1 availability
  // scope, or linked to ≥1 app.
  const reachesByLink = appIds ? appIds.length > 0 : storedLinks.length > 0;
  const reachesNothing =
    teamIds.length === 0 &&
    environmentIds.length === 0 &&
    projectIds.length === 0 &&
    !reachesByLink;
  // A variable whose only project / environment / app was DELETED already reaches
  // nothing. The rule is there to stop an authored value STRANDING; refusing the
  // next value edit as well left a row nobody could repair.
  const stranded =
    Boolean(input.id) &&
    reach.teams.length === 0 &&
    reach.environments.length === 0 &&
    reach.projects.length === 0 &&
    storedLinks.length === 0;
  if (reachesNothing && !stranded)
    throw new Error("Share with at least one app, project, or team");

  // Two variables with the same key AND the same reach are indistinguishable in the
  // table, and the newer one silently shadows the older at deploy time (created_at
  // ASC). A key that repeats across DIFFERENT scopes stays legal.
  if (!input.id) {
    const same = (a: string[], b: string[]) =>
      a.length === b.length && [...a].sort().join() === [...b].sort().join();
    const twin = (await loadVisibleToTeam(teamId)).find(
      (v) =>
        v.key === key &&
        v.teamId === teamId &&
        same(v.teamIds, teamIds) &&
        same(v.environmentIds, environmentIds) &&
        same(v.projectIds, projectIds) &&
        same(v.appIds, appIds ?? []),
    );
    if (twin)
      throw new Error(
        `${key} is already shared with the same apps, projects and teams`,
      );
  }

  // The editor sends the MASK back unchanged when only the SCOPE changed on a
  // secret - keep the stored value rather than encrypting the mask string. That
  // round-trip is the only write a secret still accepts (see the refusal below).
  const keepValue = input.value === MASK;
  let savedId = input.id ?? "";
  // Named in the OTHER teams' activity rows, so "where did this come from" is
  // answerable there without reading the owner team's trail.
  const authorTeamName =
    (
      await getDb()
        .select({ name: teamsTable.name })
        .from(teamsTable)
        .where(eq(teamsTable.id, teamId))
        .limit(1)
    )[0]?.name ?? "another team";

  await getDb().transaction(async (tx) => {
    if (input.id) {
      // OWNER-only, whatever the reach: a team that merely receives a variable
      // never edits it. An instance-owned one (team_id NULL) answers to an
      // instance admin instead.
      const owned = adminHere
        ? or(eq(varsTable.teamId, teamId), isNull(varsTable.teamId))
        : eq(varsTable.teamId, teamId);
      const existing = await tx
        .select({
          id: varsTable.id,
          key: varsTable.key,
          type: varsTable.type,
          teamId: varsTable.teamId,
          autoInject: varsTable.autoInject,
        })
        .from(varsTable)
        .where(and(eq(varsTable.id, input.id), owned))
        .limit(1);
      if (!existing[0]) throw new Error("Variable not found");
      // A secret's VALUE, KEY and TYPE are frozen; WHO it reaches is not.
      if (existing[0].type === "secret") {
        const frozen =
          key !== existing[0].key || input.type !== "secret" || !keepValue;
        if (frozen) throw new Error(secretImmutable(existing[0].key));
      }
      await tx
        .update(varsTable)
        .set({
          key,
          ...(keepValue ? {} : { valueEnc: encryptSecret(input.value) }),
          type: input.type,
          // ADR-0027 §4: the COLUMN, never the count. A reach row lost to a cascade
          // must not disarm it on the next save, and an edit must not ARM one that
          // never injected - only unticking a team it still reaches narrows it.
          autoInject:
            teamIds.length > 1 ||
            (existing[0].autoInject && lostTeams.length === 0),
          // An edit never rewrites who created the var.
          updatedByUserId: userId,
          updatedAt: nowIso(),
        })
        .where(and(eq(varsTable.id, input.id), owned));
      // Whole-set replace the scope junctions (targets only if explicitly sent).
      await replaceTargets(tx, input.id, targets);
      await tx.delete(envJunction).where(eq(envJunction.varId, input.id));
      await tx.delete(projJunction).where(eq(projJunction.varId, input.id));
      await insertScopeChildren(tx, input.id, environmentIds, projectIds);
      await replaceTeams(tx, input.id, teamIds);
      // A team that loses the reach loses its apps' opt-ins with it. Left behind, a
      // later re-share injects into those apps again - at the HIGHEST precedence,
      // with nobody in that team having asked for it.
      if (lostTeams.length > 0) {
        const theirs = await tx
          .select({ id: appsTable.id })
          .from(appsTable)
          .where(inArray(appsTable.teamId, lostTeams));
        if (theirs.length > 0)
          await tx.delete(appJunction).where(
            and(
              eq(appJunction.varId, input.id),
              inArray(
                appJunction.appId,
                theirs.map((r) => r.id),
              ),
            ),
          );
      }
      await replaceAppLinks(tx, input.id, appIds, storedLinks);
      savedId = input.id;
    } else {
      const id = newId("svar");
      const now = nowIso();
      await tx.insert(varsTable).values({
        id,
        teamId,
        key,
        valueEnc: encryptSecret(input.value),
        type: input.type,
        autoInject,
        createdByUserId: userId,
        updatedByUserId: userId,
        createdAt: now,
        updatedAt: now,
      });
      await replaceTargets(tx, id, targets ?? [...ALL_ENV_TARGETS]);
      await insertScopeChildren(tx, id, environmentIds, projectIds);
      await replaceTeams(tx, id, teamIds);
      await replaceAppLinks(tx, id, appIds, []);
      savedId = id;
    }
  });
  // One row per team it reaches, not just the author's: a variable that lands in
  // another team's apps has to be answerable on THAT team's Activity page.
  const verb = input.id ? "Updated" : "Created";
  for (const t of new Set([teamId, ...teamIds]))
    await recordActivity(
      "env",
      t === teamId
        ? `${verb} shared variable ${key}`
        : `${verb} shared variable ${key}, shared from ${authorTeamName}`,
      user.name,
      null,
      t,
    );
  return savedId;
}

/**
 * The write-side twin of the filter in {@link listSharedVarsForApp}: may a
 * narrowed caller name this variable from this app at all?
 */
async function linkableFromApp(
  varId: string,
  appId: string,
  teamId: string,
): Promise<boolean> {
  const app = (
    await getDb()
      .select({
        projectId: appsTable.projectId,
        environmentId: appsTable.environmentId,
      })
      .from(appsTable)
      .where(eq(appsTable.id, appId))
      .limit(1)
  )[0];
  const v = (await loadVisibleToTeam(teamId)).find((x) => x.id === varId);
  return (
    v != null &&
    reachableFromApp(v, {
      appId,
      teamId,
      projectId: app?.projectId ?? null,
      environmentId: app?.environmentId ?? null,
    })
  );
}

/** Attach or detach one shared var to one app (idempotent, the per-app link). */
export async function setSharedVarAppLink(
  varId: string,
  appId: string,
  linked: boolean,
): Promise<void> {
  const { teamId, userId } = await requireAppCapability(appId, "manage_env");
  const user = (await getCurrentUser())!;
  // Visible, not owned: attaching a variable another team shared with us is THIS
  // team's opt-in, not an edit of their row (ADR-0027).
  const v = await getDb()
    .select({ key: varsTable.key })
    .from(varsTable)
    .where(and(eq(varsTable.id, varId), visibleTo(teamId)))
    .limit(1);
  if (!v[0]) throw new Error("Variable not found");
  // Belonging to the team is not enough for a NARROWED caller. Same message as an
  // unknown id: a scope must never say which ids exist.
  if (
    !(await reachesWholeTeam()) &&
    !(await linkableFromApp(varId, appId, teamId))
  )
    throw new Error("Variable not found");
  if (linked) {
    await getDb()
      .insert(appJunction)
      .values({ varId, appId })
      .onConflictDoNothing();
  } else {
    await getDb()
      .delete(appJunction)
      .where(and(eq(appJunction.varId, varId), eq(appJunction.appId, appId)));
  }
  // Linking is a scope change, so it IS a modification: stamp the author too -
  // "Last modified" must never show a timestamp with nobody behind it.
  await getDb()
    .update(varsTable)
    .set({ updatedByUserId: userId, updatedAt: nowIso() })
    .where(eq(varsTable.id, varId));
  await recordActivity(
    "env",
    `${linked ? "Linked" : "Unlinked"} shared variable ${v[0].key}`,
    user.name,
    appId,
  );
}

export async function deleteSharedVar(id: string): Promise<void> {
  await requireTeamWide("shared variables");
  const { teamId } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  // OWNER-only: a team that merely receives a variable must not destroy it for
  // everyone else. An instance-owned one answers to an instance admin.
  const owned = (await isInstanceAdmin())
    ? or(eq(varsTable.teamId, teamId), isNull(varsTable.teamId))
    : eq(varsTable.teamId, teamId);
  const rows = await getDb()
    .select({ key: varsTable.key })
    .from(varsTable)
    .where(and(eq(varsTable.id, id), owned))
    .limit(1);
  if (!rows[0]) throw new Error("Not found");
  const reached = await getDb()
    .select({ teamId: teamJunction.teamId })
    .from(teamJunction)
    .where(eq(teamJunction.varId, id));
  // The five child sets CASCADE on the parent delete.
  await getDb()
    .delete(varsTable)
    .where(and(eq(varsTable.id, id), owned));
  for (const t of new Set([teamId, ...reached.map((r) => r.teamId)]))
    await recordActivity(
      "env",
      `Deleted shared variable ${rows[0].key}`,
      user.name,
      null,
      t,
    );
}

/** Keep only environment ids whose Project belongs to the team. */
async function filterTeamEnvironments(
  teamId: string,
  ids: string[],
): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await getDb()
    .select({ id: environmentsTable.id })
    .from(environmentsTable)
    .innerJoin(projectsTable, eq(environmentsTable.projectId, projectsTable.id))
    .where(
      and(
        inArray(environmentsTable.id, unique),
        eq(projectsTable.teamId, teamId),
      ),
    );
  return rows.map((r) => r.id);
}

/** Keep only project ids that belong to the team. */
async function filterTeamProjects(
  teamId: string,
  ids: string[],
): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await getDb()
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(
      and(inArray(projectsTable.id, unique), eq(projectsTable.teamId, teamId)),
    );
  return rows.map((r) => r.id);
}

/** Keep only app ids that belong to the team. */
async function filterTeamApps(
  teamId: string,
  ids: string[],
): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await getDb()
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(and(inArray(appsTable.id, unique), eq(appsTable.teamId, teamId)));
  return rows.map((r) => r.id);
}

/* ------------------------------------------------------------------ */
/* Deploy-time loaders, NO auth gate (the deploy is already authorized). */
/* ------------------------------------------------------------------ */

/** What the deploy merge reads off a var row. */
const DEPLOY_COLUMNS = {
  id: varsTable.id,
  key: varsTable.key,
  valueEnc: varsTable.valueEnc,
  // `plain` | `secret`, and it has to travel with the entry: the fork-preview drop in
  // lib/deploy/build.ts asks every layer the same question, and a column left out of
  // this projection answered "not a secret" for a team's whole shared-variable set.
  type: varsTable.type,
  createdAt: varsTable.createdAt,
} as const;

type DeployRow = {
  id: string;
  key: string;
  valueEnc: string;
  type: string;
  createdAt: string;
};

/** Stitch the targets junction on and order the layer (`created_at ASC` breaks a
 *  same-key collision within it). An empty target set means every runtime. */
async function toEntries(rows: DeployRow[]): Promise<SharedVarEntry[]> {
  if (rows.length === 0) return [];
  const targetRows = await getDb()
    .select()
    .from(targetsTable)
    .where(
      inArray(
        targetsTable.varId,
        rows.map((r) => r.id),
      ),
    );
  const targetsBy = new Map<string, EnvTarget[]>();
  for (const t of targetRows) {
    const arr = targetsBy.get(t.varId) ?? [];
    arr.push(t.target as EnvTarget);
    targetsBy.set(t.varId, arr);
  }
  return rows
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((r) => {
      const targets = targetsBy.get(r.id);
      return {
        key: r.key,
        valueEnc: r.valueEnc,
        targets: targets && targets.length ? targets : ALL_ENV_TARGETS,
        type: r.type === "secret" ? ("secret" as const) : ("plain" as const),
      };
    });
}

/** The app's team, or null when the app is gone. */
async function teamOfApp(appId: string): Promise<string | null> {
  const app = (
    await getDb()
      .select({ teamId: appsTable.teamId })
      .from(appsTable)
      .where(eq(appsTable.id, appId))
      .limit(1)
  )[0];
  return app?.teamId ?? null;
}

/**
 * The shared-var entries that inject into one app for the deploy-time merge: ONLY
 * the vars the app is explicitly linked to (ADR-0012 - availability scopes never
 * inject). Reads what the app's team SEES, so a variable another team shared here
 * and this app opted into does not silently drop at deploy time.
 */
export async function loadSharedVarsForApp(
  appId: string,
): Promise<SharedVarEntry[]> {
  const teamId = await teamOfApp(appId);
  if (!teamId) return [];
  return toEntries(
    await getDb()
      .select(DEPLOY_COLUMNS)
      .from(varsTable)
      .innerJoin(appJunction, eq(appJunction.varId, varsTable.id))
      .where(and(visibleTo(teamId), eq(appJunction.appId, appId))),
  );
}

/**
 * The shared vars that inject into one app with NO link: those reaching more than
 * one team, and the instance-owned ones (ADR-0027). They fold at the LOWEST
 * precedence - exactly the slot instance globals held - so an app's own value
 * always wins over one it never asked for.
 */
export async function loadAutoInjectedVarsForApp(
  appId: string,
): Promise<SharedVarEntry[]> {
  const teamId = await teamOfApp(appId);
  if (!teamId) return [];
  return toEntries(
    await getDb()
      .select(DEPLOY_COLUMNS)
      .from(varsTable)
      .innerJoin(teamJunction, eq(teamJunction.varId, varsTable.id))
      .where(
        and(eq(varsTable.autoInject, true), eq(teamJunction.teamId, teamId)),
      ),
  );
}

/**
 * The teams the current author may share a variable with: their own, minus the
 * ones where they do not hold `manage_env` across the WHOLE team. Advisory - the
 * save re-checks every id with the same predicate.
 */
export async function listSharedVarTeams(): Promise<
  { id: string; name: string; avatarUrl: string | null }[]
> {
  const user = await assertUser();
  const teams = await teamsForUser(user.id);
  const allowed = await Promise.all(
    teams.map((t) => holdsTeamWideCapability(t.id, "manage_env")),
  );
  return teams
    .filter((_, i) => allowed[i])
    .map((t) => ({ id: t.id, name: t.name, avatarUrl: t.avatarUrl }));
}
