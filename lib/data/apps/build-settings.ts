import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  apps as appsTable,
  appBuild as appBuildTable,
  appBuildMethodSettings as appBuildMethodSettingsTable,
} from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { getCurrentUser } from "../../auth/current-user";
import { nowIso } from "../../ids";
import { getServerById, listServersForTeam } from "../servers/roster";
import { loadAppGraph } from "../app-graph-load";
import { buildToRow, methodSettingsToRow } from "../app-graph-rows/build";
import { requireAppCapability } from "../node-access";
import { recordActivity } from "../activity";
import { markPendingChanges } from "../pending-changes";
import { ON_IMPORT_SOURCE } from "./source-guards";
import type { BuildConfig } from "../../types/build";

// build.port is only which container port Traefik routes to, so it is not behind the expose-ports grant.
export async function updateAppBuild(
  id: string,
  build: Partial<BuildConfig>,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  let portBefore: number | null = null;
  await getDb().transaction(async (tx) => {
    const existing = await loadAppGraph(id, tx);
    if (!existing || existing.teamId !== membership.teamId)
      throw new Error("App not found");
    portBefore = existing.build.port ?? null;

    const merged: BuildConfig = {
      ...existing.build,
      ...build,
      methodSettings: build.methodSettings ?? existing.build.methodSettings,
      buildCacheClearPending: existing.build.buildCacheClearPending,
    };
    await tx
      .update(appsTable)
      .set({ updatedAt: nowIso() })
      .where(eq(appsTable.id, id));
    await tx
      .update(appBuildTable)
      .set(buildToRow(id, merged))
      .where(eq(appBuildTable.appId, id));
    if (build.methodSettings) {
      await tx
        .update(appBuildMethodSettingsTable)
        .set(methodSettingsToRow(id, merged.methodSettings))
        .where(eq(appBuildMethodSettingsTable.appId, id));
    }
  });

  // Domains still routing to the OLD port follow the new one, or a green deploy answers 502 from another screen.
  if (portBefore != null && build.port != null && build.port !== portBefore) {
    const moved = await getDb()
      .update(domainsTable)
      .set({ port: build.port })
      .where(and(eq(domainsTable.appId, id), eq(domainsTable.port, portBefore)))
      .returning({ id: domainsTable.id });
    if (moved.length > 0)
      await recordActivity(
        "app",
        `Moved ${moved.length === 1 ? "1 domain" : `${moved.length} domains`} to port ${build.port}`,
        user.name,
        id,
      );
  }
  await markPendingChanges([id]);
  await recordActivity("app", `Updated build settings`, user.name, id);
}

export async function clearAppBuildCache(id: string): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");
  await getDb()
    .update(appBuildTable)
    .set({ buildCacheClearPending: true })
    .where(eq(appBuildTable.appId, id));
  await getDb()
    .update(appsTable)
    .set({ updatedAt: nowIso() })
    .where(eq(appsTable.id, id));
  await recordActivity(
    "app",
    `Cleared the build cache for ${project.name}`,
    user.name,
    id,
  );
}

export async function setAppBuildServer(
  id: string,
  input: { buildServerId: string | null; buildFallback?: boolean },
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const project = await loadAppGraph(id);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");

  let buildServerId: string | null = null;
  if (input.buildServerId) {
    const servers = await listServersForTeam(membership.teamId);
    const picked = servers.find((s) => s.id === input.buildServerId);
    if (!picked) throw new Error("That server isn't available to this team.");
    if (picked.storageOnly)
      throw new Error(
        "That server holds backups only - it has no Docker to build with.",
      );
    if (picked.importOnly) throw new Error(ON_IMPORT_SOURCE);
    buildServerId = picked.id;
  }
  await getDb()
    .update(appsTable)
    .set({
      buildServerId,
      ...(input.buildFallback === undefined
        ? {}
        : { buildFallback: input.buildFallback }),
      updatedAt: nowIso(),
    })
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)));

  const where =
    buildServerId === null
      ? "automatically"
      : buildServerId === project.serverId
        ? "on its own server"
        : `on ${(await getServerById(buildServerId))?.name ?? buildServerId}`;
  await recordActivity(
    "app",
    `Set ${project.name} to build ${where}`,
    user.name,
    id,
  );
}
