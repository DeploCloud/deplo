import "server-only";

import { retireAppTunnel } from "../clusters/app-tunnel";
import { dropFailoverBundle } from "../clusters/bundles";
import { clearPlacement, listAppMembers } from "../clusters/placement";
import { clusterMemberServerIds } from "../clusters/roster";
import { eq, inArray, isNotNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { getCurrentUser } from "../../auth/current-user";
import { nowIso } from "../../ids";
import { requireMembership } from "../../membership";
import { getServerById, listAllServers } from "../servers/roster";
import { inAppScope } from "../../auth/request-context";
import { loadAppGraph, loadAppsByIds } from "../app-graph-load";
import { requireAppCapability } from "../node-access";
import { withKeyedLock } from "../keyed-mutex";
import { destroyPreviewsForApp } from "../../deploy/preview-lifecycle/close";
import { removeUploads } from "../../deploy/upload";
import { appOwnVolumeNames } from "../project-backup-descriptor";
import { teardownOrQueue } from "../teardown-queue";
import { recordActivity } from "../activity";
import { deleteBackupsWithTarget } from "../backups/artifact-delete";
import { cancelBackupsOfDeleted } from "../backups/execute-backup";
import { mapLimit } from "../../utils";
import { errMsg } from "./lifecycle";
import { removeSetAsideCopiesOfDeleted } from "./set-aside";
import type { App } from "../../types/app";
import { deleteReleasedDns, takeAppDns } from "../dns-providers/provision";

// The point of no return: from here every gate refuses the app, and nothing ever clears the stamp.
async function markAppsDeleting(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await getDb()
    .update(appsTable)
    .set({ deletingAt: nowIso() })
    .where(inArray(appsTable.id, ids));
  for (const id of ids) await cancelBackupsOfDeleted(id);
}

async function beginAppDelete(
  id: string,
): Promise<{ project: App; actor: string }> {
  const { membership } = await requireAppCapability(id, "delete_apps");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");
  // Before the point of no return: a backup that cannot be deleted keeps the app.
  await deleteBackupsWithTarget({ kind: "app", targetId: id });
  await markAppsDeleting([id]);
  return { project, actor: user.name };
}

/**
 * Every server that may hold any of it: where it runs, where it moved from, and each server of its cluster, set-aside
 * copies included. A server that does not answer has it queued, and done once it answers (ADR-0043).
 */
async function tearDownEverywhere(project: App): Promise<boolean> {
  const reclaimVolumes = appOwnVolumeNames(project);
  const on = (serverId: string) =>
    teardownOrQueue({
      serverId,
      deployKey: project.slug,
      projectLabel: project.id,
      label: project.name,
      teamId: project.teamId,
      reclaimVolumes,
      dropSetAside: true,
    });
  const ok = await on(project.serverId);
  const others = new Set<string>([
    ...(await listAppMembers(project).catch(() => [])),
    ...(project.clusterId
      ? await clusterMemberServerIds(project.clusterId).catch(() => [])
      : []),
    ...(project.migrateFromServerId ? [project.migrateFromServerId] : []),
  ]);
  others.delete(project.serverId);
  for (const serverId of others) await on(serverId).catch(() => {});
  return ok;
}

async function destroyApp(project: App, actor: string): Promise<void> {
  const id = project.id;
  let asides: string | null = null;

  const tornDown = await withKeyedLock(`app-lifecycle:${id}`, async () => {
    // Previews FIRST: the DELETE below cascades their rows away, and with them the only record those containers exist.
    await destroyPreviewsForApp(id).catch(() => {});

    asides = await removeSetAsideCopiesOfDeleted(project).catch(() => null);
    const ok = await tearDownEverywhere(project);
    await removeUploads(id).catch(() => {});

    await retireAppTunnel(id).catch(() => null);
    const heldDns = await takeAppDns([id]).catch(() => []);
    await getDb().delete(appsTable).where(eq(appsTable.id, id));
    await clearPlacement("app", id).catch(() => {});
    await dropFailoverBundle(id, project.clusterId ?? null).catch(() => {});
    await deleteReleasedDns(heldDns).catch(() => null);
    return ok;
  });
  const server = await getServerById(project.serverId);
  if (!tornDown) {
    await recordActivity(
      "app",
      `Deleted ${project.name}, but ${server?.name ?? "its server"} did not answer. ` +
        `Deplo will retry the teardown until it succeeds.`,
      actor,
      null,
      project.teamId,
    );
  }
  await recordActivity(
    "app",
    `Deleted project ${project.name}`,
    actor,
    null,
    project.teamId,
  );
  if (asides) await recordActivity("app", asides, actor, null, project.teamId);
}

export async function deleteApp(id: string): Promise<void> {
  const { project, actor } = await beginAppDelete(id);
  await destroyApp(project, actor);
}

export async function startAppDelete(id: string): Promise<void> {
  const { project, actor } = await beginAppDelete(id);
  void destroyApp(project, actor).catch((e) =>
    console.error(
      `[deplo] delete of ${project.name} did not finish:`,
      errMsg(e),
    ),
  );
}

export async function deleteApps(ids: string[]): Promise<number> {
  const { apps, actor } = await beginAppsDelete(ids);
  if (apps.length === 0) return 0;
  await destroyApps(apps, actor);
  return apps.length;
}

export async function startAppsDelete(ids: string[]): Promise<number> {
  const { apps, actor } = await beginAppsDelete(ids);
  if (apps.length === 0) return 0;
  void destroyApps(apps, actor).catch((e) =>
    console.error("[deplo] bulk delete did not finish:", errMsg(e)),
  );
  return apps.length;
}

async function beginAppsDelete(
  ids: string[],
): Promise<{ apps: App[]; actor: string }> {
  const { membership } = await requireMembership();
  const user = (await getCurrentUser())!;
  const idSet = [...new Set(ids)];
  const apps = (await loadAppsByIds(idSet)).filter(
    (p) => p.teamId === membership.teamId && inAppScope(p) && !p.deletingAt,
  );
  if (apps.length === 0) return { apps, actor: user.name };

  for (const p of apps) {
    // Gate EACH app on its own node (ADR-0016): a bulk delete is not a way around per-folder access.
    await requireAppCapability(p.id, "delete_apps");
  }
  await markAppsDeleting(apps.map((p) => p.id));
  return { apps, actor: user.name };
}

async function destroyApps(apps: App[], actor: string): Promise<void> {
  const serversById = new Map(
    (await listAllServers()).map((s) => [s.id, s] as const),
  );
  const unreachable: string[] = [];
  const asideLines: string[] = [];
  await mapLimit(apps, 4, async (project) => {
    const tornDown = await withKeyedLock(
      `app-lifecycle:${project.id}`,
      async () => {
        await destroyPreviewsForApp(project.id).catch(() => {});
        const asides = await removeSetAsideCopiesOfDeleted(project).catch(
          () => null,
        );
        if (asides) asideLines.push(asides);
        const ok = await tearDownEverywhere(project).catch(() => false);
        await removeUploads(project.id).catch(() => {});
        await retireAppTunnel(project.id).catch(() => null);
        const heldDns = await takeAppDns([project.id]).catch(() => []);
        await getDb().delete(appsTable).where(eq(appsTable.id, project.id));
        await clearPlacement("app", project.id).catch(() => {});
        await dropFailoverBundle(project.id, project.clusterId ?? null).catch(
          () => {},
        );
        await deleteReleasedDns(heldDns).catch(() => null);
        return ok;
      },
    );
    if (!tornDown) {
      const server = serversById.get(project.serverId);
      unreachable.push(`${project.name} (${server?.name ?? "its server"})`);
    }
  });

  await recordActivity(
    "app",
    `Deleted ${apps.length} project${apps.length === 1 ? "" : "s"}`,
    actor,
    null,
    apps[0]!.teamId,
  );
  for (const line of asideLines)
    await recordActivity("app", line, actor, null, apps[0]!.teamId);
  if (unreachable.length) {
    await recordActivity(
      "app",
      `Some servers did not answer during the delete. Deplo will retry the ` +
        `teardown of: ${unreachable.join(", ")}.`,
      actor,
      null,
      apps[0]!.teamId,
    );
  }
}

export async function resumeAppDeletes(): Promise<void> {
  const rows = await getDb()
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(isNotNull(appsTable.deletingAt));
  for (const { id } of rows) {
    const project = await loadAppGraph(id);
    if (!project) continue;
    await destroyApp(project, "Deplo").catch((e) =>
      console.error(
        `[deplo] could not finish deleting ${project.name}:`,
        errMsg(e),
      ),
    );
  }
}
