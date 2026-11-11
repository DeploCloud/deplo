import "server-only";

import { and, desc, eq, gte, inArray, isNull, notInArray } from "drizzle-orm";
import { getDb } from "../../db/client";
import { activities } from "../../db/schema/control-plane/activity";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import {
  clusterLeaderKeys,
  clusters as clustersTable,
  failoverBundlePushes as pushes,
} from "../../db/schema/control-plane/clusters";
import { deployments } from "../../db/schema/control-plane/deployments";
import { decryptSecretOrThrow, encryptSecret, sha256Hex } from "../../crypto";
import { nowIso } from "../../ids";
import type { Cluster } from "../../types/cluster";
import { recordActivity } from "../activity";
import { instanceFrozen } from "../deplo-move/freeze";
import {
  type BundleMeta,
  askLeaderKey,
  dropLeaderBundle,
  listLeaderBundles,
  putLeaderBundle,
} from "./bundle-calls";
import { leaderHostOf } from "./host";
import { isBuiltImage } from "./images";
import { getClusterById } from "./roster";

const ACTOR = "Deplo";
const KIND = "app";

/** What a member's deploy received, and so all a leader needs to redeploy it. Nothing else goes in. */
export interface FailoverStack {
  slug: string;
  projectId: string;
  imageRef: string;
  composeYaml: string;
  network: string;
  env: Record<string, string>;
  registryAuth: { host: string; username: string; password: string }[];
  composeUpArgs: string[];
  /** The App's own tunnel run token, when it has one. */
  tunnelToken?: string;
  /** Services the member starts only once the App is ready: the tunnel's connector. */
  startAfterReady?: string[];
  /** The deploy's ready check and restart rule, in the agent's own JSON: the leader passes them on unread. */
  ready?: unknown;
  restartRule?: unknown;
  mounts?: { path: string; content: string }[];
  filesBindSources?: string[];
}

export interface FailoverBundle {
  v: 1;
  kind: typeof KIND;
  workload: string;
  deploymentId: string;
  stack: FailoverStack;
}

export function keyFingerprint(publicKey: string): string {
  return sha256Hex(publicKey).slice(0, 16);
}

/** The bundle as ciphertext only the leader holding the matching age identity can open. */
export async function sealBundle(
  bundle: FailoverBundle,
  publicKey: string,
): Promise<Uint8Array> {
  const age = await import("age-encryption");
  const e = new age.Encrypter();
  e.addRecipient(publicKey);
  return e.encrypt(JSON.stringify(bundle));
}

type KeyRow = typeof clusterLeaderKeys.$inferSelect;

async function keyRows(clusterId: string): Promise<KeyRow[]> {
  return getDb()
    .select()
    .from(clusterLeaderKeys)
    .where(eq(clusterLeaderKeys.clusterId, clusterId));
}

async function hostFor(serverId: string | null): Promise<string | null> {
  return (await leaderHostOf(serverId))?.id ?? null;
}

/** The key of the leader that leads now; the other one only stands by. */
const leading = (cluster: Cluster) => (k: KeyRow) =>
  k.serverId === (cluster.leaderTakeoverAt ? null : cluster.leaderServerId);

// A changed key replaces the old one, so every bundle is sealed again.
async function refreshKeyOf(
  cluster: Cluster,
  serverId: string | null,
): Promise<void> {
  const hostId = await hostFor(serverId);
  if (!hostId) return;
  const publicKey = await askLeaderKey(hostId);
  const db = getDb();
  const same = serverId
    ? eq(clusterLeaderKeys.serverId, serverId)
    : isNull(clusterLeaderKeys.serverId);
  const held = await db
    .select()
    .from(clusterLeaderKeys)
    .where(and(eq(clusterLeaderKeys.clusterId, cluster.id), same));
  if (held.some((k) => k.publicKey === publicKey)) return;
  await db.transaction(async (tx) => {
    for (const old of held) {
      await tx
        .delete(clusterLeaderKeys)
        .where(
          and(
            eq(clusterLeaderKeys.clusterId, cluster.id),
            eq(clusterLeaderKeys.publicKey, old.publicKey),
          ),
        );
      // Re-keyed: the stored bundle stays, and it is not at the new leader until it is sent.
      await tx
        .update(pushes)
        .set({ keyFingerprint: keyFingerprint(publicKey), pushedAt: null })
        .where(eq(pushes.keyFingerprint, keyFingerprint(old.publicKey)));
    }
    await tx.insert(clusterLeaderKeys).values({
      clusterId: cluster.id,
      publicKey,
      serverId,
      createdAt: nowIso(),
    });
  });
}

