import "server-only";

import { and, eq, inArray, isNull, or } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  sharedEnvVars as varsTable,
  sharedEnvVarEnvironments as envJunction,
  sharedEnvVarProjects as projJunction,
  sharedEnvVarApps as appJunction,
  sharedEnvVarTeams as teamJunction,
} from "../../db/schema/control-plane/env-vars";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import {
  projects as projectsTable,
  environments as environmentsTable,
} from "../../db/schema/control-plane/projects";
import { assertUser, getCurrentUser } from "../../auth/current-user";
import { newId, nowIso } from "../../ids";
import {
  holdsTeamWideCapability,
  isInstanceAdmin,
  requireCapability,
  requireTeamWide,
  teamsForUser,
} from "../../membership";
import { recordActivity } from "../activity";
import { markPendingChangesForSharedVar } from "../pending-changes";
import { requireAppCapability } from "../node-access";
import { encryptSecret } from "../../crypto";
import {
  ALL_ENV_TARGETS,
  sanitizeTargets,
  secretImmutable,
} from "../../types/env";
import type { EnvTarget } from "../../types/env";
import { MASK } from "./display";
import { loadVisibleToTeam } from "./visibility";
import {
  currentAppLinks,
  currentReach,
  insertScopeChildren,
  replaceAppLinks,
  replaceTargets,
  replaceTeams,
} from "./junctions";

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

function ownedBy(teamId: string, admin: boolean) {
  return admin
    ? or(eq(varsTable.teamId, teamId), isNull(varsTable.teamId))
    : eq(varsTable.teamId, teamId);
}

export async function saveSharedVar(input: {
  id?: string;
  key: string;
  value: string;
  type: "plain" | "secret";
  targets?: EnvTarget[];
  teamIds: string[];
  environmentIds: string[];
  projectIds: string[];
  appIds?: string[];
}): Promise<string> {
  await requireTeamWide("shared variables");
  const { teamId, userId } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  const teamIds = [...new Set(input.teamIds)];
  const reach = await currentReach(input.id);
  for (const t of teamIds) {
    // Skipped for a team it already reaches: re-asking made an instance-wide variable unsavable by most admins.
    if (t === teamId || reach.teams.includes(t)) continue;
    if (!(await holdsTeamWideCapability(t, "manage_env")))
      throw new Error("Team not found");
  }
  const adminHere = await isInstanceAdmin();
  const key = input.key.trim();
  if (!KEY_RE.test(key)) throw new Error("Invalid variable name");
  const targets = input.targets?.length ? sanitizeTargets(input.targets) : null;

  const environmentIds = await filterTeamEnvironments(
    teamId,
    input.environmentIds,
  );
  const projectIds = await filterTeamProjects(teamId, input.projectIds);
  const appIds = input.appIds
    ? await filterTeamApps(teamId, input.appIds)
    : undefined;
  const autoInject = teamIds.length > 1;
  const lostTeams = reach.teams.filter(
    (t) => t !== teamId && !teamIds.includes(t),
  );
  const storedLinks = await currentAppLinks(teamId, input.id);

  if (appIds) {
    const incoming = new Set(appIds);
    const changed = [
      ...appIds.filter((id) => !storedLinks.includes(id)),
      ...storedLinks.filter((id) => !incoming.has(id)),
    ];
    for (const appId of changed)
      await requireAppCapability(appId, "manage_env");
  }

  const reachesByLink = appIds ? appIds.length > 0 : storedLinks.length > 0;
  const reachesNothing =
    teamIds.length === 0 &&
    environmentIds.length === 0 &&
    projectIds.length === 0 &&
    !reachesByLink;
  const stranded =
    Boolean(input.id) &&
    reach.teams.length === 0 &&
    reach.environments.length === 0 &&
    reach.projects.length === 0 &&
    storedLinks.length === 0;
  if (reachesNothing && !stranded)
    throw new Error("Share with at least one app, project, or team");

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

  const keepValue = input.value === MASK;
  let savedId = input.id ?? "";
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
      const owned = ownedBy(teamId, adminHere);
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
          // ADR-0027 §4: the stored column, never the count - a reach row lost to a cascade must not disarm it on the next save.
          autoInject:
            teamIds.length > 1 ||
            (existing[0].autoInject && lostTeams.length === 0),
          updatedByUserId: userId,
          updatedAt: nowIso(),
        })
        .where(and(eq(varsTable.id, input.id), owned));
      await replaceTargets(tx, input.id, targets);
      await tx.delete(envJunction).where(eq(envJunction.varId, input.id));
      await tx.delete(projJunction).where(eq(projJunction.varId, input.id));
      await insertScopeChildren(tx, input.id, environmentIds, projectIds);
      await replaceTeams(tx, input.id, teamIds);
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
  await markPendingChangesForSharedVar(savedId);
  return savedId;
}

export async function deleteSharedVar(id: string): Promise<void> {
  await requireTeamWide("shared variables");
  const { teamId } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  const owned = ownedBy(teamId, await isInstanceAdmin());
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
  await markPendingChangesForSharedVar(id);
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
