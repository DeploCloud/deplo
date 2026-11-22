import "server-only";

import { eq, or, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterDnsZones,
  clusters as clustersTable,
} from "../../db/schema/control-plane/clusters";
import { domainDnsRecords } from "../../db/schema/control-plane/dns-providers";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import {
  cleanZoneName,
  dnsTimesRefusal,
  zoneTarget,
} from "../../deploy/cluster-zone";
import { zoneCovers } from "../../dns-zone";
import { newId, nowIso } from "../../ids";
import { requireInstanceAdmin } from "../../membership";
import { recordActivity } from "../activity";
import { instanceFrozen } from "../deplo-move/freeze";
import { providerForHostname } from "../dns-providers/provision";
import { loadProviderSecret } from "../dns-providers/tunnels";
import type { DelegationCheck } from "../../types/cluster-dns";
import { checkDelegation } from "./dns-delegation";
import {
  currentChoice,
  memberFacts,
  syncClusterZone,
  syncClusterZoneSoon,
  type ZoneMemberFacts,
} from "./dns-zone";
import { setServerPlace } from "./server-place";
import { getClusterById, requireClusterAdmin } from "./roster";
import {
  dropZoneDelegation,
  freeZoneName,
  pointDomainAtZone,
} from "./zone-cloudflare";

// What an instance admin sets about a cluster's own DNS zone (ADR-0049): https://deplo.build/docs/operations/clusters/dns-zone

/** Places a server of a cluster (null: by its address again); its cluster's zone answers from there next. */
export async function placeClusterServer(
  serverId: string,
  place: { latitude: number; longitude: number; label?: string | null } | null,
): Promise<void> {
  const clusterId = await setServerPlace(serverId, place);
  if (clusterId) syncClusterZoneSoon(clusterId);
}

type ZoneRow = typeof clusterDnsZones.$inferSelect;

/** The connected Cloudflare zone strictly above `name` this person may write in: Deplo keeps the delegation there. */
async function providerAbove(
  name: string,
  teamId: string,
  userId: string,
): Promise<string | null> {
  const p = await providerForHostname(name, teamId, userId);
  return p && p.zoneName !== name ? p.id : null;
}

async function insertZone(
  clusterId: string,
  name: string,
  providerId: string | null,
): Promise<ZoneRow> {
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
  const row = {
    id: newId("czone"),
    clusterId,
    name,
    providerId,
    createdAt: nowIso(),
  };
  await getDb().insert(clusterDnsZones).values(row);
  return row;
}

const whereRecords = (providerId: string | null) =>
  providerId
    ? "Deplo writes its records in Cloudflare"
    : "once it is delegated where the domain was bought";

/** Delegates a zone to a cluster: its servers answer for it once the registrar points there, or Cloudflare does. */
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
  const providerId = await providerAbove(clean.name, teamId, user.id);
  const zone = await insertZone(clusterId, clean.name, providerId);
  await recordActivity(
    "server",
    `Cluster ${cluster.name} now answers for the DNS zone ${zone.name}: ${whereRecords(providerId)}`,
    user.name,
    null,
    teamId,
  );
  syncClusterZoneSoon(clusterId);
  return zone.id;
}

/** A cluster's first zone, made for a domain under a domain connected for automatic DNS: named and written by Deplo. */
export async function createClusterZoneUnder(
  clusterId: string,
  provider: { id: string; zoneName: string },
): Promise<ZoneRow> {
  const { teamId, user } = await requireClusterAdmin();
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  const secret = await loadProviderSecret(provider.id);
  if (!secret) throw new Error(`${provider.zoneName} is no longer connected.`);
  const zone = await insertZone(
    clusterId,
    await freeZoneName(secret, provider.zoneName),
    provider.id,
  );
  await recordActivity(
    "server",
    `Cluster ${cluster.name} now answers for its own DNS zone ${zone.name}, under ${provider.zoneName}: Deplo writes its records in Cloudflare. Its name can be changed in the cluster's settings`,
    user.name,
    null,
    teamId,
  );
  return zone;
}

/** The domains answered through a zone whose CNAME Deplo keeps in Cloudflare. */
async function keptDomains(zoneId: string) {
  return getDb()
    .select({
      id: domainsTable.id,
      name: domainsTable.name,
      appId: domainsTable.appId,
      providerId: domainDnsRecords.providerId,
      recordId: domainDnsRecords.recordId,
      acmeRecordId: domainDnsRecords.acmeRecordId,
    })
    .from(domainsTable)
    .innerJoin(domainDnsRecords, eq(domainDnsRecords.domainId, domainsTable.id))
    .where(eq(domainsTable.dnsZoneId, zoneId));
}