/**
 * Keeps the key of each leader that may lead: the one on another server and Deplo's own. A leader that does not
 * answer keeps the key it had; the key of a server the leader left is retired.
 */
export async function refreshLeaderKeys(cluster: Cluster): Promise<void> {
  const wanted = [...new Set([cluster.leaderServerId, null])];
  for (const serverId of wanted)
    await refreshKeyOf(cluster, serverId).catch(() => {});
  for (const k of await keyRows(cluster.id))
    if (!wanted.includes(k.serverId))
      await getDb()
        .delete(clusterLeaderKeys)
        .where(
          and(
            eq(clusterLeaderKeys.clusterId, cluster.id),
            eq(clusterLeaderKeys.publicKey, k.publicKey),
          ),
        );
}

async function recordOnce(
  app: { id: string; name: string; teamId: string },
  message: string,
): Promise<void> {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const seen = await getDb()
    .select({ id: activities.id })
    .from(activities)
    .where(
      and(
        eq(activities.appId, app.id),
        eq(activities.message, message),
        gte(activities.createdAt, since),
      ),
    )
    .limit(1);
  if (seen.length === 0)
    await recordActivity("app", message, ACTOR, app.id, app.teamId);
}

const cannotFailOver = (name: string, cluster: string, why: string) =>
  `${name} cannot fail over yet: ${why} Cluster ${cluster} will not move it to another server until that is fixed.`;

const UNREACHED =
  "Deplo could not reach the cluster's leader to hand it what it needs to restart this App elsewhere.";
const NOT_TAKEN =
  "the cluster's leader did not take its bundle. Deplo will send it again.";

type AppRow = { id: string; name: string; teamId: string };

/** What the leader needs to place this App without Deplo: its size, its Environment, its image and whether it has a domain. */
async function bundleMeta(
  appId: string,
  imageRef: string,
): Promise<BundleMeta> {
  const db = getDb();
  const [app] = await db
    .select({
      name: appsTable.name,
      environmentId: appsTable.environmentId,
      limit: appsTable.resourceMemLimitMb,
      createdAt: appsTable.createdAt,
      arch: serversTable.hostArch,
    })
    .from(appsTable)
    .leftJoin(serversTable, eq(serversTable.id, appsTable.serverId))
    .where(eq(appsTable.id, appId))
    .limit(1);
  const [dom] = await db
    .select({ id: domainsTable.id })
    .from(domainsTable)
    .where(eq(domainsTable.appId, appId))
    .limit(1);
  const built = isBuiltImage(imageRef);
  return {
    name: app?.name ?? "",
    environment: app?.environmentId ?? "",
    image: built ? imageRef : "",
    archs: built && app?.arch ? [app.arch] : [],
    limitMb: app?.limit ?? 0,
    peakMb: 0,
    hasDomain: Boolean(dom),
    createdAt: app?.createdAt ?? "",
  };
}

async function deliver(
  cluster: Cluster,
  app: AppRow,
  bundle: FailoverBundle,
  blob: string,
  keys: KeyRow[],
): Promise<string[]> {
  const failed: string[] = [];
  const db = getDb();
  const meta = await bundleMeta(app.id, bundle.stack.imageRef);
  for (const k of keys) {
    const fp = keyFingerprint(k.publicKey);
    const now = nowIso();
    await db
      .insert(pushes)
      .values({
        workloadKind: KIND,
        workloadId: app.id,
        keyFingerprint: fp,
        deploymentId: bundle.deploymentId,
        bundleEnc: blob,
        pushedAt: null,
      })
      .onConflictDoUpdate({
        target: [pushes.workloadKind, pushes.workloadId, pushes.keyFingerprint],
        set: {
          deploymentId: bundle.deploymentId,
          bundleEnc: blob,
          pushedAt: null,
        },
      });
    try {
      const hostId = await hostFor(k.serverId);
      if (!hostId) throw new Error("no leader host");
      await putLeaderBundle(hostId, {
        cluster: cluster.id,
        kind: KIND,
        id: app.id,
        deploymentId: bundle.deploymentId,
        sealed: await sealBundle(bundle, k.publicKey),
        meta,
      });
      await db
        .update(pushes)
        .set({ pushedAt: now })
        .where(
          and(
            eq(pushes.workloadKind, KIND),
            eq(pushes.workloadId, app.id),
            eq(pushes.keyFingerprint, fp),
          ),
        );
    } catch {
      failed.push(fp);
    }
  }
  return failed;
}

