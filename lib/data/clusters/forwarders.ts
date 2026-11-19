import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import {
  appBuild,
  apps as appsTable,
} from "../../db/schema/control-plane/apps";
import {
  clusterMembers as membersTable,
  clusters as clustersTable,
} from "../../db/schema/control-plane/clusters";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { composeForwardedServices } from "../../deploy/compose-stack/compose-read";
import { stackName } from "../../deploy/deploy-key";
import {
  isForwardedApp,
  planNameForwarding,
  type ForwardedWorkload,
  type MemberForwarding,
} from "../../deploy/name-forwarders";
import { appNetwork } from "../../deploy/network";
import { portFor } from "../../deploy/ports";
import { setClusterForwarders } from "../../infra/agent-client/cluster-host";
import {
  proxyRestartsSeen,
  recordProxyRestarts,
  syncAnswerCertificates,
} from "./answer-certs";
import { AgentClusterForwardersUnsupportedError } from "../../infra/agent-client/errors";
import { instanceFrozen } from "../deplo-move/freeze";
import {
  answerTable,
  listClusterAnswers,
  recordAnswerRefusals,
  syncAnswerProxies,
} from "./answers";
import { listStandbys, listWorkloadPlacements } from "./placement";
import { fingerprintOf } from "./relay";
import { clusterMemberServerIds, getClusterById } from "./roster";
import { messageOf } from "../../utils";

// The control plane renders which names go on which member; each server agent only runs its own table (#200).

async function workloadsOf(clusterId: string): Promise<ForwardedWorkload[]> {
  const db = getDb();
  const apps = await db
    .select({
      id: appsTable.id,
      slug: appsTable.slug,
      teamId: appsTable.teamId,
      environmentId: appsTable.environmentId,
      serverId: appsTable.serverId,
      clusterId: appsTable.clusterId,
      source: appsTable.source,
      compose: appsTable.compose,
      dockerImage: appsTable.dockerImage,
      repoUrl: appsTable.repoUrl,
      port: appBuild.port,
    })
    .from(appsTable)
    .innerJoin(appBuild, eq(appBuild.appId, appsTable.id))
    .where(eq(appsTable.clusterId, clusterId));
  const dbs = await db
    .select({
      id: databasesTable.id,
      host: databasesTable.host,
      port: databasesTable.port,
      teamId: databasesTable.teamId,
      environmentId: databasesTable.environmentId,
      serverId: databasesTable.serverId,
    })
    .from(databasesTable)
    .where(eq(databasesTable.clusterId, clusterId));
  const [appPlacements, dbPlacements] = await Promise.all([
    listWorkloadPlacements(
      "app",
      apps.map((a) => a.id),
    ),
    listWorkloadPlacements(
      "database",
      dbs.map((d) => d.id),
    ),
  ]);
  const membersOf = (
    placed: { serverId: string | null }[] | undefined,
    fallback: string | null,
  ): string[] => {
    const ids = (placed ?? [])
      .map((p) => p.serverId)
      .filter((s): s is string => Boolean(s));
    return ids.length > 0 ? ids : fallback ? [fallback] : [];
  };
  const standbys = await listStandbys(clusterId);
  const out: ForwardedWorkload[] = [];
  for (const a of apps) {
    const forwarded = isForwardedApp({
      clusterId: a.clusterId,
      source: a.source,
      compose: a.compose,
      dockerImage: a.dockerImage,
      repo: a.repoUrl,
    });
    out.push({
      kind: "app",
      id: a.id,
      network: appNetwork(a),
      name: forwarded ? stackName(a.slug) : null,
      // A compose stack offers each of its services by its own name, as on one server (ADR-0047).
      services:
        !forwarded && a.compose
          ? composeForwardedServices(a.compose)
          : undefined,
      port: portFor({ build: a }),
      members: membersOf(appPlacements.get(a.id), a.serverId),
    });
  }
  for (const d of dbs)
    out.push({
      kind: "database",
      id: d.id,
      network: appNetwork(d),
      name: d.host,
      port: d.port,
      members: membersOf(dbPlacements.get(d.id), d.serverId),
      standbys: standbys
        .filter((s) => s.databaseId === d.id)
        .map((s) => s.serverId),
    });
  return out;
}

/** What every member of the cluster runs: the Environment's names, and no one else's. */
export async function planClusterForwarding(
  clusterId: string,
): Promise<Map<string, MemberForwarding>> {
  const fingerprints = new Map<string, string>();
  for (const id of await clusterMemberServerIds(clusterId)) {
    const fp = await fingerprintOf(id);
    if (fp) fingerprints.set(id, fp);
  }
  const plan = planNameForwarding({
    workloads: await workloadsOf(clusterId),
    fingerprints,
  });
  // Only servers of this cluster ever get a table, whatever a stale placement names.
  for (const id of [...plan.keys()]) if (!fingerprints.has(id)) plan.delete(id);
  return plan;
}

function message(e: unknown): string {
  return messageOf(e).replace(/\s+/g, " ").slice(0, 300);
}

