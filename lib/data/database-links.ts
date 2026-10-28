import "server-only";

import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import {
  envVars as envVarsTable,
  envVarTargets as envVarTargetsTable,
} from "../db/schema/control-plane/env-vars";
import {
  environments as environmentsTable,
  projects as projectsTable,
} from "../db/schema/control-plane/projects";
import { getCurrentUser } from "../auth/current-user";
import {
  decryptSecretOrThrow,
  encryptSecret,
  tryDecryptSecret,
} from "../crypto";
import { newId, nowIso } from "../ids";
import { reachesWholeTeam, requireActiveTeamId } from "../membership";
import {
  databaseReach,
  reachable,
  unreachableMessage,
  type DatabaseReach,
} from "../databases/link";
import { linkedConnectionString } from "../deploy/database-compose";
import { recordActivity } from "./activity";
import {
  insertEnvVars,
  appScopeWhere,
  loadEnvVar,
  loadEnvVarsForApp,
} from "./app-graph-load";
import { mentionsHost } from "./database-usage";
import { loadDatabase } from "./databases/rows";
import { markPendingChanges } from "./pending-changes";
import {
  appCapabilitiesForTeam,
  hasAppCapability,
  requireAppCapability,
} from "./node-access";
import type { DatabaseType } from "../types/database";
import type { EnvDatabaseRef, EnvTarget, EnvVar } from "../types/env";

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;
// A preview runs on its own network and may be a stranger's code: a connection is production-only.
const LINK_TARGETS: EnvTarget[] = ["production"];

interface Placement {
  teamId: string;
  environmentId: string | null;
  serverId: string;
}

export interface DatabaseLinkOption {
  id: string;
  name: string;
  type: DatabaseType;
  logo: string | null;
  place: string;
  reach: DatabaseReach;
  connectedKeys: string[];
}

export interface AppLinkOption {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  place: string;
  reach: DatabaseReach;
  canConnect: boolean;
  // The app's variable names, so the picker can ask before replacing one.
  keys: string[];
}

export interface DatabaseAppLink {
  appId: string;
  appName: string;
  appSlug: string;
  appLogo: string | null;
  // Empty without manage_env on the app: its variable names are not the viewer's to read.
  key: string;
  canManage: boolean;
  reach: DatabaseReach;
}

// What the variable holds, which carries the scheme its app reads (inSchemeOf).
function written(v: { valueEnc: string } | undefined): string {
  const value = v ? tryDecryptSecret(v.valueEnc) : null;
  return value?.ok ? value.value : "";
}

function placeLabel(project: string | null, env: string | null): string {
  return project && env ? `${project} / ${env}` : "Top level";
}

const placedDatabases = () =>
  getDb()
    .select({
      id: databasesTable.id,
      name: databasesTable.name,
      type: databasesTable.type,
      logo: databasesTable.logo,
      host: databasesTable.host,
      port: databasesTable.port,
      username: databasesTable.username,
      dbName: databasesTable.dbName,
      connectionStringEnc: databasesTable.connectionStringEnc,
      teamId: databasesTable.teamId,
      environmentId: databasesTable.environmentId,
      serverId: databasesTable.serverId,
      exposedPublicly: databasesTable.exposedPublicly,
      exposedPort: databasesTable.exposedPort,
      envName: environmentsTable.name,
      projectName: projectsTable.name,
    })
    .from(databasesTable)
    .leftJoin(
      environmentsTable,
      eq(databasesTable.environmentId, environmentsTable.id),
    )
    .leftJoin(projectsTable, eq(environmentsTable.projectId, projectsTable.id));

async function appPlacement(
  appId: string,
  teamId: string,
): Promise<(Placement & { name: string }) | null> {
  const [row] = await getDb()
    .select({
      name: appsTable.name,
      teamId: appsTable.teamId,
      environmentId: appsTable.environmentId,
      serverId: appsTable.serverId,
    })
    .from(appsTable)
    .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)))
    .limit(1);
  return row ?? null;
}