/** Gives a zone another name: the domains pointed into it follow, their records in Cloudflare rewritten. */
export async function renameClusterDnsZone(
  zoneId: string,
  raw: string,
): Promise<string> {
  if (await instanceFrozen())
    throw new Error(
      "Deplo is moving to another machine; try again once it is done.",
    );
  const { teamId, user } = await requireClusterAdmin();
  const [old] = await getDb()
    .select()
    .from(clusterDnsZones)
    .where(eq(clusterDnsZones.id, zoneId))
    .limit(1);
  if (!old) throw new Error("DNS zone not found");
  const clean = cleanZoneName(raw);
  if (clean.error !== undefined) throw new Error(clean.error);
  if (clean.name === old.name) return old.clusterId;
  const inside = (
    await getDb()
      .select({ name: domainsTable.name })
      .from(domainsTable)
      .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId))
      .where(eq(appsTable.clusterId, old.clusterId))
  ).filter((d) => zoneCovers(old.name, d.name));
  if (inside.length > 0)
    throw new Error(
      `${inside[0].name} is a name inside ${old.name}, so it cannot follow a new name. Remove it first.`,
    );
  const providerId = await providerAbove(clean.name, teamId, user.id);
  const next = await insertZone(old.clusterId, clean.name, providerId);
  const typed: string[] = [];
  for (const d of await getDb()
    .select({ id: domainsTable.id, name: domainsTable.name })
    .from(domainsTable)
    .where(eq(domainsTable.dnsZoneId, old.id))) {
    await getDb()
      .update(domainsTable)
      .set({ dnsZoneId: next.id, acmeCnameSeenAt: null })
      .where(eq(domainsTable.id, d.id));
    typed.push(d.name);
  }
  for (const d of await keptDomains(next.id)) {
    const secret = await loadProviderSecret(d.providerId).catch(() => null);
    if (!secret) continue;
    const cn = await pointDomainAtZone(
      secret,
      d.name,
      zoneTarget(d.name, next.name),
      [d.recordId, ...(d.acmeRecordId ? [d.acmeRecordId] : [])],
    );
    await getDb()
      .update(domainDnsRecords)
      .set({ recordId: cn.recordId, acmeRecordId: cn.acmeRecordId })
      .where(eq(domainDnsRecords.domainId, d.id));
    typed.splice(typed.indexOf(d.name), 1);
  }
  await dropZoneDelegation(old).catch(() => {});
  await getDb().delete(clusterDnsZones).where(eq(clusterDnsZones.id, old.id));
  await recordActivity(
    "server",
    `The cluster's DNS zone ${old.name} is now ${next.name}: ${whereRecords(providerId)}${
      typed.length > 0
        ? `. Point ${typed.join(", ")} at the new name, as ${typed.length === 1 ? "its row shows" : "their rows show"}`
        : ""
    }`,
    user.name,
    null,
    teamId,
  );
  syncClusterZoneSoon(old.clusterId);
  return old.clusterId;
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
  const kept = await keptDomains(zone.id);
  if (kept.length > 0)
    throw new Error(
      `${kept.map((d) => d.name).join(", ")} ${kept.length === 1 ? "is" : "are"} answered through ${zone.name} with records Deplo keeps in Cloudflare. Remove ${kept.length === 1 ? "it" : "them"} first, or give the zone another name.`,
    );
  const cluster = await getClusterById(zone.clusterId);
  await dropZoneDelegation(zone).catch(() => {});
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
  return zoneDelegationCheck(zone);
}

async function zoneDelegationCheck(zone: {
  clusterId: string;
  name: string;
}): Promise<DelegationCheck> {
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

let ready = { tries: 6, waitMs: 2000 };
export function __setZoneReadyWaitForTest(tries: number, waitMs: number): void {
  ready = { tries, waitMs };
}

/**
 * Starts the zone's name servers, then checks the delegation and that every one of them answers for it, a few times
 * while Cloudflare catches up. Null when it answers, else why not, in the person's words.
 */
export async function zoneAnswerProblem(zone: ZoneRow): Promise<string | null> {
  await syncClusterZone(zone.clusterId);
  let check: DelegationCheck | null = null;
  for (let i = 0; i < ready.tries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, ready.waitMs));
    check = await zoneDelegationCheck(zone);
    const silent = check.nameServers.some((n) => !n.answers);
    if (check.delegated && !silent) return null;
    // Cloudflare may still be publishing the records; a server that does not answer will not in ten seconds.
    if (silent && i >= 1) break;
  }
  const silent = check?.nameServers.find((n) => !n.answers);
  if (silent) {
    const server = (await memberFacts(zone.clusterId)).find((m) =>
      [...m.v4, ...m.v6].includes(silent.address),
    );
    return `${server?.name ?? "A server of the cluster"} (${silent.address}) does not answer for ${zone.name}: open port 53, UDP and TCP, on that server`;
  }
  return check?.problems[0] ?? `${zone.name} does not answer yet`;
}