/** Seals and sends the bundle of a cluster App's deploy to every leader key; says why on Activity when it cannot. */
export async function pushFailoverBundle(input: {
  appId: string;
  deploymentId: string;
  stack: FailoverStack;
}): Promise<void> {
  if (await instanceFrozen()) return;
  const db = getDb();
  const [app] = await db
    .select({
      id: appsTable.id,
      name: appsTable.name,
      teamId: appsTable.teamId,
      clusterId: appsTable.clusterId,
    })
    .from(appsTable)
    .where(eq(appsTable.id, input.appId))
    .limit(1);
  if (!app?.clusterId) return;
  // A preview is placed by the same rule but never fails over (spec #176).
  const [dep] = await db
    .select({ previewId: deployments.previewId })
    .from(deployments)
    .where(eq(deployments.id, input.deploymentId))
    .limit(1);
  if (dep?.previewId) return;
  const cluster = await getClusterById(app.clusterId);
  if (!cluster) return;
  await refreshLeaderKeys(cluster);
  const keys = await keyRows(cluster.id);
  const lead = keys.find(leading(cluster));
  // A leader standing by without it is put right by the sweep; only the one that leads decides a failover.
  if (!lead)
    await recordOnce(app, cannotFailOver(app.name, cluster.name, UNREACHED));
  if (keys.length === 0) return;
  const bundle: FailoverBundle = {
    v: 1,
    kind: KIND,
    workload: app.id,
    deploymentId: input.deploymentId,
    stack: input.stack,
  };
  const failed = await deliver(
    cluster,
    app,
    bundle,
    encryptSecret(JSON.stringify(bundle)),
    keys,
  );
  await db.delete(pushes).where(
    and(
      eq(pushes.workloadKind, KIND),
      eq(pushes.workloadId, app.id),
      notInArray(
        pushes.keyFingerprint,
        keys.map((k) => keyFingerprint(k.publicKey)),
      ),
    ),
  );
  if (lead && failed.includes(keyFingerprint(lead.publicKey)))
    await recordOnce(app, cannotFailOver(app.name, cluster.name, NOT_TAKEN));
}

const inFlight = new Set<Promise<void>>();

/** Fire-and-forget after a successful deploy; the deploy never waits on, or fails with, the leader. */
export function scheduleFailoverBundle(
  input: Parameters<typeof pushFailoverBundle>[0],
): void {
  const p: Promise<void> = pushFailoverBundle(input)
    .catch((e) =>
      console.warn(
        `[failover-bundle] ${input.appId}: ${e instanceof Error ? e.message : String(e)}`,
      ),
    )
    .finally(() => void inFlight.delete(p));
  inFlight.add(p);
}

/** Resolves once every scheduled push has settled. */
export async function flushFailoverBundles(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

/** A workload leaving its cluster, or being deleted: its bundle goes from every leader and from here. */
export async function dropFailoverBundle(
  appId: string,
  clusterId: string | null,
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ fp: pushes.keyFingerprint })
    .from(pushes)
    .where(and(eq(pushes.workloadKind, KIND), eq(pushes.workloadId, appId)));
  await db
    .delete(pushes)
    .where(and(eq(pushes.workloadKind, KIND), eq(pushes.workloadId, appId)));
  const cluster = clusterId ? await getClusterById(clusterId) : null;
  if (!cluster || rows.length === 0) return;
  for (const k of await keyRows(cluster.id)) {
    try {
      const hostId = await hostFor(k.serverId);
      if (hostId)
        await dropLeaderBundle(hostId, {
          cluster: cluster.id,
          kind: KIND,
          id: appId,
        });
    } catch {
      // The leader's reconcile drops what no workload of the cluster owns.
    }
  }
}