export async function listDatabaseLinkOptionsForApp(
  appId: string,
): Promise<DatabaseLinkOption[]> {
  if (!(await hasAppCapability(appId, "manage_env"))) return [];
  if (!(await reachesWholeTeam())) return [];
  const teamId = await requireActiveTeamId();
  const app = await appPlacement(appId, teamId);
  if (!app) return [];
  const [dbs, linked] = await Promise.all([
    placedDatabases().where(eq(databasesTable.teamId, teamId)),
    getDb()
      .select({ key: envVarsTable.key, databaseId: envVarsTable.databaseId })
      .from(envVarsTable)
      .where(
        and(eq(envVarsTable.appId, appId), isNotNull(envVarsTable.databaseId)),
      ),
  ]);
  return dbs
    .map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type as DatabaseType,
      logo: d.logo,
      place: placeLabel(d.projectName, d.envName),
      reach: databaseReach(app, d),
      connectedKeys: linked
        .filter((l) => l.databaseId === d.id)
        .map((l) => l.key),
    }))
    .sort(
      (a, b) =>
        Number(reachable(b.reach)) - Number(reachable(a.reach)) ||
        a.name.localeCompare(b.name),
    );
}

export async function listDatabaseAppLinks(databaseId: string): Promise<{
  links: DatabaseAppLink[];
  apps: AppLinkOption[];
} | null> {
  const teamId = await requireActiveTeamId();
  const db = await loadDatabase(databaseId, teamId, { forRead: true });
  if (!db) return null;
  const rows = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      slug: appsTable.slug,
      logo: appsTable.logo,
      teamId: appsTable.teamId,
      folderId: appsTable.folderId,
      projectId: appsTable.projectId,
      environmentId: appsTable.environmentId,
      serverId: appsTable.serverId,
      envName: environmentsTable.name,
      projectName: projectsTable.name,
    })
    .from(appsTable)
    .leftJoin(
      environmentsTable,
      eq(appsTable.environmentId, environmentsTable.id),
    )
    .leftJoin(projectsTable, eq(environmentsTable.projectId, projectsTable.id))
    .where(and(eq(appsTable.teamId, teamId), appScopeWhere()));
  const [caps, keys] = await Promise.all([
    appCapabilitiesForTeam(teamId, rows),
    rows.length
      ? getDb()
          .select({
            appId: envVarsTable.appId,
            key: envVarsTable.key,
            databaseId: envVarsTable.databaseId,
          })
          .from(envVarsTable)
          .where(
            inArray(
              envVarsTable.appId,
              rows.map((a) => a.id),
            ),
          )
      : [],
  ]);
  const linked = keys.filter((k) => k.databaseId === databaseId);
  const byId = new Map(rows.map((a) => [a.id, a] as const));
  const links = linked.flatMap((l): DatabaseAppLink[] => {
    const a = byId.get(l.appId);
    if (!a) return [];
    const canManage = caps.get(a.id)?.includes("manage_env") ?? false;
    return [
      {
        appId: a.id,
        appName: a.name,
        appSlug: a.slug,
        appLogo: a.logo,
        key: canManage ? l.key : "",
        canManage,
        reach: databaseReach(a, db),
      },
    ];
  });
  const apps = rows
    .map((a) => {
      const held = caps.get(a.id) ?? [];
      return {
        id: a.id,
        name: a.name,
        slug: a.slug,
        logo: a.logo,
        place: placeLabel(a.projectName, a.envName),
        reach: databaseReach(a, db),
        canConnect:
          held.includes("manage_env") && held.includes("reveal_secrets"),
        keys: keys.filter((k) => k.appId === a.id).map((k) => k.key),
      };
    })
    .filter((a) => a.canConnect)
    .sort(
      (a, b) =>
        Number(reachable(b.reach)) - Number(reachable(a.reach)) ||
        a.name.localeCompare(b.name),
    );
  return {
    links: links.sort(
      (a, b) =>
        a.appName.localeCompare(b.appName) || a.key.localeCompare(b.key),
    ),
    apps,
  };
}

