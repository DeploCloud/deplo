import "server-only";

import { promises as dnsp } from "node:dns";
import { and, asc, eq, or, sql } from "drizzle-orm";

import { getCurrentUser } from "../../auth/current-user";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterDnsZones,
  clusterMembers,
  clusterNameServers,
  clusters as clustersTable,
  clusterZoneStates,
} from "../../db/schema/control-plane/clusters";
import { domainDnsRecords } from "../../db/schema/control-plane/dns-providers";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import {
  chooseNameServers,
  cleanZoneName,
  delegationRecords,
  dnsTimesRefusal,
  renderClusterZone,
  zoneTarget,
  type NameServerChoice,
  type ZoneServer,
} from "../../deploy/cluster-zone";
import { zoneCovers } from "../../dns-zone";
import { newId, nowIso } from "../../ids";
import { setClusterZone } from "../../infra/agent-client/cluster-host";
import { AgentClusterZoneUnsupportedError } from "../../infra/agent-client/errors";
import { requireInstanceAdmin } from "../../membership";
import { messageOf } from "../../utils";
import { recordActivity } from "../activity";
import { loadAppGraph } from "../app-graph-load";
import { instanceFrozen } from "../deplo-move/freeze";
import { withKeyedLock } from "../keyed-mutex";
import { requireAppCapability } from "../node-access";
import { serverAddresses } from "../servers/addresses";
import { getServerById } from "../servers/roster";
import type { ClusterDnsView, DelegationCheck } from "../../types/cluster-dns";
import { recordClusterActivity } from "./cluster-activity";
import { checkDelegation } from "./dns-delegation";
import { fingerprintOf } from "./relay";
import { getClusterById, requireClusterAdmin } from "./roster";

// A cluster's own DNS zone (ADR-0049): https://deplo.build/docs/operations/clusters/dns-zone

export type ZoneMemberFacts = {
  serverId: string;
  name: string;
  fingerprint: string | null;
  v4: string[];
  v6: string[];
  emptying: boolean;
  joinedAt: string;
};

async function zonesOf(clusterId: string) {
  return getDb()
    .select()
    .from(clusterDnsZones)
    .where(eq(clusterDnsZones.clusterId, clusterId))
    .orderBy(asc(clusterDnsZones.createdAt), asc(clusterDnsZones.name));
}

async function memberFacts(clusterId: string): Promise<ZoneMemberFacts[]> {
  const rows = await getDb()
    .select({
      serverId: clusterMembers.serverId,
      joinedAt: clusterMembers.joinedAt,
      emptying: clusterMembers.emptyingSince,
    })
    .from(clusterMembers)
    .where(eq(clusterMembers.clusterId, clusterId))
    .orderBy(asc(clusterMembers.joinedAt), asc(clusterMembers.serverId));
  return Promise.all(
    rows.map(async (r) => {
      const server = await getServerById(r.serverId);
      const a = await serverAddresses(server);
      return {
        serverId: r.serverId,
        name: server?.name ?? r.serverId,
        fingerprint: await fingerprintOf(r.serverId),
        v4: a.v4,
        v6: a.v6,
        emptying: r.emptying != null,
        joinedAt: r.joinedAt,
      };
    }),
  );
}

type ZoneRow = typeof clusterDnsZones.$inferSelect;

/** The domains each zone answers: those in it, and those whose CNAME the person pointed into it. */
async function zoneDomains(
  clusterId: string,
  zones: ZoneRow[],
): Promise<Map<string, { domainId: string; name: string; target: string }[]>> {
  const rows = await getDb()
    .select({
      id: domainsTable.id,
      name: domainsTable.name,
      zoneId: domainsTable.dnsZoneId,
      tunnel: domainsTable.tunnel,
    })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId))
    .where(
      and(
        eq(appsTable.clusterId, clusterId),
        eq(domainsTable.answersEverywhere, true),
      ),
    );
  const out = new Map(
    zones.map((z) => [
      z.id,
      [] as { domainId: string; name: string; target: string }[],
    ]),
  );
  for (const d of rows) {
    if (d.tunnel === true) continue;
    const zone = nativeZoneOf(d, zones);
    if (zone)
      out.get(zone.id)!.push({
        domainId: d.id,
        name: d.name,
        target: zoneTarget(d.name, zone.name),
      });
  }
  return out;
}

