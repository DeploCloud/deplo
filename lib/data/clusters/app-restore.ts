import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import type { ProjectDescriptor } from "../../agent/gen/agent";
import { appDisk } from "../../apps/failover-copy";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import type { App } from "../../types/app";
import { usesComposeStack } from "../../utils";
import { loadAppGraph } from "../app-graph-load";
import { leftBehindKeep } from "../backups/left-behind";
import { ensureFailoverBackup } from "../databases/failover";
import {
  appHasFilesDir,
  composeStackVolumeHostNames,
  namedVolumeHostNames,
} from "../project-backup-descriptor";
import {
  type FailoverStack,
  cannotFailOver,
  dropFailoverBundle,
  inBackground,
  pushFailoverBundle,
  recordOnce,
  storedBundle,
} from "./bundles";
import { type RestoreSource, latestRestorable } from "./database-bundles";
import { getClusterById } from "./roster";

// An App that keeps data on its member's disk: a Bind never fails over, a Volume waits or moves with a backup (#204).
// https://deplo.build/docs/operations/clusters#apps-that-keep-data

/** What a member needs to put this App's Volumes and Files back. The stack itself comes from the bundle. */
function restoreDescriptor(app: App, stack: FailoverStack): ProjectDescriptor {
  const own = namedVolumeHostNames(app.slug, app.volumes);
  return {
    slug: app.slug,
    volumeNames: usesComposeStack(app)
      ? composeStackVolumeHostNames(app.slug, stack.composeYaml, own)
      : own,
    includeFiles: appHasFilesDir(app),
    composeYaml: "",
    envSnapshot: {},
    mounts: [],
    network: stack.network,
  };
}

/** The App's latest backup another member of its cluster can restore with Deplo away. */
export async function appRestoreSource(
  app: App,
  stack: FailoverStack,
): Promise<RestoreSource> {
  if (!app.clusterId) return { restore: null, why: null };
  return latestRestorable({
    kind: "app",
    id: app.id,
    teamId: app.teamId,
    serverId: app.serverId,
    clusterId: app.clusterId,
    project: restoreDescriptor(app, stack),
  });
}

/**
 * The bundle of a cluster App's deploy, by what it keeps on disk: none for a Bind, one with its latest backup
 * when it fails over on its own, and one without, so its leader makes it wait, otherwise.
 */
export async function pushAppBundle(input: {
  appId: string;
  deploymentId: string;
  stack: FailoverStack;
}): Promise<void> {
  const app = await loadAppGraph(input.appId);
  if (!app?.clusterId) return;
  const disk = appDisk(app);
  if (disk === "bind") {
    await dropFailoverBundle(app.id, app.clusterId);
    return;
  }
  if (disk !== "volume") return pushFailoverBundle(input);
  await ensureFailoverBackup(app, "app");
  const keep = await leftBehindKeep({
    teamId: app.teamId,
    kind: "app",
    id: app.id,
    project: restoreDescriptor(app, input.stack),
  });
  const kept = { ...input, ...(keep ? { keep } : {}) };
  if (!app.failoverFromBackup) return pushFailoverBundle(kept);
  const source = await appRestoreSource(app, input.stack);
  await pushFailoverBundle({
    ...kept,
    ...(source.restore ? { restore: source.restore } : {}),
  });
  const cluster = source.why ? await getClusterById(app.clusterId) : null;
  if (cluster && source.why)
    await recordOnce(app, cannotFailOver(app.name, cluster.name, source.why));
}

/** Sends the App's bundle again as its opt-in and latest backup stand now. Nothing was deployed yet: nothing to send. */
export async function refreshAppBundle(appId: string): Promise<void> {
  const held = await storedBundle(appId);
  if (!held) return;
  // The tunnel's token is read again at the push: the kept one may be of a tunnel that is gone.
  const stack = { ...held.stack };
  delete stack.tunnelToken;
  await pushAppBundle({ appId, deploymentId: held.deploymentId, stack });
}

/** Every App of the cluster that keeps a Volume has its 15-minute backup; the ones that came with a server get it here. */
export async function ensureVolumeAppBackups(clusterId: string): Promise<void> {
  const rows = await getDb()
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(eq(appsTable.clusterId, clusterId));
  for (const r of rows) {
    const app = await loadAppGraph(r.id);
    if (app && appDisk(app) === "volume")
      await ensureFailoverBackup(app, "app");
  }
}

/** Fire-and-forget after a successful deploy of an App. */
export function scheduleAppBundle(
  input: Parameters<typeof pushAppBundle>[0],
): void {
  inBackground(input.appId, () => pushAppBundle(input));
}

/** Fire-and-forget after a backup of an App: the leader of one that fails over on its own learns of it now. */
export function scheduleAppBundleRefresh(appId: string): void {
  inBackground(appId, async () => {
    const [app] = await getDb()
      .select({ auto: appsTable.failoverFromBackup })
      .from(appsTable)
      .where(eq(appsTable.id, appId))
      .limit(1);
    if (app?.auto) await refreshAppBundle(appId);
  });
}
