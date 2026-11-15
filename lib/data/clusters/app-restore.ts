import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import type { ProjectDescriptor } from "../../agent/gen/agent";
import { appDisk } from "../../apps/failover-copy";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { servicesOf } from "../../deploy/compose-lint/document";
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
  dropFailoverBundle,
  inBackground,
  pushFailoverBundle,
  recordOnce,
  storedBundle,
} from "./bundles";
import { type RestoreSource, latestRestorable } from "./database-bundles";
import { appEnv } from "../../deploy/build/deploy-env";
import { promotable, replicaRestore, replicaRows } from "./replica-state";
import { getClusterById } from "./roster";

// An App that keeps data on its member's disk: a Bind never fails over, a Volume moves only while its cluster
// replicates it, restored from the copy on the server that takes it, and waits for its server otherwise.
// https://deplo.build/docs/operations/clusters/apps-with-stored-data

/** What a member needs to put this App's Volumes and Files back. The stack itself comes from the bundle. */
export function restoreDescriptor(
  app: App,
  stack: FailoverStack,
): ProjectDescriptor {
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

const builtHere = (name: string) =>
  `${name} does not fail over yet: its compose file builds images, and they exist only on the server that built them. A compose file that names published images does.`;

const stackBuilds = (composeYaml: string) =>
  Object.values(servicesOf(composeYaml) ?? {}).some(
    (svc) => (svc as { build?: unknown } | null)?.build != null,
  );

/**
 * The bundle of a cluster App's deploy, by what it keeps on disk: none for a Bind, one that restores its newest
 * replicated copy while its cluster replicates it, and one without, so its leader makes it wait, otherwise.
 */
export async function pushAppBundle(input: {
  appId: string;
  deploymentId: string;
  stack: FailoverStack;
}): Promise<void> {
  const app = await loadAppGraph(input.appId);
  if (!app?.clusterId) return;
  // What a later change of its variables is compared with and put in place of.
  if (!input.stack.vars) {
    const vars = await appEnv(app.id, "production").catch(() => null);
    if (vars) input = { ...input, stack: { ...input.stack, vars } };
  }
  // ponytail: a stack's built images are not copied to the other members (one image per release); say so until they are.
  if (stackBuilds(input.stack.composeYaml))
    await recordOnce(app, builtHere(app.name));
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
  const cluster = await getClusterById(app.clusterId);
  if (!cluster?.replicationEnabled) return pushFailoverBundle(kept);
  const restore = promotable(await replicaRows([app.id]), app)
    ? replicaRestore(restoreDescriptor(app, input.stack))
    : null;
  // Before its first copy it waits; the cluster's banner and the App's page say so, and a copy that fails says why.
  await pushFailoverBundle({ ...kept, ...(restore ? { restore } : {}) });
}

/** Sends the App's bundle again as its cluster and its newest copy stand now, `edit` applied. Nothing deployed: nothing to send. */
export async function refreshAppBundle(
  appId: string,
  edit: (stack: FailoverStack) => FailoverStack = (s) => s,
): Promise<void> {
  const held = await storedBundle(appId);
  if (!held) return;
  // The tunnel's token is read again at the push: the kept one may be of a tunnel that is gone.
  const stack = edit({ ...held.stack });
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
