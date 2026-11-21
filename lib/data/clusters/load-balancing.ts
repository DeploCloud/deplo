import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { appDisk } from "../../apps/failover-copy";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterDnsZones,
  clusterEntrances,
  clusterMembers as membersTable,
  clusterZoneCerts,
} from "../../db/schema/control-plane/clusters";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { appConnectorService } from "../../deploy/app-connector";
import { zoneCertCovers } from "../../deploy/dns-challenge";
import { appKeepsDataOnDisk } from "../../deploy/replicas";
import { STOP_SERVICES_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { connectAgent } from "../../infra/agent-client/connect";
import { getMetricsHistory } from "../../monitoring/history";
import { nowIso } from "../../ids";
import type { App } from "../../types/app";
import type { Cluster } from "../../types/cluster";
import { messageOf, usesComposeStack } from "../../utils";
import { loadAppGraph } from "../app-graph-load";
import { instanceFrozen } from "../deplo-move/freeze";
import { appHasTunnel } from "./app-tunnel";
import { clusterMemberFacts } from "./facts";
import { listWorkloadPlacements } from "./placement";
import { getClusterById } from "./roster";
import { sharedCertNames } from "./zone-certs";

// Load balancing: an App that keeps no data runs on every server of its cluster, each beside its Cloudflare
// connector. Cloudflare sends a visitor to the connector nearest them; "most available" runs one connector only.
// https://deplo.build/docs/operations/clusters/load-balancing

/** Another server has to have this much more room before the most available one changes, so it does not flap. */
export const ENTRANCE_MARGIN = 0.15;
/** A metrics sample older than this says nothing about the room a server has now. */
const LIVE_SAMPLE_MS = 2 * 60_000;

export const LB_NO_CLOUDFLARE =
  "Load balancing reaches it once it has a Cloudflare domain: without one, visitors reach only the server its address points at.";
export const LB_KEEPS_DATA =
  "It keeps data on its server, so it runs on one server: replication keeps that data ready on the others.";

export const LB_ANSWERS_EVERYWHERE =
  "A domain of it answers on every server, which carries every visitor to the one server that runs it.";

/** The reason an App stays on one server: these names have their certificate there only, until checked over DNS. */
export function lbOneServerNames(names: string[]): string {
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const have = names.length === 1 ? "has its" : "have their";
  return `It runs on one server: ${list} ${have} certificate on that server only. Add the _acme-challenge record its domain offers, and from its next deploy it runs on every server.`;
}

/**
 * Why load balancing passes this App by, or null when it spreads it. Its cluster must have it on. An App with a
 * domain that answers on every server spreads, with no Cloudflare, once every server holds each HTTPS name's
 * certificate (ADR-0048 step 5): `oneServer` is the names still on one server.
 */
export function loadBalancingSkips(
  app: App,
  hasTunnel: boolean,
  answersEverywhere = false,
  oneServer?: string[],
): string | null {
  if (appDisk(app) !== null || appKeepsDataOnDisk(app) || usesComposeStack(app))
    return LB_KEEPS_DATA;
  if (answersEverywhere) {
    if (!oneServer) return LB_ANSWERS_EVERYWHERE;
    return oneServer.length > 0 ? lbOneServerNames(oneServer) : null;
  }
  return hasTunnel ? null : LB_NO_CLOUDFLARE;
}

/**
 * The App's HTTPS names whose certificate only its own server holds: every custom one but those its Cloudflare tunnel
 * serves, the zone's certificate covers or its own shared certificate does, each valid now. A generated name follows
 * its server by being renamed (ADR-0048), so it is not one of them.
 */
export async function namesOnOneServer(appId: string): Promise<string[]> {
  const rows = await getDb()
    .select({
      name: domainsTable.name,
      ssl: domainsTable.ssl,
      source: domainsTable.source,
      tunnel: domainsTable.tunnel,
      mode: domainsTable.certChallenge,
      zoneId: domainsTable.dnsZoneId,
    })
    .from(domainsTable)
    .where(eq(domainsTable.appId, appId));
  const held = await heldCertificates(appId);
  return [
    ...new Set(
      rows
        .filter(
          (d) =>
            d.ssl &&
            d.source !== "auto" &&
            d.tunnel !== true &&
            !((d.mode === "zone" || d.mode === "shared") && held.has(d.name)),
        )
        .map((d) => d.name),
    ),
  ].sort();
}

/** The App's names every server of its cluster holds a valid certificate for: the zone's or a name's own. */
async function heldCertificates(appId: string): Promise<Set<string>> {
  const [app] = await getDb()
    .select({ clusterId: appsTable.clusterId })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  if (!app?.clusterId) return new Set();
  const now = Date.now();
  const zones = await getDb()
    .select({ name: clusterDnsZones.name, notAfter: clusterZoneCerts.notAfter })
    .from(clusterZoneCerts)
    .innerJoin(clusterDnsZones, eq(clusterDnsZones.id, clusterZoneCerts.zoneId))
    .where(eq(clusterDnsZones.clusterId, app.clusterId));
  const live = zones
    .filter((z) => z.notAfter && Date.parse(z.notAfter) > now)
    .map((z) => z.name);
  const out = new Set(await sharedCertNames(app.clusterId));
  const names = await getDb()
    .select({ name: domainsTable.name })
    .from(domainsTable)
    .where(
      and(
        eq(domainsTable.appId, appId),
        eq(domainsTable.certChallenge, "zone"),
      ),
    );
  for (const d of names)
    if (live.some((z) => zoneCertCovers(z, d.name))) out.add(d.name);
  return out;
}

/** Whether the App runs on every server of its cluster because the cluster balances its visitors. */
export async function appLoadBalanced(
  app: App,
  cluster?: Cluster | null,
): Promise<boolean> {
  if (!app.clusterId) return false;
  const c = cluster ?? (await getClusterById(app.clusterId));
  if (!c?.loadBalancingEnabled || !c.replicationEnabled) return false;
  return (await appLoadBalancingSkips(app)) === null;
}

/** The names that alone keep an App of a load-balanced cluster on one server, for its Replicas setting to name. */
export async function namesKeepingAppOnOneServer(
  app: App,
  cluster?: Cluster | null,
): Promise<string[]> {
  if (!app.clusterId) return [];
  const c = cluster ?? (await getClusterById(app.clusterId));
  if (!c?.loadBalancingEnabled || !c.replicationEnabled) return [];
  if (appDisk(app) !== null || appKeepsDataOnDisk(app) || usesComposeStack(app))
    return [];
  const [answering] = await getDb()
    .select({ id: domainsTable.id })
    .from(domainsTable)
    .where(
      and(
        eq(domainsTable.appId, app.id),
        eq(domainsTable.answersEverywhere, true),
      ),
    )
    .limit(1);
  return answering ? namesOnOneServer(app.id) : [];
}

/** Why load balancing passes the App by on its cluster, or null when it runs it on every server. */
export async function appLoadBalancingSkips(app: App): Promise<string | null> {
  const [answering] = await getDb()
    .select({ id: domainsTable.id })
    .from(domainsTable)
    .where(
      and(
        eq(domainsTable.appId, app.id),
        eq(domainsTable.answersEverywhere, true),
      ),
    )
    .limit(1);
  return loadBalancingSkips(
    app,
    await appHasTunnel(app.id),
    Boolean(answering),
    answering ? await namesOnOneServer(app.id) : undefined,
  );
}

/** How many replicas a load-balanced App runs: its own count, and at least one on every server that can take it. */
export function balancedReplicas(own: number, servers: number): number {
  return Math.max(own, servers);
}

/** How much room a server has, 0 to 1: free memory and idle processor from its live metrics, else what is placed. */
export function roomOf(
  sample: { memPct: number; cpu: number } | null,
  placedFreeShare: number | null,
): number {
  if (sample)
    return (
      (Math.max(0, 100 - sample.memPct) + Math.max(0, 100 - sample.cpu)) / 200
    );
  return placedFreeShare ?? 0;
}

/**
 * The server that takes every visitor: the one with the most room, unless the one taking them now is still online
 * and within the margin of it.
 */
export function chooseEntrance(
  candidates: { serverId: string; room: number }[],
  current: string | null,
): string | null {
  if (candidates.length === 0) return null;
  const best = [...candidates].sort(
    (a, b) => b.room - a.room || a.serverId.localeCompare(b.serverId),
  )[0];
  const now = candidates.find((c) => c.serverId === current);
  if (now && best.room - now.room < ENTRANCE_MARGIN) return now.serverId;
  return best.serverId;
}

function liveSample(serverId: string): { memPct: number; cpu: number } | null {
  const history = getMetricsHistory(serverId);
  const last = history[history.length - 1];
  return last && Date.now() - last.ts < LIVE_SAMPLE_MS ? last : null;
}

async function onlineMembers(clusterId: string) {
  const rows = await getDb()
    .select({
      id: membersTable.serverId,
      lease: membersTable.leaseState,
      emptying: membersTable.emptyingSince,
      status: serversTable.status,
      memoryMb: serversTable.memoryMb,
    })
    .from(membersTable)
    .innerJoin(serversTable, eq(serversTable.id, membersTable.serverId))
    .where(eq(membersTable.clusterId, clusterId));
  return rows.filter((r) => r.status === "online" && r.lease === "ok");
}

async function runsOn(appId: string): Promise<string[]> {
  const rows = (await listWorkloadPlacements("app", [appId])).get(appId) ?? [];
  return [
    ...new Set(rows.map((r) => r.serverId).filter((m): m is string => !!m)),
  ];
}

async function setConnector(
  serverId: string,
  slug: string,
  on: boolean,
): Promise<void> {
  const conn = await connectAgent(serverId);
  try {
    if (
      !on &&
      !(await conn.hello()).capabilities?.includes(STOP_SERVICES_CAPABILITY)
    )
      throw new Error("its server agent is too old to stop one part of an App");
    // Starting the stack again starts only what is stopped, and the connector once the App is ready.
    const r = on
      ? await conn.startStack(slug)
      : await conn.stopStack(slug, [appConnectorService(slug)]);
    if (!r.ok) throw new Error(r.error || "the server did not answer");
  } finally {
    conn.close();
  }
}

async function entranceOf(appId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ serverId: clusterEntrances.serverId })
    .from(clusterEntrances)
    .where(eq(clusterEntrances.appId, appId))
    .limit(1);
  return row?.serverId ?? null;
}

