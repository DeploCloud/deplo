import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import type { DbTx } from "../db/client";
import {
  sharedEnvVars as varsTable,
  sharedEnvVarTargets as targetsTable,
  sharedEnvVarEnvironments as envJunction,
  sharedEnvVarProjects as projJunction,
  sharedEnvVarApps as appJunction,
  apps as appsTable,
  projects as projectsTable,
  environments as environmentsTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { requireFolderCapabilityForApp } from "./folder-access";
import { appInTeam } from "./app-graph-load";
import { authorOf, loadUserIdentities } from "./user-identity";
import { encryptSecret, decryptSecret } from "../crypto";
import { ALL_ENV_TARGETS, sanitizeTargets } from "../types";
import type { EnvTarget, SharedVar, VarAuthor } from "../types";
import type { SharedVarEntry } from "../deploy/env-resolve";

/**
 * Unified SHARED variables (ADR-0010, opt-in per ADR-0012) — one individual
 * variable owned by a team, the replacement for shared-env groups,
 * environment-scoped vars, and team-global vars. A shared var carries
 * AVAILABILITY scopes (team-wide / environment[] / project[] whitelist) that say
 * which apps it is offered to, but it only ever INJECTS through an explicit
 * per-app link — nothing is added to an app the developer didn't opt into.
 * Deploy precedence is resolved in lib/deploy/env-resolve.ts. Values are
 * encryptSecret at rest and only decrypt at the deploy edge or on an explicit
 * `manage_env`-gated reveal.
 */

const MASK = "••••••••••••";
const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

/**
 * An AVAILABILITY scope of a shared var, as seen from one app: the layer through
 * which the var is offered to it (never the layer it injects through — injection
 * is always the per-app link, ADR-0012).
 */
export type SharedVarScope = "teamWide" | "environment" | "project";

/** Every author id a set of vars references, for one batched identity lookup. */
function authorIds(vars: SharedVar[]): (string | null)[] {
  return vars.flatMap((v) => [v.createdByUserId, v.updatedByUserId]);
}

/**
 * The most SPECIFIC availability scope covering one app — what the app UI shows
 * as the reason a var is suggested there. `null` when no scope covers the app
 * (the var is still linkable; scopes are suggestions, not gates).
 */
function scopeFor(m: {
  byOwnEnv: boolean;
  byProject: boolean;
  teamWide: boolean;
}): SharedVarScope | null {
  if (m.byOwnEnv) return "environment";
  if (m.byProject) return "project";
  if (m.teamWide) return "teamWide";
  return null;
}

/* ------------------------------------------------------------------ */
/* Internal loader (no auth gate) — stitch a team's vars + junctions.  */
/* ------------------------------------------------------------------ */

/** Every shared var of one team, stitched with its four junction sets. */
async function loadSharedVarsForTeam(teamId: string): Promise<SharedVar[]> {
  const db = getDb();
  const rows = await db.select().from(varsTable).where(eq(varsTable.teamId, teamId));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [targets, envs, projs, apps] = await Promise.all([
    db.select().from(targetsTable).where(inArray(targetsTable.varId, ids)),
    db.select().from(envJunction).where(inArray(envJunction.varId, ids)),
    db.select().from(projJunction).where(inArray(projJunction.varId, ids)),
    db.select().from(appJunction).where(inArray(appJunction.varId, ids)),
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
  const targetsBy = group(targets, (t) => t.varId, (t) => t.target as EnvTarget);
  const envsBy = group(envs, (e) => e.varId, (e) => e.environmentId);
  const projsBy = group(projs, (p) => p.varId, (p) => p.projectId);
  const appsBy = group(apps, (a) => a.varId, (a) => a.appId);
  return rows.map((r) => ({
    id: r.id,
    teamId: r.teamId,
    key: r.key,
    valueEnc: r.valueEnc,
    type: r.type as "plain" | "secret",
    teamWide: r.teamWide,
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
/* Reads — gated `manage_env`, scoped to the active team.              */
/* ------------------------------------------------------------------ */

export interface SharedVarDTO {
  id: string;
  key: string;
  value: string; // masked for secrets
  masked: boolean;
  type: "plain" | "secret";
  targets: EnvTarget[];
  teamWide: boolean;
  environmentIds: string[];
  projectIds: string[];
  appIds: string[];
  /** Decorations for the Shared-tab display (names never leak secret values). */
  environments: { id: string; name: string; projectName: string }[];
  projects: { id: string; name: string; slug: string }[];
  apps: { id: string; name: string; slug: string }[];
  createdBy: VarAuthor | null;
  updatedBy: VarAuthor | null;
  createdAt: string;
  updatedAt: string;
}

/** The team's projects/environments/apps keyed by id (DTO decorations). */
async function teamLookups(teamId: string): Promise<{
  environments: Map<string, { id: string; name: string; projectName: string }>;
  projects: Map<string, { id: string; name: string; slug: string }>;
  apps: Map<string, { id: string; name: string; slug: string }>;
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
      .innerJoin(projectsTable, eq(environmentsTable.projectId, projectsTable.id))
      .where(eq(projectsTable.teamId, teamId)),
    db
      .select({ id: projectsTable.id, name: projectsTable.name, slug: projectsTable.slug })
      .from(projectsTable)
      .where(eq(projectsTable.teamId, teamId)),
    db
      .select({ id: appsTable.id, name: appsTable.name, slug: appsTable.slug })
      .from(appsTable)
      .where(eq(appsTable.teamId, teamId)),
  ]);
  return {
    environments: new Map(envRows.map((e) => [e.id, e] as const)),
    projects: new Map(projRows.map((p) => [p.id, p] as const)),
    apps: new Map(appRows.map((a) => [a.id, a] as const)),
  };
}

/** Every shared variable of the active team, key-sorted, decorated for the UI. */
export async function listSharedVars(): Promise<SharedVarDTO[]> {
  const { teamId } = await requireCapability("manage_env");
  const [vars, lookups] = await Promise.all([
    loadSharedVarsForTeam(teamId),
    teamLookups(teamId),
  ]);
  // One identity query for the whole list.
  const authors = await loadUserIdentities(authorIds(vars));
  return vars
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((v) => ({
      id: v.id,
      key: v.key,
      value: v.type === "secret" ? MASK : decryptSecret(v.valueEnc),
      masked: v.type === "secret",
      type: v.type,
      targets: sanitizeTargets(v.targets),
      teamWide: v.teamWide,
      environmentIds: v.environmentIds,
      projectIds: v.projectIds,
      appIds: v.appIds,
      environments: v.environmentIds
        .map((id) => lookups.environments.get(id))
        .filter((e): e is NonNullable<typeof e> => Boolean(e)),
      projects: v.projectIds
        .map((id) => lookups.projects.get(id))
        .filter((p): p is NonNullable<typeof p> => Boolean(p)),
      apps: v.appIds
        .map((id) => lookups.apps.get(id))
        .filter((a): a is NonNullable<typeof a> => Boolean(a)),
      // Authorship is metadata, not value — safe alongside a masked `value`.
      createdBy: authorOf(v.createdByUserId, authors),
      updatedBy: authorOf(v.updatedByUserId, authors),
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    }));
}

/**
 * A shared var as seen from ONE app: whether the app has opted into it
 * (`linked` — the ONLY thing that makes it inject, ADR-0012), and whether an
 * availability scope offers it here (`inScope` + `scope`, the "suggested"
 * signal the Add-variable modal shows).
 *
 * The VALUE reads exactly as it does on the Variables page (`listSharedVars`): a
 * plain value is decrypted for a `manage_env` holder, a secret comes through as
 * the MASK. An app's own table shows the variables its next deploy will get, and a
 * shared one it can't read at all is a hole in that picture.
 */
export interface AppSharedVarDTO {
  id: string;
  key: string;
  /** Masked for secrets — a secret still has no reveal path here. */
  value: string;
  masked: boolean;
  type: "plain" | "secret";
  targets: EnvTarget[];
  /** The app has explicitly opted in — the var injects on its next deploy. */
  linked: boolean;
  /** An availability scope (team-wide / environment / project) covers this app. */
  inScope: boolean;
  /** The most specific covering scope; null when none does. */
  scope: SharedVarScope | null;
  updatedBy: VarAuthor | null;
  updatedAt: string;
}

/**
 * EVERY shared var of the team, as seen from one app: its opt-in state
 * (`linked`) and whether a scope suggests it here (`inScope`/`scope`).
 *
 * The full team set is returned — not just the in-scope ones — because scopes
 * are suggestions, not gates (ADR-0012): any team shared var can be opted into
 * from any app. Filtering to in-scope vars would strand a link-only var the
 * moment its last link is removed, and would hide everything from a top-level
 * app (no project/environment).
 */
export async function listSharedVarsForApp(
  appId: string,
): Promise<AppSharedVarDTO[]> {
  const { teamId } = await requireCapability("manage_env");
  if (!(await appInTeam(appId, teamId))) return [];
  await requireFolderCapabilityForApp(appId, "manage_env");
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
  const vars = await loadSharedVarsForTeam(teamId);
  // One identity query for every shared row on the app's Environment page.
  const authors = await loadUserIdentities(authorIds(vars));
  return vars
    .map((v) => {
      const byProject = projectId != null && v.projectIds.includes(projectId);
      const byOwnEnv =
        environmentId != null && v.environmentIds.includes(environmentId);
      const linked = v.appIds.includes(appId);
      // A covering scope only SUGGESTS the var here — injection is the link.
      const inScope = v.teamWide || byProject || byOwnEnv;
      return {
        id: v.id,
        key: v.key,
        value: v.type === "secret" ? MASK : decryptSecret(v.valueEnc),
        masked: v.type === "secret",
        type: v.type,
        targets: sanitizeTargets(v.targets),
        linked,
        inScope,
        scope: scopeFor({ byOwnEnv, byProject, teamWide: v.teamWide }),
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
 * Every (app, shared var) pair that currently injects — i.e. every per-app LINK
 * (ADR-0012: only an explicit opt-in injects) — across the team: the read-only
 * "shared" rows on the aggregate App tab. One pass over the team's shared vars
 * (no per-app query fan-out).
 */
export async function listAppliedSharedVarsByApp(): Promise<AppliedSharedVarDTO[]> {
  const { teamId } = await requireCapability("manage_env");
  const vars = await loadSharedVarsForTeam(teamId);
  // One identity query for every card on the page.
  const authors = await loadUserIdentities(authorIds(vars));
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

export async function revealSharedVar(id: string): Promise<string> {
  const { teamId } = await requireCapability("manage_env");
  const rows = await getDb()
    .select({ valueEnc: varsTable.valueEnc })
    .from(varsTable)
    .where(and(eq(varsTable.id, id), eq(varsTable.teamId, teamId)))
    .limit(1);
  if (!rows[0]) throw new Error("Not found");
  return decryptSecret(rows[0].valueEnc);
}

/* ------------------------------------------------------------------ */
/* Mutations — gated `manage_env`, scoped to the active team.          */
/* ------------------------------------------------------------------ */

/**
 * Whole-set replace of the targets junction — but ONLY when the caller sent a
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
    await tx.insert(targetsTable).values(targets.map((target) => ({ varId, target })));
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
      .values(environmentIds.map((environmentId) => ({ varId, environmentId })));
  if (projectIds.length > 0)
    await tx.insert(projJunction).values(projectIds.map((projectId) => ({ varId, projectId })));
}

/**
 * Whole-set replace of the per-app links — but ONLY when the caller sent a set.
 * `undefined` leaves the junction untouched (see `saveSharedVar`'s `appIds`).
 */
async function replaceAppLinks(
  tx: DbTx,
  varId: string,
  appIds: string[] | undefined,
): Promise<void> {
  if (!appIds) return;
  await tx.delete(appJunction).where(eq(appJunction.varId, varId));
  if (appIds.length > 0)
    await tx.insert(appJunction).values(appIds.map((appId) => ({ varId, appId })));
}

/**
 * The var's current per-app links (empty for a var that doesn't exist yet).
 * Joined to the var's team: a var id from ANOTHER team must read as "no links",
 * or the reach check below turns into a 1-bit oracle on a foreign var (it runs
 * before the in-transaction ownership probe).
 */
async function currentAppLinks(
  teamId: string,
  varId: string | undefined,
): Promise<string[]> {
  if (!varId) return [];
  const rows = await getDb()
    .select({ appId: appJunction.appId })
    .from(appJunction)
    .innerJoin(varsTable, eq(varsTable.id, appJunction.varId))
    .where(and(eq(appJunction.varId, varId), eq(varsTable.teamId, teamId)));
  return rows.map((r) => r.appId);
}

export async function saveSharedVar(input: {
  id?: string;
  key: string;
  value: string;
  type: "plain" | "secret";
  /**
   * Omitted (the UI no longer asks): a NEW var gets every runtime; an EDIT keeps
   * whatever targets the var already has — an edit must never widen them.
   */
  targets?: EnvTarget[];
  teamWide: boolean;
  environmentIds: string[];
  projectIds: string[];
  /**
   * The per-app links, as a whole set. OMITTED means "leave the links alone" —
   * that is what keeps the app-side toggle (setSharedVarAppLink) and the link-only
   * vars migration 0027 produced intact when the shared-var dialog saves a var it
   * never asked about apps for.
   */
  appIds?: string[];
}): Promise<string> {
  const { teamId, userId } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  const key = input.key.trim();
  if (!KEY_RE.test(key)) throw new Error("Invalid variable name");
  // An omitted target set defaults to every runtime on INSERT, but on UPDATE it
  // means "leave the stored targets alone" (null below) — the dialogs no longer
  // ask, and widening a legacy production-only secret to all three would inject
  // it into the dev container. Only an explicit non-empty set replaces them.
  const targets = input.targets?.length ? sanitizeTargets(input.targets) : null;

  // Keep only environments/projects/apps that belong to the active team.
  const environmentIds = await filterTeamEnvironments(teamId, input.environmentIds);
  const projectIds = await filterTeamProjects(teamId, input.projectIds);
  const appIds = input.appIds
    ? await filterTeamApps(teamId, input.appIds)
    : undefined;
  const teamWide = Boolean(input.teamWide);
  const storedLinks = await currentAppLinks(teamId, input.id);

  // Both halves of the whole-set link replace are folder-gated writes, exactly
  // like setSharedVarAppLink: ADDING a link injects this var into the app at the
  // HIGHEST deploy precedence (lib/deploy/env-resolve.ts), REMOVING one strips a
  // variable off the app's next deploy. Team-level `manage_env` is not enough for
  // an app that lives under a folder. Untouched links aren't re-authorized — the
  // save doesn't change what they reach.
  if (appIds) {
    const incoming = new Set(appIds);
    const changed = [
      ...appIds.filter((id) => !storedLinks.includes(id)),
      ...storedLinks.filter((id) => !incoming.has(id)),
    ];
    for (const appId of changed)
      await requireFolderCapabilityForApp(appId, "manage_env");
  }

  // A shared var must be shared WITH something: offered through ≥1 availability
  // scope, or linked to ≥1 app. Links count — that is exactly the shape migration
  // 0027 gives every var exploded out of a legacy shared GROUP (links, no scopes),
  // and rejecting it would make every migrated group variable permanently
  // unsavable. When the caller sends `appIds` it OWNS the link set, so only the
  // incoming set counts — the stored links are about to be replaced by it.
  const reachesByLink = appIds ? appIds.length > 0 : storedLinks.length > 0;
  if (!teamWide && environmentIds.length === 0 && projectIds.length === 0 && !reachesByLink)
    throw new Error("Share with at least one app, project, or the whole team");

  // The editor sends the MASK back unchanged when only scope/type changed on a
  // secret — keep the stored value rather than encrypting the mask string.
  const keepValue = input.value === MASK;
  let savedId = input.id ?? "";

  await getDb().transaction(async (tx) => {
    if (input.id) {
      const existing = await tx
        .select({ id: varsTable.id })
        .from(varsTable)
        .where(and(eq(varsTable.id, input.id), eq(varsTable.teamId, teamId)))
        .limit(1);
      if (!existing[0]) throw new Error("Variable not found");
      await tx
        .update(varsTable)
        .set({
          key,
          ...(keepValue ? {} : { valueEnc: encryptSecret(input.value) }),
          type: input.type,
          teamWide,
          // An edit never rewrites who created the var.
          updatedByUserId: userId,
          updatedAt: nowIso(),
        })
        .where(and(eq(varsTable.id, input.id), eq(varsTable.teamId, teamId)));
      // Whole-set replace the scope junctions (targets only if explicitly sent).
      await replaceTargets(tx, input.id, targets);
      await tx.delete(envJunction).where(eq(envJunction.varId, input.id));
      await tx.delete(projJunction).where(eq(projJunction.varId, input.id));
      await insertScopeChildren(tx, input.id, environmentIds, projectIds);
      await replaceAppLinks(tx, input.id, appIds);
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
        teamWide,
        createdByUserId: userId,
        updatedByUserId: userId,
        createdAt: now,
        updatedAt: now,
      });
      await replaceTargets(tx, id, targets ?? [...ALL_ENV_TARGETS]);
      await insertScopeChildren(tx, id, environmentIds, projectIds);
      await replaceAppLinks(tx, id, appIds);
      savedId = id;
    }
  });
  await recordActivity(
    "env",
    `Updated shared variable ${key}`,
    user.name,
    null,
    teamId,
  );
  return savedId;
}

/** Attach or detach one shared var to one app (idempotent, the per-app link). */
export async function setSharedVarAppLink(
  varId: string,
  appId: string,
  linked: boolean,
): Promise<void> {
  const { teamId, userId } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  if (!(await appInTeam(appId, teamId))) throw new Error("App not found");
  await requireFolderCapabilityForApp(appId, "manage_env");
  const v = await getDb()
    .select({ key: varsTable.key })
    .from(varsTable)
    .where(and(eq(varsTable.id, varId), eq(varsTable.teamId, teamId)))
    .limit(1);
  if (!v[0]) throw new Error("Variable not found");
  if (linked) {
    await getDb().insert(appJunction).values({ varId, appId }).onConflictDoNothing();
  } else {
    await getDb()
      .delete(appJunction)
      .where(and(eq(appJunction.varId, varId), eq(appJunction.appId, appId)));
  }
  // Linking is a scope change, so it IS a modification: stamp the author too —
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
  const { teamId } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  const rows = await getDb()
    .select({ key: varsTable.key })
    .from(varsTable)
    .where(and(eq(varsTable.id, id), eq(varsTable.teamId, teamId)))
    .limit(1);
  if (!rows[0]) throw new Error("Not found");
  // The four child sets CASCADE on the parent delete.
  await getDb()
    .delete(varsTable)
    .where(and(eq(varsTable.id, id), eq(varsTable.teamId, teamId)));
  await recordActivity(
    "env",
    `Deleted shared variable ${rows[0].key}`,
    user.name,
    null,
    teamId,
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
    .where(and(inArray(environmentsTable.id, unique), eq(projectsTable.teamId, teamId)));
  return rows.map((r) => r.id);
}

/** Keep only project ids that belong to the team. */
async function filterTeamProjects(teamId: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await getDb()
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(inArray(projectsTable.id, unique), eq(projectsTable.teamId, teamId)));
  return rows.map((r) => r.id);
}

/** Keep only app ids that belong to the team. */
async function filterTeamApps(teamId: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await getDb()
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(and(inArray(appsTable.id, unique), eq(appsTable.teamId, teamId)));
  return rows.map((r) => r.id);
}

/* ------------------------------------------------------------------ */
/* Deploy-time loader — NO auth gate (the deploy is already authorized). */
/* ------------------------------------------------------------------ */

/**
 * The shared-var entries that inject into one app for the deploy-time merge:
 * ONLY the vars the app is explicitly linked to (ADR-0012 — availability scopes
 * never inject). Entries are sorted `created_at ASC` so a key collision between
 * two linked vars resolves to the later var. Returns encrypted entries; the
 * caller decrypts at the edge.
 */
export async function loadSharedVarsForApp(
  appId: string,
): Promise<SharedVarEntry[]> {
  const db = getDb();
  const app = (
    await db
      .select({ teamId: appsTable.teamId })
      .from(appsTable)
      .where(eq(appsTable.id, appId))
      .limit(1)
  )[0];
  if (!app) return [];

  const rows = await db
    .select({
      id: varsTable.id,
      key: varsTable.key,
      valueEnc: varsTable.valueEnc,
      createdAt: varsTable.createdAt,
    })
    .from(varsTable)
    .innerJoin(appJunction, eq(appJunction.varId, varsTable.id))
    .where(and(eq(varsTable.teamId, app.teamId), eq(appJunction.appId, appId)));
  if (rows.length === 0) return [];

  const targetRows = await db
    .select()
    .from(targetsTable)
    .where(inArray(targetsTable.varId, rows.map((r) => r.id)));
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
      };
    });
}
