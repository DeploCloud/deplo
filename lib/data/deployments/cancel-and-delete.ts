import "server-only";

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import { getCurrentUser } from "../../auth/current-user";
import { nowIso } from "../../ids";
import { requireCapability, requireMembership } from "../../membership";
import { publishAppChanged } from "../../graphql/pubsub";
import { recordActivity } from "../activity";
import { loadDeployment } from "../app-graph-load";
import { hasAppCapability, requireAppCapability } from "../node-access";
import type { Deployment } from "../../types/deployment";

// elapsedBuildMs freezes how long the build had been running onto the row.
const elapsedBuildMs = sql`case when ${deploymentsTable.startedAt} is null then null else greatest(0, (extract(epoch from (now() - ${deploymentsTable.startedAt})) * 1000)::bigint) end`;

// IN_PROGRESS rows are still referenced by the deploy queue and the build job, so
// they must be CANCELED, never deleted.
export const IN_PROGRESS: Deployment["status"][] = ["queued", "building"];

// cancelDeployment stops a queued/building deployment.
export async function cancelDeployment(id: string): Promise<boolean> {
  await requireMembership();
  const user = (await getCurrentUser())!;
  const dep = await loadDeployment(id);
  if (!dep) throw new Error("Deployment not found");
  await requireAppCapability(dep.appId, "deploy_apps");
  // The queued/building state is part of the WHERE, not just a pre-check: a build
  // that finished between the read above and this write must NOT be retroactively
  // flipped from ready/error to canceled (0 rows → no-op).
  const stopped = await getDb()
    .update(deploymentsTable)
    .set({ status: "canceled", buildDurationMs: elapsedBuildMs })
    .where(
      and(
        eq(deploymentsTable.id, id),
        inArray(deploymentsTable.status, ["queued", "building"]),
      ),
    )
    .returning({ id: deploymentsTable.id });
  if (stopped.length === 0) return false;
  // Settle the app off "building" BEFORE the publish, so the badge flips at once.
  await settleAppAfterCancel(dep.appId);
  publishAppChanged(dep.appId);
  await recordActivity(
    "deployment",
    "Stopped a running build",
    user.name,
    dep.appId,
  );
  return true;
}

const onServer = (serverId: string) =>
  sql`coalesce(${deploymentsTable.serverId}, ${appsTable.serverId}) = ${serverId}`;

// Joined through `apps` so a foreign/stale id is simply absent (team isolation).
async function terminalDeploymentRows(
  teamId: string,
  filter: {
    ids?: string[];
    appId?: string;
    serverId?: string;
    environment?: string;
    status?: string;
  },
): Promise<{ id: string; appId: string }[]> {
  const conds = [
    eq(appsTable.teamId, teamId),
    notInArray(deploymentsTable.status, IN_PROGRESS),
  ];
  if (filter.appId) conds.push(eq(deploymentsTable.appId, filter.appId));
  if (filter.serverId) conds.push(onServer(filter.serverId));
  if (filter.environment)
    conds.push(eq(deploymentsTable.environment, filter.environment));
  if (filter.status) conds.push(eq(deploymentsTable.status, filter.status));
  if (filter.ids) conds.push(inArray(deploymentsTable.id, filter.ids));
  return getDb()
    .select({ id: deploymentsTable.id, appId: deploymentsTable.appId })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(deploymentsTable.appId, appsTable.id))
    .where(and(...conds));
}

async function removeDeploymentRows(
  rows: { id: string; appId: string }[],
  teamId: string,
  userName: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const deleted = await getDb()
    .delete(deploymentsTable)
    .where(
      inArray(
        deploymentsTable.id,
        rows.map((r) => r.id),
      ),
    )
    .returning({ id: deploymentsTable.id, appId: deploymentsTable.appId });
  const apps = new Set(deleted.map((d) => d.appId));
  // Deleting the latest deployment NULLs the app's pointer (FK set-null), so
  // the live status/latest-deployment reads must refresh.
  for (const sid of apps) publishAppChanged(sid);
  if (deleted.length > 0)
    await recordActivity(
      "deployment",
      `Deleted ${deleted.length} deployment${deleted.length === 1 ? "" : "s"}`,
      userName,
      apps.size === 1 ? [...apps][0]! : null,
      teamId,
    );
  return deleted.length;
}

// Non-throwing companion to `requireAppCapability`: an unreachable app is skipped
// rather than fatal in the broad sweeps.
async function mayManageAppFolder(
  appId: string,
  cap: "deploy_apps" | "delete_apps",
): Promise<boolean> {
  return hasAppCapability(appId, cap);
}

// deleteDeployments removes finished deployments by id; in-progress ids are left alone.
export async function deleteDeployments(ids: string[]): Promise<number> {
  const { membership } = await requireMembership();
  const user = (await getCurrentUser())!;
  const unique = [...new Set(ids)];
  if (unique.length === 0) return 0;
  const rows = await terminalDeploymentRows(membership.teamId, { ids: unique });
  if (rows.length === 0) return 0;
  for (const sid of new Set(rows.map((r) => r.appId)))
    await requireAppCapability(sid, "delete_apps");
  return removeDeploymentRows(rows, membership.teamId, user.name);
}

