import "server-only";

import { and, asc, eq, or, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterDnsZones,
  clusterMembers,
  clusterNameServers,
  clusters as clustersTable,
  clusterZoneStates,
} from "../../db/schema/control-plane/clusters";
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
import { GEO_STALE_MONTHS, geoAgeMonths, shippedGeo } from "../../geo/shipped";
import { newId, nowIso } from "../../ids";
import { setClusterZone } from "../../infra/agent-client/cluster-host";
import { AgentClusterZoneUnsupportedError } from "../../infra/agent-client/errors";
import { requireInstanceAdmin } from "../../membership";
import { messageOf } from "../../utils";
import { recordActivity } from "../activity";
import { instanceFrozen } from "../deplo-move/freeze";
import { withKeyedLock } from "../keyed-mutex";
import { serverAddresses } from "../servers/addresses";
import { oneMemberPerAddress } from "../../clusters/shared-addresses";
import { getServerById } from "../servers/roster";
import type { ClusterDnsView, DelegationCheck } from "../../types/cluster-dns";
import { recordClusterActivity } from "./cluster-activity";
import { checkDelegation } from "./dns-delegation";
import { refreshAcmeCnames } from "./zone-cnames";
import {
  applyCertModes,
  dropDnsChallengeProxy,
  zoneCertificateViews,
  zoneCertMembers,
  zoneCertPass,
  type ZoneCertDomainRow,
} from "./zone-certs";
import {
  placeOf,
  placeRows,
  setServerPlace,
  type ServerPlace,
} from "./server-place";
import { fingerprintOf } from "./relay";
import { getClusterById, requireClusterAdmin } from "./roster";

// A cluster's own DNS zone (ADR-0049): https://deplo.build/docs/operations/clusters/dns-zone

export type ZoneMemberFacts = {
  serverId: string;
  name: string;
  fingerprint: string | null;
  v4: string[];
  v6: string[];
  /** Its IPv6 addresses are known: only its agent reports them, so not while it is away. */
  v6Known: boolean;
  emptying: boolean;
  joinedAt: string;
  place: ServerPlace | null;
};

export async function zonesOf(clusterId: string) {
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
  const geo = await shippedGeo();
  const placed = await placeRows(rows.map((r) => r.serverId));
  const facts = await Promise.all(
    rows.map(async (r) => {
      const server = await getServerById(r.serverId);
      const a = await serverAddresses(server);
      const row = placed.get(r.serverId);
      return {
        serverId: r.serverId,
        name: server?.name ?? r.serverId,
        fingerprint: await fingerprintOf(r.serverId),
        v4: a.v4,
        v6: a.v6,
        v6Known: a.v6Known,
        emptying: r.emptying != null,
        joinedAt: r.joinedAt,
        place: row ? placeOf(row, a, geo) : null,
      };
    }),
  );
  // Its answers, glue and name servers never name one address for two members (ADR-0050).
  return oneMemberPerAddress(facts).members;
}

/** The public addresses two members of this cluster share, and who: its screen says why one is left out. */
export async function sharedClusterAddresses(
  clusterId: string,
): Promise<Map<string, string[]>> {
  const rows = await getDb()
    .select({ serverId: clusterMembers.serverId })
    .from(clusterMembers)
    .where(eq(clusterMembers.clusterId, clusterId))
    .orderBy(asc(clusterMembers.joinedAt), asc(clusterMembers.serverId));
  const members = await Promise.all(
    rows.map(async (r) => {
      const server = await getServerById(r.serverId);
      // Read at render: what Deplo stores, never a call to the server.
      const a = await serverAddresses(server, { askAgent: false });
      return { name: server?.name ?? r.serverId, v4: a.v4, v6: a.v6 };
    }),
  );
  return oneMemberPerAddress(members).shared;
}

type ZoneRow = typeof clusterDnsZones.$inferSelect;

/** The domains each zone answers: those in it, and those whose CNAME the person pointed into it. */
async function zoneDomains(
  clusterId: string,
  zones: ZoneRow[],
): Promise<Map<string, ZoneDomain[]>> {
  const rows = await getDb()
    .select({
      id: domainsTable.id,
      name: domainsTable.name,
      zoneId: domainsTable.dnsZoneId,
      tunnel: domainsTable.tunnel,
      appId: domainsTable.appId,
      serverId: appsTable.serverId,
      certProvider: domainsTable.certProvider,
      acmeCnameSeenAt: domainsTable.acmeCnameSeenAt,
      certChallenge: domainsTable.certChallenge,
    })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId))
    .where(
      and(
        eq(appsTable.clusterId, clusterId),
        eq(domainsTable.answersEverywhere, true),
      ),
    );
  const out = new Map(zones.map((z) => [z.id, [] as ZoneDomain[]]));
  for (const d of rows) {
    if (d.tunnel === true) continue;
    const zone = nativeZoneOf(d, zones);
    if (zone)
      out.get(zone.id)!.push({
        domainId: d.id,
        name: d.name,
        target: zoneTarget(d.name, zone.name),
        zoneId: zone.id,
        zone: zone.name,
        inside: zoneCovers(zone.name, d.name),
        appId: d.appId,
        serverId: d.serverId,
        certProvider: d.certProvider,
        acmeCnameSeenAt: d.acmeCnameSeenAt,
        certChallenge: d.certChallenge,
      });
  }
  return out;
}

type ZoneDomain = ZoneCertDomainRow & { target: string };

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