// Connecting hands the credentials to the app's code, so it asks for reveal_secrets as well.
export async function connectDatabase(input: {
  appId: string;
  databaseId: string;
  key: string;
}): Promise<void> {
  const { userId, teamId } = await requireAppCapability(
    input.appId,
    "manage_env",
  );
  await requireAppCapability(input.appId, "reveal_secrets");
  const key = input.key.trim();
  if (!KEY_RE.test(key)) throw new Error("Invalid variable name");
  const db = await loadDatabase(input.databaseId, teamId, { forRead: true });
  if (!db) throw new Error("Database not found");
  const app = await appPlacement(input.appId, teamId);
  if (!app) throw new Error("App not found");
  const reach = databaseReach(app, db);
  if (!reachable(reach))
    throw new Error(unreachableMessage(key, db.name, reach));
  const stored = decryptSecretOrThrow(
    db.connectionStringEnc,
    "The database password",
  );

  await getDb().transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: envVarsTable.id, valueEnc: envVarsTable.valueEnc })
      .from(envVarsTable)
      .where(
        and(eq(envVarsTable.appId, input.appId), eq(envVarsTable.key, key)),
      )
      .limit(1);
    // A replaced variable keeps the scheme its app was reading.
    const valueEnc = encryptSecret(
      linkedConnectionString(db, stored, reach, written(existing)),
    );
    if (!existing) {
      await insertEnvVars(tx, [
        {
          id: newId("env"),
          appId: input.appId,
          key,
          valueEnc,
          targets: LINK_TARGETS,
          type: "secret",
          databaseId: db.id,
          databaseUnlinked: false,
          createdByUserId: userId,
          updatedByUserId: userId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      ]);
      return;
    }
    await tx
      .update(envVarsTable)
      .set({
        valueEnc,
        type: "secret",
        databaseId: db.id,
        databaseUnlinked: false,
        updatedByUserId: userId,
        updatedAt: nowIso(),
      })
      .where(eq(envVarsTable.id, existing.id));
    await tx
      .delete(envVarTargetsTable)
      .where(eq(envVarTargetsTable.envVarId, existing.id));
    await tx
      .insert(envVarTargetsTable)
      .values(
        LINK_TARGETS.map((target) => ({ envVarId: existing.id, target })),
      );
  });
  await markPendingChanges([input.appId]);
  const user = (await getCurrentUser())!;
  await recordActivity(
    "env",
    `Connected ${db.name} to ${app.name} as ${key}`,
    user.name,
    input.appId,
    teamId,
    null,
    db.id,
  );
}

// Unlink keeps the value the app gets today; only the following stops.
export async function unlinkEnv(id: string): Promise<string> {
  const e = await loadEnvVar(id);
  if (!e?.databaseId) throw new Error("This variable is not connected");
  await unlinkVars(e.appId, [e]);
  return e.appId;
}

export async function disconnectDatabase(input: {
  appId: string;
  databaseId: string;
}): Promise<void> {
  await requireAppCapability(input.appId, "manage_env");
  const vars = (await loadEnvVarsForApp(input.appId)).filter(
    (v) => v.databaseId === input.databaseId,
  );
  if (vars.length === 0) throw new Error("This database is not connected");
  await unlinkVars(input.appId, vars);
}

async function unlinkVars(appId: string, vars: EnvVar[]): Promise<void> {
  const { teamId, userId } = await requireAppCapability(appId, "manage_env");
  const databaseId = vars[0]!.databaseId!;
  const [{ vars: live }, [db]] = await Promise.all([
    withLinkedValues(appId, vars, "any"),
    getDb()
      .select({ name: databasesTable.name })
      .from(databasesTable)
      .where(eq(databasesTable.id, databaseId)),
  ]);
  await getDb().transaction(async (tx) => {
    for (const v of live)
      await tx
        .update(envVarsTable)
        .set({
          valueEnc: v.valueEnc,
          databaseId: null,
          databaseUnlinked: true,
          updatedByUserId: userId,
          updatedAt: nowIso(),
        })
        .where(and(eq(envVarsTable.id, v.id), eq(envVarsTable.appId, appId)));
  });
  const user = (await getCurrentUser())!;
  await recordActivity(
    "env",
    `${vars.map((v) => v.key).join(", ")} no longer ${vars.length === 1 ? "follows" : "follow"} ${db?.name ?? "its database"}`,
    user.name,
    appId,
    teamId,
    null,
    databaseId,
  );
}