// Keeps only rows whose app's folder the caller holds `cap` on - the team-wide
// sweep guard shared by delete-all and cancel-all.
async function folderPermittedRows(
  rows: { id: string; appId: string }[],
  cap: "deploy_apps" | "delete_apps",
): Promise<{ id: string; appId: string }[]> {
  const allowed = new Map<string, boolean>();
  const permitted: { id: string; appId: string }[] = [];
  for (const r of rows) {
    if (!allowed.has(r.appId))
      allowed.set(r.appId, await mayManageAppFolder(r.appId, cap));
    if (allowed.get(r.appId)) permitted.push(r);
  }
  return permitted;
}

// deleteAllDeployments deletes every finished deployment of one app, or of the whole team.
export async function deleteAllDeployments(
  appId?: string | null,
  serverId?: string | null,
  environment?: string | null,
  status?: string | null,
): Promise<number> {
  const { membership } = appId
    ? await requireAppCapability(appId, "delete_apps")
    : await requireCapability("delete_apps");
  const user = (await getCurrentUser())!;
  if (appId) {
    const rows = await terminalDeploymentRows(membership.teamId, {
      appId,
      serverId: serverId ?? undefined,
      environment: environment ?? undefined,
      status: status ?? undefined,
    });
    return removeDeploymentRows(rows, membership.teamId, user.name);
  }
  const rows = await terminalDeploymentRows(membership.teamId, {
    serverId: serverId ?? undefined,
    environment: environment ?? undefined,
    status: status ?? undefined,
  });
  const permitted = await folderPermittedRows(rows, "delete_apps");
  return removeDeploymentRows(permitted, membership.teamId, user.name);
}

async function inProgressDeploymentRows(
  teamId: string,
  filter: {
    appId?: string;
    serverId?: string;
    environment?: string;
    status?: string;
  },
): Promise<{ id: string; appId: string }[]> {
  const conds = [
    eq(appsTable.teamId, teamId),
    inArray(deploymentsTable.status, IN_PROGRESS),
  ];
  if (filter.appId) conds.push(eq(deploymentsTable.appId, filter.appId));
  if (filter.serverId) conds.push(onServer(filter.serverId));
  if (filter.environment)
    conds.push(eq(deploymentsTable.environment, filter.environment));
  if (filter.status) conds.push(eq(deploymentsTable.status, filter.status));
  return getDb()
    .select({ id: deploymentsTable.id, appId: deploymentsTable.appId })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(deploymentsTable.appId, appsTable.id))
    .where(and(...conds));
}

// No publish here - the caller emits one snapshot after settling.
async function settleAppAfterCancel(appId: string): Promise<void> {
  const remaining = await getDb()
    .select({ id: deploymentsTable.id })
    .from(deploymentsTable)
    .where(
      and(
        eq(deploymentsTable.appId, appId),
        inArray(deploymentsTable.status, IN_PROGRESS),
      ),
    )
    .limit(1);
  if (remaining.length > 0) return;
  await getDb()
    .update(appsTable)
    .set({ status: "idle", updatedAt: nowIso() })
    .where(
      and(
        eq(appsTable.id, appId),
        inArray(appsTable.status, ["building", "queued"]),
      ),
    );
}

async function cancelDeploymentRows(
  rows: { id: string; appId: string }[],
  teamId: string,
  userName: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const stopped = await getDb()
    .update(deploymentsTable)
    .set({ status: "canceled", buildDurationMs: elapsedBuildMs })
    .where(
      and(
        inArray(
          deploymentsTable.id,
          rows.map((r) => r.id),
        ),
        inArray(deploymentsTable.status, IN_PROGRESS),
      ),
    )
    .returning({ id: deploymentsTable.id, appId: deploymentsTable.appId });
  const apps = new Set(stopped.map((d) => d.appId));
  // Settle each app BEFORE publishing so the emitted snapshot carries the
  // settled status, not the stale "building".
  for (const sid of apps) await settleAppAfterCancel(sid);
  for (const sid of apps) publishAppChanged(sid);
  if (stopped.length > 0)
    await recordActivity(
      "deployment",
      `Stopped ${stopped.length} running build${stopped.length === 1 ? "" : "s"}`,
      userName,
      apps.size === 1 ? [...apps][0]! : null,
      teamId,
    );
  return stopped.length;
}

// cancelAllDeployments cancels every in-progress deployment of one app, or of the whole team.
export async function cancelAllDeployments(
  appId?: string | null,
  serverId?: string | null,
  environment?: string | null,
  status?: string | null,
): Promise<number> {
  const { membership } = appId
    ? await requireAppCapability(appId, "deploy_apps")
    : await requireCapability("deploy_apps");
  const user = (await getCurrentUser())!;
  if (appId) {
    const rows = await inProgressDeploymentRows(membership.teamId, {
      appId,
      serverId: serverId ?? undefined,
      environment: environment ?? undefined,
      status: status ?? undefined,
    });
    return cancelDeploymentRows(rows, membership.teamId, user.name);
  }
  const rows = await inProgressDeploymentRows(membership.teamId, {
    serverId: serverId ?? undefined,
    environment: environment ?? undefined,
    status: status ?? undefined,
  });
  const permitted = await folderPermittedRows(rows, "deploy_apps");
  return cancelDeploymentRows(permitted, membership.teamId, user.name);
}