async function saveState(clusterId: string, serverId: string, s: ZoneState) {
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
  challenges: [],
  certificates: [],
});

type ZoneState = {
  serving: boolean;
  problem: string;
  state: string;
  heard: number;
  geoSha256: string;
};

/**
 * Hands every member its cluster's zones and reads back how each answers; picks the name servers from those that can.
 * A server that left the cluster, or a cluster with no zone left, is told to stop.
 */
export async function syncClusterZone(clusterId: string): Promise<void> {
  if (await instanceFrozen()) return;
  let routes: (() => Promise<void>) | null = null;
  await withKeyedLock(`cluster-zone:${clusterId}`, async () => {
    const cluster = await getClusterById(clusterId);
    const zones = cluster ? await zonesOf(clusterId) : [];
    const members = zones.length > 0 ? await memberFacts(clusterId) : [];
    const keep = new Set(members.map((m) => m.serverId));
    for (const st of await statesOf(clusterId)) {
      if (keep.has(st.serverId)) continue;
      try {
        await setClusterZone(st.serverId, STOP(clusterId));
        // Out of the zone, its proxy no longer needs the resolver that checks over DNS.
        await dropDnsChallengeProxy(st.serverId);
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
        place: m.place && { lat: m.place.latitude, lon: m.place.longitude },
      }));
    // The release's location table, handed to every agent that places visitors and lacks it.
    const geo = await shippedGeo();
    const table =
      geo.state === "ready"
        ? {
            sha256: geo.bundle.table.digest,
            tableGz: geo.bundle.tableGz,
          }
        : null;
    const fpOf = new Map(members.map((m) => [m.serverId, m.fingerprint]));
    const heard = new Map(
      (await statesOf(clusterId)).map((s) => [s.serverId, s.state]),
    );
    const certDomains = [...byZone.values()].flat();
    await refreshAcmeCnames(certDomains);
    const certs = await zoneCertPass({
      clusterId,
      clusterName: cluster.name,
      wildcard: cluster.dnsWildcard,
      zones,
      domains: certDomains,
      members: await zoneCertMembers(
        members,
        (id) => !["unreachable", "unsupported"].includes(heard.get(id) ?? ""),
      ),
    });

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
      let fresh = false;
      for (const m of certs.order(members)) {
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
          challenges: certs.challenges,
          certificates: certs.certificatesFor(m.serverId),
        });
        try {
          const r = await setClusterZone(m.serverId, req, table);
          if (await certs.record(m.serverId, r.certificates ?? []))
            fresh = true;
          await saveState(clusterId, m.serverId, {
            serving: r.listening.length > 0,
            problem: r.problem,
            state: r.state,
            heard: r.heard,
            geoSha256: r.geoSha256,
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
            geoSha256: prev.get(m.serverId)?.geoSha256 ?? "",
          });
        }
      }
      return fresh;
    };

    const before = await currentChoice(clusterId);
    let choice = await pick(before);
    if (!sameChoice(before, choice)) await saveChoice(clusterId, choice);
    let fresh = await send(choice);
    // A server just found able to answer may fill a free place: hand everyone the new list at once.
    const after = await pick(choice);
    if (!sameChoice(after, choice)) {
      choice = after;
      await saveChoice(clusterId, choice);
      fresh = (await send(choice)) || fresh;
    }
    // A pair the renewer just got reaches every other server now, not a minute later.
    if (fresh) await send(choice);
    routes = () => applyCertModes(certDomains, certs.modes);
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
  // Outside the lock: routing an App again may itself ask for the zone to be synced.
  if (routes) await (routes as () => Promise<void>)();
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
  const geo = await shippedGeo();
  const digest = geo.state === "ready" ? geo.bundle.table.digest : null;
  const everyonePlaced =
    members.length > 0 && members.every((m) => m.place != null);
  const certs = await zoneCertificateViews(
    zones,
    (id) => byId.get(id)?.name ?? id,
  );
  return {
    wildcard: cluster.dnsWildcard,
    zones: zones.map((z) => ({
      id: z.id,
      name: z.name,
      records: delegationRecords(z.name, ns),
      names: byZone.get(z.id)!.map((d) => d.target),
      certificate: certs.get(z.id)!,
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
        nearest: everyonePlaced && digest != null && s.geoSha256 === digest,
      })),
    places: members.map((m) => ({
      serverId: m.serverId,
      serverName: m.name,
      place: m.place,
    })),
    geo:
      geo.state === "ready"
        ? {
            state: "ready",
            release: geo.bundle.manifest.release,
            stale: geoAgeMonths(geo.bundle.manifest.release) > GEO_STALE_MONTHS,
            reusedFrom: geo.bundle.manifest.reusedFrom,
            problem: "",
          }
        : {
            state: geo.state,
            release: null,
            stale: false,
            reusedFrom: null,
            problem: geo.state === "damaged" ? geo.problem : "",
          },
    answerTtl: cluster.dnsAnswerTtl,
    dropAfter: cluster.dnsDropAfter,
  };
}

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

/** Every address of every member: a resolver may still hold one that stopped a moment ago. */
export async function clusterMemberAddresses(
  clusterId: string,
): Promise<{ addresses: Set<string>; v6Known: boolean }> {
  const addresses = new Set<string>();
  let v6Known = true;
  for (const m of await memberFacts(clusterId)) {
    for (const a of [...m.v4, ...m.v6]) addresses.add(a);
    v6Known &&= m.v6Known;
  }
  return { addresses, v6Known };
}
