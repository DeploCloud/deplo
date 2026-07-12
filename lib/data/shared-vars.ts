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
import { encryptSecret, decryptSecret } from "../crypto";
import { ALL_ENV_TARGETS } from "../types";
import type { EnvTarget, SharedVar } from "../types";
import type { SharedVarEntry, SharedVarMode } from "../deploy/env-resolve";

/**
 * Unified SHARED variables (ADR-0010) — one individual variable owned by a team,
 * the replacement for shared-env groups, environment-scoped vars, and team-global
 * vars. A shared var reaches an app through any of three sharing MODES
 * (team-wide / environment[] / project[] whitelist) plus a per-app link. Which
 * apps a var reaches, and in what deploy precedence, is resolved in
 * lib/deploy/env-resolve.ts. Values are encryptSecret at rest and only decrypt at
 * the deploy edge or on an explicit `manage_env`-gated reveal.
 */

const MASK = "••••••••••••";
const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

/** Keep only valid, deduped targets; fall back to all three if none survive. */
function sanitizeTargets(targets: EnvTarget[]): EnvTarget[] {
  const allowed = new Set(ALL_ENV_TARGETS);
  const kept = ALL_ENV_TARGETS.filter((t) => targets.includes(t) && allowed.has(t));
  return kept.length ? kept : ALL_ENV_TARGETS;
}

/**
 * The layer a shared var injects into one app through, in DEPLOY PRECEDENCE order
 * (lib/deploy/env-resolve.ts): a per-app link is the highest layer, so it wins the
 * badge over any mode. Meaningless when the var doesn't apply — callers gate the
 * badge on `applied`.
 */
function viaFor(m: {
  linked: boolean;
  byProject: boolean;
  byOwnEnv: boolean;
  teamWide: boolean;
}): SharedVarMode {
  if (m.linked) return "link";
  if (m.byProject) return "project";
  if (m.byOwnEnv) return "environment";
  return "teamWide";
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
      updatedAt: v.updatedAt,
    }));
}

/**
 * A shared var as seen from ONE app: whether it reaches the app, how, and its
 * per-app link toggle state. Values are never decrypted here. `inherited` marks a
 * var applied through a sharing MODE (the toggle can't turn it off from the app);
 * `linked` is the explicit per-app link state.
 */
export interface AppSharedVarDTO {
  id: string;
  key: string;
  masked: boolean;
  type: "plain" | "secret";
  targets: EnvTarget[];
  via: SharedVarMode;
  applied: boolean;
  inherited: boolean;
  linked: boolean;
}

/**
 * EVERY shared var of the team, as seen from one app: whether it currently
 * injects (`applied`), through which layer (`via`), whether that is a MODE the
 * app can't switch off (`inherited`), and its per-app link state (`linked`).
 *
 * The full team set is returned — not just the in-scope ones — because the app
 * modal's per-app LINK is the escape hatch for attaching an EXTRA shared var to
 * one app (one that no mode already covers). Filtering to in-scope vars would
 * make that impossible for a top-level app (no project/environment) and would
 * strand a link-only var the moment its last link is removed.
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
  return vars
    .map((v) => {
      const byProject = projectId != null && v.projectIds.includes(projectId);
      const byOwnEnv =
        environmentId != null && v.environmentIds.includes(environmentId);
      const linked = v.appIds.includes(appId);
      // A MODE applies → the app can't switch it off from here.
      const inherited = v.teamWide || byProject || byOwnEnv;
      return {
        id: v.id,
        key: v.key,
        masked: v.type === "secret",
        type: v.type,
        targets: sanitizeTargets(v.targets),
        // The layer it actually injects through, in deploy precedence order
        // (a per-app link is the HIGHEST layer — see lib/deploy/env-resolve.ts).
        via: viaFor({ linked, byProject, byOwnEnv, teamWide: v.teamWide }),
        applied: inherited || linked,
        inherited,
        linked,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** One applied shared var as seen on the aggregate App tab (no values). */
export interface AppliedSharedVarDTO {
  appId: string;
  id: string;
  key: string;
  masked: boolean;
  via: SharedVarMode;
  targets: EnvTarget[];
}