/** Hands each member of the cluster its table; one that cannot be reached is named in the log and left for the next sweep. */
export async function syncNameForwarders(clusterId: string): Promise<void> {
  if (await instanceFrozen()) return;
  const members = await clusterMemberServerIds(clusterId);
  const plan = await planClusterForwarding(clusterId);
  // Every member answers for every App with a domain that answers everywhere (ADR-0048).
  const answers = await listClusterAnswers(clusterId);
  const cluster = answers.length > 0 ? await getClusterById(clusterId) : null;
  const passOn = {
    ...answerTable(answers),
    answerMaxConns: cluster?.answerMaxConnections ?? 0,
    answerMaxWaiting: cluster?.answerMaxWaiting ?? 0,
  };
  const roster: { serverId: string; fingerprint: string }[] = [];
  for (const serverId of members) {
    const fingerprint = await fingerprintOf(serverId);
    if (fingerprint) roster.push({ serverId, fingerprint });
  }
  for (const serverId of members) {
    if (await instanceFrozen()) return;
    const mine = plan.get(serverId);
    try {
      const res = await setClusterForwarders(serverId, {
        clusterId,
        members: roster,
        hold: mine?.hold ?? [],
        serve: mine?.serve ?? [],
        ...passOn,
        proxyRestartsSeenMs: proxyRestartsSeen(serverId),
      });
      if (res.answerRefusals.length > 0)
        await recordAnswerRefusals(clusterId, serverId, res.answerRefusals);
      await recordProxyRestarts(serverId, res.proxyRestarts ?? []);
    } catch (e) {
      // A member with nothing to run and an agent too old to take the table is not a problem.
      if (
        !mine?.involved &&
        answers.length === 0 &&
        e instanceof AgentClusterForwardersUnsupportedError
      )
        continue;
      console.warn(
        `[cluster-forwarders] ${clusterId} -> ${serverId}: ${message(e)}`,
      );
    }
  }
  // After the tables: a proxy that mounts the routes file finds it written.
  await syncAnswerProxies(clusterId, answers.length > 0);
  // Each App's certificates follow it into its bundle; a switch turned off takes them out (ADR-0048).
  await syncAnswerCertificates(clusterId).catch((e) =>
    console.warn(`[answer-certs] ${clusterId}: ${message(e)}`),
  );
}

/** After a deploy or a placement change: off the caller's lane, and it never throws. */
/**
 * A domain just switched on: every proxy of the cluster passes it on first, and only then does the App's router ask
 * for a certificate, so the order's check reaches a proxy that is up wherever it lands (ADR-0048).
 */
export async function routeAfterAnswers(
  clusterId: string,
  appId: string,
  deps: {
    sync?: (clusterId: string) => Promise<void>;
    reroute?: (appId: string) => Promise<unknown>;
  } = {},
): Promise<void> {
  const sync = deps.sync ?? syncNameForwarders;
  const reroute =
    deps.reroute ??
    (async (id: string) =>
      (await import("../../deploy/build/reroute")).rerouteApp(id));
  await sync(clusterId);
  await reroute(appId);
}

export function syncNameForwardersSoon(clusterId: string): void {
  void syncNameForwarders(clusterId).catch((e) =>
    console.warn(`[cluster-forwarders] ${clusterId}: ${message(e)}`),
  );
}

/** The sweep's job: a member that joined, left or came back gets its table. */
export async function reconcileNameForwarders(): Promise<void> {
  const rows = await getDb()
    .select({ id: clustersTable.id })
    .from(clustersTable);
  for (const c of rows) {
    if (await instanceFrozen()) return;
    await syncNameForwarders(c.id);
  }
}

/** The deploy's tail for a cluster App: its name may now be on a member that held none. */
export function syncNameForwardersAfterDeploy(depId: string): void {
  void (async () => {
    const dep = (
      await getDb()
        .select({ clusterId: appsTable.clusterId })
        .from(deploymentsTable)
        .innerJoin(appsTable, eq(appsTable.id, deploymentsTable.appId))
        .where(eq(deploymentsTable.id, depId))
        .limit(1)
    )[0];
    if (dep?.clusterId) await syncNameForwarders(dep.clusterId);
  })().catch((e) =>
    console.warn(`[cluster-forwarders] ${depId}: ${message(e)}`),
  );
}

/**
 * Every 2 minutes from the cluster watch. The clusters that pass domains on are synced, which hands each agent its
 * table and hears what it turned away. Then every server's proxy that has the change without needing it is put back,
 * decided from the proxy itself, not from what Deplo remembers: after a restart of Deplo, a deleted cluster, a server
 * that left one or an App moved out, a cluster's servers are synced again and a server in no cluster loses it alone.
 */
export async function syncAnsweringClusters(): Promise<void> {
  if (await instanceFrozen()) return;
  const { answerSupportOn, clustersWithAnswers, syncAnswerProxy } =
    await import("./answers");
  const answering = new Set(await clustersWithAnswers());
  for (const id of answering) {
    if (await instanceFrozen()) return;
    await syncNameForwarders(id).catch((e) =>
      console.warn(`[cluster-forwarders] ${id}: ${message(e)}`),
    );
  }
  const servers = await getDb()
    .select({ id: serversTable.id, clusterId: membersTable.clusterId })
    .from(serversTable)
    .leftJoin(membersTable, eq(membersTable.serverId, serversTable.id));
  const stale = new Set<string>();
  for (const s of servers) {
    if (s.clusterId && answering.has(s.clusterId)) continue;
    if (!(await answerSupportOn(s.id))) continue;
    if (s.clusterId) stale.add(s.clusterId);
    else
      await syncAnswerProxy(s.id, false).catch((e) =>
        console.warn(`[cluster-answers] ${s.id}: ${message(e)}`),
      );
  }
  for (const id of stale) {
    if (await instanceFrozen()) return;
    await syncNameForwarders(id).catch((e) =>
      console.warn(`[cluster-forwarders] ${id}: ${message(e)}`),
    );
  }
}