/** The zone that answers a domain: the deepest zone it is in, else the one its CNAME was pointed at. */
export function nativeZoneOf<Z extends { id: string; name: string }>(
  d: { name: string; zoneId: string | null },
  zones: Z[],
): Z | null {
  const inside = zones
    .filter((z) => zoneCovers(z.name, d.name))
    .sort((a, b) => b.name.length - a.name.length)[0];
  return inside ?? zones.find((z) => z.id === d.zoneId) ?? null;
}

async function currentChoice(clusterId: string): Promise<NameServerChoice[]> {
  return getDb()
    .select({
      position: clusterNameServers.position,
      serverId: clusterNameServers.serverId,
    })
    .from(clusterNameServers)
    .where(eq(clusterNameServers.clusterId, clusterId))
    .orderBy(asc(clusterNameServers.position));
}

async function statesOf(clusterId: string) {
  return getDb()
    .select()
    .from(clusterZoneStates)
    .where(eq(clusterZoneStates.clusterId, clusterId));
}

const sameChoice = (a: NameServerChoice[], b: NameServerChoice[]) =>
  a.length === b.length &&
  a.every(
    (c, i) => c.position === b[i].position && c.serverId === b[i].serverId,
  );

async function saveChoice(clusterId: string, choice: NameServerChoice[]) {
  await getDb().transaction(async (tx) => {
    await tx
      .delete(clusterNameServers)
      .where(eq(clusterNameServers.clusterId, clusterId));
    if (choice.length > 0)
      await tx
        .insert(clusterNameServers)
        .values(choice.map((c) => ({ clusterId, ...c })));
  });
}

async function saveState(
  clusterId: string,
  serverId: string,
  s: { serving: boolean; problem: string; state: string; heard: number },
) {
  const row = { clusterId, serverId, ...s, checkedAt: nowIso() };
  await getDb()
    .insert(clusterZoneStates)
    .values(row)
    .onConflictDoUpdate({
      target: [clusterZoneStates.clusterId, clusterZoneStates.serverId],
      set: row,
    });
}

const STOP = (clusterId: string) => ({
  clusterId,
  selfFingerprint: "",
  zones: [],
  servers: [],
  nameServers: [],
  answerTtlSeconds: 0,
  dropAfterSeconds: 0,
});

/**
 * Hands every member its cluster's zones and reads back how each answers; picks the name servers from those that can.
 * A server that left the cluster, or a cluster with no zone left, is told to stop.
 */