// The connected database of each variable, and the one a hand-written value names by host.
export async function envDatabaseRefs(
  appId: string,
  vars: EnvVar[],
): Promise<{
  connected: Map<string, EnvDatabaseRef>;
  detected: Map<string, EnvDatabaseRef>;
  // The value a connected variable resolves to now, for showing a plain one.
  live: Map<string, string>;
}> {
  const connected = new Map<string, EnvDatabaseRef>();
  const detected = new Map<string, EnvDatabaseRef>();
  const live = new Map<string, string>();
  if (vars.length === 0 || !(await reachesWholeTeam()))
    return { connected, detected, live };
  const teamId = await requireActiveTeamId();
  const [app, dbs] = await Promise.all([
    appPlacement(appId, teamId),
    placedDatabases().where(eq(databasesTable.teamId, teamId)),
  ]);
  if (!app || dbs.length === 0) return { connected, detected, live };
  const refs = new Map(
    dbs.map((d) => [
      d.id,
      {
        id: d.id,
        name: d.name,
        type: d.type as DatabaseType,
        logo: d.logo,
        reachable: reachable(databaseReach(app, d)),
      },
    ]),
  );
  for (const v of vars) {
    if (v.databaseId) {
      const ref = refs.get(v.databaseId);
      const db = dbs.find((d) => d.id === v.databaseId);
      if (!ref || !db) continue;
      connected.set(v.id, ref);
      const stored = tryDecryptSecret(db.connectionStringEnc);
      const reach = databaseReach(app, db);
      if (stored.ok && reachable(reach))
        live.set(
          v.id,
          linkedConnectionString(
            { ...db, type: db.type as DatabaseType },
            stored.value,
            reach,
            written(v),
          ),
        );
      continue;
    }
    const value = tryDecryptSecret(v.valueEnc);
    if (!value.ok) continue;
    const hit = dbs.find((d) => mentionsHost(value.value, d.host));
    if (hit) detected.set(v.id, refs.get(hit.id)!);
  }
  return { connected, detected, live };
}

// Re-derived at every deploy, so a rotated password or a new exposure needs no re-connect.
export async function withLinkedValues(
  appId: string,
  vars: EnvVar[],
  target: EnvTarget | "any",
): Promise<{ vars: EnvVar[]; unreachable: string[] }> {
  const wanted = (v: EnvVar) => target === "any" || v.targets.includes(target);
  const linked = vars.filter((v) => v.databaseId && wanted(v));
  if (linked.length === 0) return { vars, unreachable: [] };
  const [[app], dbs] = await Promise.all([
    getDb()
      .select({
        teamId: appsTable.teamId,
        environmentId: appsTable.environmentId,
        serverId: appsTable.serverId,
      })
      .from(appsTable)
      .where(eq(appsTable.id, appId))
      .limit(1),
    getDb()
      .select()
      .from(databasesTable)
      .where(
        inArray(
          databasesTable.id,
          linked.map((v) => v.databaseId!),
        ),
      ),
  ]);
  const byId = new Map(dbs.map((d) => [d.id, d] as const));
  const unreachable: string[] = [];
  const resolved = vars.map((v) => {
    const db = v.databaseId ? byId.get(v.databaseId) : undefined;
    if (!db || !app || !wanted(v)) return v;
    const reach = databaseReach(app, db);
    if (!reachable(reach)) {
      unreachable.push(unreachableMessage(v.key, db.name, reach));
      return v;
    }
    const stored = decryptSecretOrThrow(
      db.connectionStringEnc,
      `The password of ${db.name}`,
    );
    return {
      ...v,
      valueEnc: encryptSecret(
        linkedConnectionString(
          { ...db, type: db.type as DatabaseType },
          stored,
          reach,
          written(v),
        ),
      ),
    };
  });
  return { vars: resolved, unreachable };
}

export async function markLinkedAppsPending(databaseId: string): Promise<void> {
  const rows = await getDb()
    .selectDistinct({ appId: envVarsTable.appId })
    .from(envVarsTable)
    .where(eq(envVarsTable.databaseId, databaseId));
  await markPendingChanges(rows.map((r) => r.appId));
}