/** Where a load-balanced App's visitors go now, for its page: the most available server, or null for the nearest. */
export async function appEntrance(appId: string): Promise<string | null> {
  return entranceOf(appId);
}

/** One App on a cluster that sends visitors to its most available server: its connector runs there and nowhere else. */
async function balanceApp(
  app: App,
  members: Awaited<ReturnType<typeof onlineMembers>>,
  placedShare: Map<string, number>,
): Promise<void> {
  const on = (await runsOn(app.id)).filter((m) =>
    members.some((o) => o.id === m),
  );
  if (on.length === 0) return;
  const current = await entranceOf(app.id);
  const chosen = chooseEntrance(
    on.map((serverId) => ({
      serverId,
      room: roomOf(liveSample(serverId), placedShare.get(serverId) ?? null),
    })),
    current,
  );
  if (!chosen) return;
  // The new entrance opens before the others close, so visitors are never left with none.
  await setConnector(chosen, app.slug, true);
  if (chosen !== current)
    await getDb()
      .insert(clusterEntrances)
      .values({ appId: app.id, serverId: chosen, chosenAt: nowIso() })
      .onConflictDoUpdate({
        target: clusterEntrances.appId,
        set: { serverId: chosen, chosenAt: nowIso() },
      });
  for (const m of on)
    if (m !== chosen)
      await setConnector(m, app.slug, false).catch((e) =>
        console.warn(`[load-balancing] ${app.slug} on ${m}: ${messageOf(e)}`),
      );
}