export async function syncClusterZone(clusterId: string): Promise<void> {
  if (await instanceFrozen()) return;
  await withKeyedLock(`cluster-zone:${clusterId}`, async () => {
    const cluster = await getClusterById(clusterId);
    const zones = cluster ? await zonesOf(clusterId) : [];
    const members = zones.length > 0 ? await memberFacts(clusterId) : [];
    const keep = new Set(members.map((m) => m.serverId));
    for (const st of await statesOf(clusterId)) {
      if (keep.has(st.serverId)) continue;
      try {
        await setClusterZone(st.serverId, STOP(clusterId));
      } catch (e) {
        if (!(e instanceof AgentClusterZoneUnsupportedError)) {
          console.warn(
            `[cluster-zone] ${clusterId}: stopping ${st.serverId}: ${messageOf(e)}`,
          );
          continue;
        }
      }
      await getDb()
        .delete(clusterZoneStates)
        .where(
          and(
            eq(clusterZoneStates.clusterId, clusterId),
            eq(clusterZoneStates.serverId, st.serverId),
          ),
        );
    }
    if (!cluster || members.length === 0) return;
    const byZone = await zoneDomains(clusterId, zones);
    const servers: ZoneServer[] = members
      .filter((m) => m.fingerprint)
      .map((m) => ({
        fingerprint: m.fingerprint!,
        v4: m.v4,
        v6: m.v6,
        emptying: m.emptying,
      }));
    const fpOf = new Map(members.map((m) => [m.serverId, m.fingerprint]));

    const pick = async (current: NameServerChoice[]) => {
      const states = new Map(
        (await statesOf(clusterId)).map((s) => [s.serverId, s]),
      );
      return chooseNameServers(
        current,
        members.map((m) => {
          const st = states.get(m.serverId);
          return {
            serverId: m.serverId,
            joinedAt: m.joinedAt,
            member: true,
            eligible:
              m.fingerprint != null &&
              !m.emptying &&
              m.v4.length + m.v6.length > 0 &&
              st?.serving === true &&
              st.state !== "unsupported",
          };
        }),
      );
    };
    const send = async (choice: NameServerChoice[]) => {
      const nameServers = choice
        .map((c) => fpOf.get(c.serverId))
        .filter((fp): fp is string => !!fp);
      const prev = new Map(
        (await statesOf(clusterId)).map((s) => [s.serverId, s]),
      );
      for (const m of members) {
        if (!m.fingerprint) continue;
        const req = renderClusterZone({
          clusterId,
          self: m.fingerprint,
          zones: zones.map((z) => ({
            name: z.name,
            names: byZone.get(z.id)!.map((d) => d.target),
          })),
          servers,
          nameServers,
          ttl: cluster.dnsAnswerTtl,
          dropAfter: cluster.dnsDropAfter,
        });
        try {
          const r = await setClusterZone(m.serverId, req);
          await saveState(clusterId, m.serverId, {
            serving: r.listening.length > 0,
            problem: r.problem,
            state: r.state,
            heard: r.heard,
          });
        } catch (e) {
          const unsupported = e instanceof AgentClusterZoneUnsupportedError;
          // Not heard from: it keeps answering what it had, and keeps its place as a name server.
          await saveState(clusterId, m.serverId, {
            serving: unsupported
              ? false
              : (prev.get(m.serverId)?.serving ?? false),
            problem: messageOf(e),
            state: unsupported ? "unsupported" : "unreachable",
            heard: 0,
          });
        }
      }
    };

    const before = await currentChoice(clusterId);
    let choice = await pick(before);
    if (!sameChoice(before, choice)) await saveChoice(clusterId, choice);
    await send(choice);
    // A server just found able to answer may fill a free place: hand everyone the new list at once.
    const after = await pick(choice);
    if (!sameChoice(after, choice)) {
      choice = after;
      await saveChoice(clusterId, choice);
      await send(choice);
    }
    // A name server gone or renumbered changes records at the registrar; one added in a free place only adds one.
    const moved = before.filter(
      (b) =>
        !choice.some(
          (c) => c.serverId === b.serverId && c.position === b.position,
        ),
    );
    if (moved.length > 0) {
      const names = zones.map((z) => z.name).join(", ");
      await recordClusterActivity(
        clusterId,
        `The name servers of ${cluster.name}'s DNS ${zones.length === 1 ? "zone" : "zones"} ${names} changed: update the records where the domain was bought, as the cluster's settings list them`,
      );
    }
  });
}

/** Fire-and-forget for a change that moves what the zone answers. */
export function syncClusterZoneSoon(clusterId: string): void {
  void syncClusterZone(clusterId).catch((e) =>
    console.warn(`[cluster-zone] ${clusterId}: ${messageOf(e)}`),
  );
}

