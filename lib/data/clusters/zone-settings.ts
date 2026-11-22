import "server-only";

import { eq, or, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  clusterDnsZones,
  clusters as clustersTable,
} from "../../db/schema/control-plane/clusters";
import { cleanZoneName, dnsTimesRefusal } from "../../deploy/cluster-zone";
import { newId, nowIso } from "../../ids";
import { requireInstanceAdmin } from "../../membership";
import { recordActivity } from "../activity";
import { instanceFrozen } from "../deplo-move/freeze";
import type { DelegationCheck } from "../../types/cluster-dns";
import { checkDelegation } from "./dns-delegation";
import {
  currentChoice,
  memberFacts,
  syncClusterZoneSoon,
  type ZoneMemberFacts,
} from "./dns-zone";
import { setServerPlace } from "./server-place";
import { getClusterById, requireClusterAdmin } from "./roster";

// What an instance admin sets about a cluster's own DNS zone (ADR-0049): https://deplo.build/docs/operations/clusters/dns-zone

/** Places a server of a cluster (null: by its address again); its cluster's zone answers from there next. */
export async function placeClusterServer(
  serverId: string,
  place: { latitude: number; longitude: number; label?: string | null } | null,
): Promise<void> {
  const clusterId = await setServerPlace(serverId, place);
  if (clusterId) syncClusterZoneSoon(clusterId);
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