async function balancedApps(cluster: Cluster): Promise<App[]> {
  const rows = await getDb()
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(eq(appsTable.clusterId, cluster.id));
  const out: App[] = [];
  for (const r of rows) {
    const app = await loadAppGraph(r.id);
    // Only an App with a Cloudflare connector has one to choose: one without is placed by its DNS answers.
    if (
      app &&
      (await appHasTunnel(app.id)) &&
      (await appLoadBalanced(app, cluster))
    )
      out.push(app);
  }
  return out;
}

/** Puts every App of the cluster on its most available server, as the cluster watch does twice a minute. */
export async function balanceClusterEntrances(
  clusterId: string,
): Promise<void> {
  if (await instanceFrozen()) return;
  const cluster = await getClusterById(clusterId);
  if (
    !cluster?.loadBalancingEnabled ||
    cluster.loadBalancingMode !== "most_available"
  )
    return;
  const members = await onlineMembers(cluster.id);
  const facts = await clusterMemberFacts(cluster.id);
  const placedShare = new Map(
    members.map((m) => [
      m.id,
      m.memoryMb > 0
        ? (facts.find((f) => f.id === m.id)?.freeMb ?? 0) / m.memoryMb
        : 0,
    ]),
  );
  for (const app of await balancedApps(cluster))
    await balanceApp(app, members, placedShare).catch((e) =>
      console.warn(`[load-balancing] ${app.slug}: ${messageOf(e)}`),
    );
}

let passing = false;

/** The watch's job: every cluster that sends visitors to its most available server. */
export async function runLoadBalancingPass(
  clusterIds: string[],
): Promise<void> {
  if (passing) return;
  passing = true;
  try {
    for (const id of clusterIds) await balanceClusterEntrances(id);
  } finally {
    passing = false;
  }
}

export function balanceEntrancesSoon(clusterId: string): void {
  void balanceClusterEntrances(clusterId).catch((e) =>
    console.warn(`[load-balancing] ${clusterId}: ${messageOf(e)}`),
  );
}

/** Back to the nearest server, or off: every server that runs an App takes its visitors again. */
export async function openClusterEntrances(clusterId: string): Promise<void> {
  const rows = await getDb()
    .select({ appId: clusterEntrances.appId })
    .from(clusterEntrances)
    .innerJoin(appsTable, eq(appsTable.id, clusterEntrances.appId))
    .where(eq(appsTable.clusterId, clusterId));
  const ids = rows.map((r) => r.appId);
  for (const id of ids) {
    const app = await loadAppGraph(id);
    if (!app) continue;
    for (const m of await runsOn(id))
      await setConnector(m, app.slug, true).catch((e) =>
        console.warn(`[load-balancing] ${app.slug} on ${m}: ${messageOf(e)}`),
      );
  }
  if (ids.length > 0)
    await getDb()
      .delete(clusterEntrances)
      .where(and(inArray(clusterEntrances.appId, ids)));
}

export function openEntrancesSoon(clusterId: string): void {
  void openClusterEntrances(clusterId).catch((e) =>
    console.warn(`[load-balancing] ${clusterId}: ${messageOf(e)}`),
  );
}