/** Every cluster with a zone, or with servers still answering for one that is gone; once a minute. */
export async function reconcileClusterZones(): Promise<void> {
  if (await instanceFrozen()) return;
  const ids = new Set<string>();
  for (const r of await getDb()
    .selectDistinct({ id: clusterDnsZones.clusterId })
    .from(clusterDnsZones))
    ids.add(r.id);
  for (const r of await getDb()
    .selectDistinct({ id: clusterZoneStates.clusterId })
    .from(clusterZoneStates))
    ids.add(r.id);
  for (const id of ids)
    await syncClusterZone(id).catch((e) =>
      console.warn(`[cluster-zone] ${id}: ${messageOf(e)}`),
    );
}

/** The cluster's zones, the records to add for each, its name servers and how every server answers. */
export async function clusterDnsView(
  clusterId: string,
): Promise<ClusterDnsView> {
  await requireInstanceAdmin();
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  const zones = await zonesOf(clusterId);
  const members = zones.length > 0 ? await memberFacts(clusterId) : [];
  const byId = new Map(members.map((m) => [m.serverId, m]));
  const choice = await currentChoice(clusterId);
  const ns = choice
    .map((c) => byId.get(c.serverId))
    .filter((m): m is ZoneMemberFacts => !!m);
  const byZone = await zoneDomains(clusterId, zones);
  const states = await statesOf(clusterId);
  return {
    zones: zones.map((z) => ({
      id: z.id,
      name: z.name,
      records: delegationRecords(z.name, ns),
      names: byZone.get(z.id)!.map((d) => d.target),
    })),
    nameServers: choice.map((c) => ({
      position: c.position,
      serverId: c.serverId,
      serverName: byId.get(c.serverId)?.name ?? c.serverId,
    })),
    servers: states
      .filter((s) => byId.has(s.serverId))
      .map((s) => ({
        serverId: s.serverId,
        serverName: byId.get(s.serverId)!.name,
        serving: s.serving,
        problem: s.problem,
        state: s.state,
        heard: s.heard,
        checkedAt: s.checkedAt,
      })),
    answerTtl: cluster.dnsAnswerTtl,
    dropAfter: cluster.dnsDropAfter,
  };
}

/** Delegates a zone to a cluster: its servers answer for it once the registrar points there. */
export async function addClusterDnsZone(
  clusterId: string,
  raw: string,
): Promise<string> {
  if (await instanceFrozen())
    throw new Error(
      "Deplo is moving to another machine; try again once it is done.",
    );
  const { teamId, user } = await requireClusterAdmin();
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  const clean = cleanZoneName(raw);
  if (clean.error !== undefined) throw new Error(clean.error);
  const name = clean.name;
  const clash = await getDb()
    .select({ name: clusterDnsZones.name, cluster: clustersTable.name })
    .from(clusterDnsZones)
    .innerJoin(clustersTable, eq(clustersTable.id, clusterDnsZones.clusterId))
    .where(
      or(
        eq(clusterDnsZones.name, name),
        sql`${name} like '%.' || ${clusterDnsZones.name}`,
        sql`${clusterDnsZones.name} like '%.' || ${name}`,
      ),
    )
    .limit(1);
  if (clash[0])
    throw new Error(
      clash[0].name === name
        ? `${name} is already answered by cluster ${clash[0].cluster}.`
        : `${name} overlaps ${clash[0].name}, which cluster ${clash[0].cluster} answers. A zone and a zone inside it cannot both be delegated here.`,
    );
  const id = newId("czone");
  await getDb()
    .insert(clusterDnsZones)
    .values({ id, clusterId, name, createdAt: nowIso() });
  await recordActivity(
    "server",
    `Cluster ${cluster.name} now answers for the DNS zone ${name}, once it is delegated where the domain was bought`,
    user.name,
    null,
    teamId,
  );
  syncClusterZoneSoon(clusterId);
  return id;
}