/**
 * Every (app, shared var) pair that currently injects, across the team — the
 * read-only "shared" rows on the aggregate App tab. One pass over the team's
 * shared vars and apps (no per-app query fan-out). Values are never decrypted.
 */
export async function listAppliedSharedVarsByApp(): Promise<AppliedSharedVarDTO[]> {
  const { teamId } = await requireCapability("manage_env");
  const [vars, apps] = await Promise.all([
    loadSharedVarsForTeam(teamId),
    getDb()
      .select({
        id: appsTable.id,
        projectId: appsTable.projectId,
        environmentId: appsTable.environmentId,
      })
      .from(appsTable)
      .where(eq(appsTable.teamId, teamId)),
  ]);
  const out: AppliedSharedVarDTO[] = [];
  for (const app of apps) {
    for (const v of vars) {
      const byProject = app.projectId != null && v.projectIds.includes(app.projectId);
      const byEnv =
        app.environmentId != null && v.environmentIds.includes(app.environmentId);
      const linked = v.appIds.includes(app.id);
      if (!(v.teamWide || byProject || byEnv || linked)) continue;
      out.push({
        appId: app.id,
        id: v.id,
        key: v.key,
        masked: v.type === "secret",
        via: viaFor({ linked, byProject, byOwnEnv: byEnv, teamWide: v.teamWide }),
        targets: sanitizeTargets(v.targets),
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

/** Whole-set replace of a var's target/environment/project junctions. */
async function insertScopeChildren(
  tx: DbTx,
  varId: string,
  targets: EnvTarget[],
  environmentIds: string[],
  projectIds: string[],
): Promise<void> {
  if (targets.length > 0)
    await tx.insert(targetsTable).values(targets.map((target) => ({ varId, target })));
  if (environmentIds.length > 0)
    await tx
      .insert(envJunction)
      .values(environmentIds.map((environmentId) => ({ varId, environmentId })));
  if (projectIds.length > 0)
    await tx.insert(projJunction).values(projectIds.map((projectId) => ({ varId, projectId })));
}

export async function saveSharedVar(input: {
  id?: string;
  key: string;
  value: string;
  type: "plain" | "secret";
  targets: EnvTarget[];
  teamWide: boolean;
  environmentIds: string[];
  projectIds: string[];
}): Promise<string> {
  const { teamId } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  const key = input.key.trim();
  if (!KEY_RE.test(key)) throw new Error("Invalid variable name");
  if (input.targets.length === 0)
    throw new Error("Select at least one environment");
  const targets = sanitizeTargets(input.targets);

  // Keep only environments/projects that belong to the active team.
  const environmentIds = await filterTeamEnvironments(teamId, input.environmentIds);
  const projectIds = await filterTeamProjects(teamId, input.projectIds);
  const teamWide = Boolean(input.teamWide);

  // A shared var must REACH something. Normally that means ≥1 sharing mode — but a
  // var carrying explicit per-app LINKS already reaches those apps, and that is
  // exactly the shape migration 0027 gives every var exploded out of a legacy
  // shared GROUP (links, no modes). Rejecting it here would make every migrated
  // group variable permanently unsavable, so links count as reach on update.
  if (!teamWide && environmentIds.length === 0 && projectIds.length === 0) {
    const links = input.id
      ? await getDb()
          .select({ appId: appJunction.appId })
          .from(appJunction)
          .where(eq(appJunction.varId, input.id))
      : [];
    if (links.length === 0)
      throw new Error("Share with at least one environment, project, or team-wide");
  }

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
          updatedAt: nowIso(),
        })
        .where(and(eq(varsTable.id, input.id), eq(varsTable.teamId, teamId)));
      // Whole-set replace the scope junctions (NOT the per-app links — those are
      // owned by the app UI's setSharedVarAppLink).
      await tx.delete(targetsTable).where(eq(targetsTable.varId, input.id));
      await tx.delete(envJunction).where(eq(envJunction.varId, input.id));
      await tx.delete(projJunction).where(eq(projJunction.varId, input.id));
      await insertScopeChildren(tx, input.id, targets, environmentIds, projectIds);
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
        createdAt: now,
        updatedAt: now,
      });
      await insertScopeChildren(tx, id, targets, environmentIds, projectIds);
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
  const { teamId } = await requireCapability("manage_env");
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
  await getDb()
    .update(varsTable)
    .set({ updatedAt: nowIso() })
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

/* ------------------------------------------------------------------ */
/* Deploy-time loader — NO auth gate (the deploy is already authorized). */
/* ------------------------------------------------------------------ */

/**
 * The shared-var entries that apply to one app, tagged with the layer each
 * reaches it through, for the deploy-time merge. A var matching several ways
 * (e.g. team-wide AND per-app link) is emitted once per matched layer so the
 * resolver's precedence picks the most specific. Entries are sorted
 * `created_at ASC` so a within-layer key collision resolves to the later var.
 * Returns encrypted entries; the caller decrypts at the edge.
 */
export async function loadSharedVarsForApp(
  appId: string,
): Promise<SharedVarEntry[]> {
  const db = getDb();
  const app = (
    await db
      .select({
        teamId: appsTable.teamId,
        projectId: appsTable.projectId,
        environmentId: appsTable.environmentId,
      })
      .from(appsTable)
      .where(eq(appsTable.id, appId))
      .limit(1)
  )[0];
  if (!app) return [];
  type Row = { id: string; key: string; valueEnc: string; createdAt: string };
  const cols = {
    id: varsTable.id,
    key: varsTable.key,
    valueEnc: varsTable.valueEnc,
    createdAt: varsTable.createdAt,
  };
  const teamId = app.teamId;

  const [teamWide, byEnv, byProject, byLink] = await Promise.all<Row[]>([
    db
      .select(cols)
      .from(varsTable)
      .where(and(eq(varsTable.teamId, teamId), eq(varsTable.teamWide, true))),
    app.environmentId
      ? db
          .select(cols)
          .from(varsTable)
          .innerJoin(envJunction, eq(envJunction.varId, varsTable.id))
          .where(
            and(
              eq(varsTable.teamId, teamId),
              eq(envJunction.environmentId, app.environmentId),
            ),
          )
      : Promise.resolve<Row[]>([]),
    app.projectId
      ? db
          .select(cols)
          .from(varsTable)
          .innerJoin(projJunction, eq(projJunction.varId, varsTable.id))
          .where(
            and(
              eq(varsTable.teamId, teamId),
              eq(projJunction.projectId, app.projectId),
            ),
          )
      : Promise.resolve<Row[]>([]),
    db
      .select(cols)
      .from(varsTable)
      .innerJoin(appJunction, eq(appJunction.varId, varsTable.id))
      .where(and(eq(varsTable.teamId, teamId), eq(appJunction.appId, appId))),
  ]);

  const layers: [SharedVarMode, Row[]][] = [
    ["teamWide", teamWide],
    ["environment", byEnv],
    ["project", byProject],
    ["link", byLink],
  ];
  const allIds = [
    ...new Set(layers.flatMap(([, rows]) => rows.map((r) => r.id))),
  ];
  if (allIds.length === 0) return [];
  const targetRows = await db
    .select()
    .from(targetsTable)
    .where(inArray(targetsTable.varId, allIds));
  const targetsBy = new Map<string, EnvTarget[]>();
  for (const t of targetRows) {
    const arr = targetsBy.get(t.varId) ?? [];
    arr.push(t.target as EnvTarget);
    targetsBy.set(t.varId, arr);
  }

  const entries: (SharedVarEntry & { createdAt: string })[] = [];
  for (const [mode, rows] of layers) {
    for (const r of rows) {
      const targets = targetsBy.get(r.id);
      entries.push({
        key: r.key,
        valueEnc: r.valueEnc,
        targets: targets && targets.length ? targets : ALL_ENV_TARGETS,
        mode,
        createdAt: r.createdAt,
      });
    }
  }
  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return entries.map((e) => ({
    key: e.key,
    valueEnc: e.valueEnc,
    targets: e.targets,
    mode: e.mode,
  }));
}
