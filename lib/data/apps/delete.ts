import "server-only";

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
import { mapLimit } from "../../utils";
import { errMsg } from "./lifecycle";
import type { App } from "../../types/app";

async function markAppsDeleting(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await getDb()
    .update(appsTable)
    .set({ deletingAt: nowIso() })
    .where(inArray(appsTable.id, ids));
}

async function beginAppDelete(
  id: string,
): Promise<{ project: App; actor: string }> {
  const { membership } = await requireAppCapability(id, "delete_apps");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");
  await markAppsDeleting([id]);
  return { project, actor: user.name };
}

async function destroyApp(project: App, actor: string): Promise<void> {
  const id = project.id;

  const tornDown = await withKeyedLock(`app-lifecycle:${id}`, async () => {
    await destroyPreviewsForApp(id).catch(() => {});

    const ok = await teardownOrQueue({
      serverId: project.serverId,
      deployKey: project.slug,
      projectLabel: project.id,
      label: project.name,
      teamId: project.teamId,

      reclaimVolumes: appOwnVolumeNames(project),
    });

    if (project.migrateFromServerId)
      await teardownOrQueue({
        serverId: project.migrateFromServerId,
        deployKey: project.slug,
        projectLabel: project.id,
        label: project.name,
        teamId: project.teamId,
        reclaimVolumes: appOwnVolumeNames(project),
      }).catch(() => {});
    await removeUploads(id).catch(() => {});

    await getDb().delete(appsTable).where(eq(appsTable.id, id));
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
  await mapLimit(apps, 4, async (project) => {
    const tornDown = await withKeyedLock(
      `app-lifecycle:${project.id}`,
      async () => {
        await destroyPreviewsForApp(project.id).catch(() => {});
        const ok = await teardownOrQueue({
          serverId: project.serverId,
          deployKey: project.slug,
          projectLabel: project.id,
          label: project.name,
          teamId: project.teamId,
          reclaimVolumes: appOwnVolumeNames(project),
        }).catch(() => false);
        await removeUploads(project.id).catch(() => {});
        await getDb().delete(appsTable).where(eq(appsTable.id, project.id));
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