/** Takes a zone off its cluster; the domains it answered go back to records written elsewhere. */
export async function removeClusterDnsZone(zoneId: string): Promise<string> {
  if (await instanceFrozen())
    throw new Error(
      "Deplo is moving to another machine; try again once it is done.",
    );
  const { teamId, user } = await requireClusterAdmin();
  const [zone] = await getDb()
    .select()
    .from(clusterDnsZones)
    .where(eq(clusterDnsZones.id, zoneId))
    .limit(1);
  if (!zone) throw new Error("DNS zone not found");
  const cluster = await getClusterById(zone.clusterId);
  await getDb().delete(clusterDnsZones).where(eq(clusterDnsZones.id, zoneId));
  await recordActivity(
    "server",
    `Cluster ${cluster?.name ?? zone.clusterId} no longer answers for the DNS zone ${zone.name}`,
    user.name,
    null,
    teamId,
  );
  syncClusterZoneSoon(zone.clusterId);
  return zone.clusterId;
}

/** How long resolvers keep an answer, and how long a stopped server stays in it. */
export async function setClusterDnsTimes(
  clusterId: string,
  ttl: number,
  dropAfter: number,
): Promise<void> {
  if (await instanceFrozen())
    throw new Error(
      "Deplo is moving to another machine; try again once it is done.",
    );
  const { teamId, user } = await requireClusterAdmin();
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  const why = dnsTimesRefusal(ttl, dropAfter);
  if (why) throw new Error(why);
  if (cluster.dnsAnswerTtl === ttl && cluster.dnsDropAfter === dropAfter)
    return;
  await getDb()
    .update(clustersTable)
    .set({ dnsAnswerTtl: ttl, dnsDropAfter: dropAfter })
    .where(eq(clustersTable.id, clusterId));
  await recordActivity(
    "server",
    `Cluster ${cluster.name}'s DNS answers now last ${ttl} s, and a stopped server leaves them after ${dropAfter} s`,
    user.name,
    null,
    teamId,
  );
  syncClusterZoneSoon(clusterId);
}

/** Whether a zone is delegated to its cluster, and what to fix if not. */
export async function checkClusterDnsZone(
  zoneId: string,
): Promise<DelegationCheck> {
  await requireInstanceAdmin();
  const [zone] = await getDb()
    .select()
    .from(clusterDnsZones)
    .where(eq(clusterDnsZones.id, zoneId))
    .limit(1);
  if (!zone) throw new Error("DNS zone not found");
  const members = await memberFacts(zone.clusterId);
  const byId = new Map(members.map((m) => [m.serverId, m]));
  const expected = (await currentChoice(zone.clusterId))
    .map((c) => byId.get(c.serverId))
    .filter((m): m is ZoneMemberFacts => !!m)
    .map((m, i) => ({ name: `ns${i + 1}.${zone.name}`, v4: m.v4, v6: m.v6 }));
  if (expected.length === 0)
    return {
      delegated: false,
      parent: null,
      problems: [
        "No server of the cluster answers on port 53 yet, so there is no name server to delegate to.",
      ],
      nameServers: [],
    };
  return checkDelegation(zone.name, expected);
}

/** The zones of an App's cluster, for its domains to point at. */
export async function appDnsZones(
  appId: string,
): Promise<{ id: string; name: string }[]> {
  await requireAppCapability(appId, "view");
  const app = await loadAppGraph(appId);
  if (!app?.clusterId) return [];
  return (await zonesOf(app.clusterId)).map((z) => ({
    id: z.id,
    name: z.name,
  }));
}

/** Every address of every member: a resolver may still hold one that stopped a moment ago. */
export async function clusterMemberAddresses(
  clusterId: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const m of await memberFacts(clusterId))
    for (const a of [...m.v4, ...m.v6]) out.add(a);
  return out;
}

/** The zone that answers a domain of this cluster, and the name in it, or null when the domain is not answered there. */
export async function domainNativeZone(
  clusterId: string,
  d: { name: string; zoneId: string | null },
): Promise<{ zone: string; target: string } | null> {
  const z = nativeZoneOf(d, await zonesOf(clusterId));
  return z ? { zone: z.name, target: zoneTarget(d.name, z.name) } : null;
}