async function liveDeploymentId(appId: string): Promise<string | null> {
  const [d] = await getDb()
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.appId, appId),
        eq(deployments.status, "ready"),
        isNull(deployments.previewId),
      ),
    )
    .orderBy(desc(deployments.seq))
    .limit(1);
  return d?.id ?? null;
}

/**
 * Puts a cluster's leaders right after a relink or a key change: whatever bundle a leader lacks for the
 * deployment that is live is sealed again and sent, and a bundle no App of the cluster owns is dropped.
 */
export async function reconcileClusterBundles(
  clusterId: string,
): Promise<void> {
  if (await instanceFrozen()) return;
  const cluster = await getClusterById(clusterId);
  if (!cluster) return;
  await refreshLeaderKeys(cluster);
  const keys = await keyRows(cluster.id);
  const lead = keys.find(leading(cluster));
  const db = getDb();
  const members: AppRow[] = await db
    .select({
      id: appsTable.id,
      name: appsTable.name,
      teamId: appsTable.teamId,
    })
    .from(appsTable)
    .where(eq(appsTable.clusterId, cluster.id));
  const held = new Map<string, Map<string, string> | null>();
  for (const k of keys) {
    try {
      const hostId = await hostFor(k.serverId);
      if (!hostId) throw new Error("no leader host");
      const list = await listLeaderBundles(hostId, cluster.id);
      held.set(
        k.publicKey,
        new Map(
          list
            .filter((b) => b.kind === KIND)
            .map((b) => [b.id, b.deploymentId]),
        ),
      );
      const owned = new Set(members.map((m) => m.id));
      for (const b of list)
        if (b.kind === KIND && !owned.has(b.id))
          await dropLeaderBundle(hostId, {
            cluster: cluster.id,
            kind: KIND,
            id: b.id,
          }).catch(() => {});
    } catch {
      held.set(k.publicKey, null);
    }
  }
  for (const app of members) {
    const live = await liveDeploymentId(app.id);
    if (!live) continue;
    const rows = await db
      .select()
      .from(pushes)
      .where(and(eq(pushes.workloadKind, KIND), eq(pushes.workloadId, app.id)));
    const source = rows.find((r) => r.deploymentId === live);
    const lacking = keys.filter((k) => {
      const list = held.get(k.publicKey);
      return !list || list.get(app.id) !== live;
    });
    if (!lead)
      await recordOnce(app, cannotFailOver(app.name, cluster.name, UNREACHED));
    if (lacking.length === 0) continue;
    if (!source) {
      if (lead && lacking.includes(lead))
        await recordOnce(
          app,
          cannotFailOver(
            app.name,
            cluster.name,
            "Deplo has no saved copy of its last deploy to give the cluster's leader. It is sent with the next deploy.",
          ),
        );
      continue;
    }
    const bundle = JSON.parse(
      decryptSecretOrThrow(source.bundleEnc, "a failover bundle"),
    ) as FailoverBundle;
    const failed = await deliver(
      cluster,
      app,
      bundle,
      source.bundleEnc,
      lacking,
    );
    if (lead && failed.includes(keyFingerprint(lead.publicKey)))
      await recordOnce(app, cannotFailOver(app.name, cluster.name, NOT_TAKEN));
  }
  const fps = keys.map((k) => keyFingerprint(k.publicKey));
  const ids = members.map((m) => m.id);
  if (ids.length > 0 && fps.length > 0)
    await db
      .delete(pushes)
      .where(
        and(
          eq(pushes.workloadKind, KIND),
          inArray(pushes.workloadId, ids),
          notInArray(pushes.keyFingerprint, fps),
        ),
      );
}

/** The sweep's job: every cluster's leaders hold the bundle of what is live. */
export async function reconcileFailoverBundles(): Promise<void> {
  if (await instanceFrozen()) return;
  const rows = await getDb()
    .select({ id: clustersTable.id })
    .from(clustersTable);
  for (const r of rows)
    await reconcileClusterBundles(r.id).catch((e) =>
      console.warn(
        `[failover-bundle] ${r.id}: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
}