/** Whether a name is the bare apex of a domain (it has its own SOA), which no CNAME can carry. */
async function isApex(name: string): Promise<boolean> {
  const soa = await Promise.race([
    dnsp.resolveSoa(name).then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
  ]);
  return soa;
}

let apexCheck = isApex;
export function __setApexCheckForTest(
  fn: ((name: string) => Promise<boolean>) | null,
): void {
  apexCheck = fn ?? isApex;
}

/** Lets the App's cluster answer for a domain through one of its zones, or (null) goes back to records. */
export async function setDomainDnsZone(
  domainId: string,
  zoneId: string | null,
): Promise<string> {
  if (await instanceFrozen())
    throw new Error(
      "Deplo is moving to another machine; try again once it is done.",
    );
  const [d] = await getDb()
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.id, domainId))
    .limit(1);
  if (!d) throw new Error("Not found");
  const { membership } = await requireAppCapability(d.appId, "manage_domains");
  const app = await loadAppGraph(d.appId);
  if (!app || app.teamId !== membership.teamId) throw new Error("Not found");
  const user = await getCurrentUser();
  if ((d.dnsZoneId ?? null) === zoneId) return d.appId;
  let zoneName = "";
  if (zoneId) {
    const [zone] = await getDb()
      .select()
      .from(clusterDnsZones)
      .where(eq(clusterDnsZones.id, zoneId))
      .limit(1);
    if (!zone || zone.clusterId !== app.clusterId)
      throw new Error("That DNS zone is not one of this App's cluster.");
    if (!d.answersEverywhere)
      throw new Error(
        `Turn on "Answer on every server" for ${d.name} first: the cluster answers only for those.`,
      );
    const [provider] = await getDb()
      .select({ id: domainDnsRecords.domainId })
      .from(domainDnsRecords)
      .where(eq(domainDnsRecords.domainId, d.id));
    if (provider && !zoneCovers(zone.name, d.name))
      throw new Error(
        `${d.name}'s records are written at your connected DNS provider, which keeps them right already.`,
      );
    if (!zoneCovers(zone.name, d.name) && (await apexCheck(d.name)))
      throw new Error(
        `${d.name} is a bare domain, and DNS gives no way to point one at another name. Add ${d.name} itself as a zone of the cluster, or use an ALIAS record at a DNS provider that offers one.`,
      );
    zoneName = zone.name;
  }
  await getDb()
    .update(domainsTable)
    .set({ dnsZoneId: zoneId })
    .where(eq(domainsTable.id, d.id));
  await recordActivity(
    "domain",
    zoneId
      ? `${d.name} is answered by the cluster's DNS zone ${zoneName}`
      : `${d.name} is no longer answered by the cluster's DNS zone`,
    user?.name ?? "Deplo",
    d.appId,
    membership.teamId,
  );
  if (app.clusterId) syncClusterZoneSoon(app.clusterId);
  return d.appId;
}

/** The record a domain answered by the cluster needs, if any: the CNAME into the zone, or none inside it. */
export async function domainZoneTargets(
  appId: string,
): Promise<Map<string, { zone: string; target: string | null }>> {
  const app = await loadAppGraph(appId);
  const out = new Map<string, { zone: string; target: string | null }>();
  if (!app?.clusterId) return out;
  const zones = await zonesOf(app.clusterId);
  if (zones.length === 0) return out;
  const rows = await getDb()
    .select({
      id: domainsTable.id,
      name: domainsTable.name,
      zoneId: domainsTable.dnsZoneId,
    })
    .from(domainsTable)
    .where(
      and(
        eq(domainsTable.appId, appId),
        eq(domainsTable.answersEverywhere, true),
      ),
    );
  for (const d of rows) {
    const z = nativeZoneOf(d, zones);
    if (z)
      out.set(d.id, {
        zone: z.name,
        target: zoneCovers(z.name, d.name) ? null : zoneTarget(d.name, z.name),
      });
  }
  return out;
}
