import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterDnsZones,
  clusterMembers,
  clusterNameServers,
  clusterZoneStates,
} from "../../db/schema/control-plane/clusters";
import { dnsProviders } from "../../db/schema/control-plane/dns-providers";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import {
  chooseNameServers,
  delegationRecords,
  renderClusterZone,
  zoneTarget,
  type NameServerChoice,
  type ZoneServer,
} from "../../deploy/cluster-zone";
import { zoneCovers } from "../../dns-zone";
import { GEO_STALE_MONTHS, geoAgeMonths, shippedGeo } from "../../geo/shipped";
import { nowIso } from "../../ids";
import { setClusterZone } from "../../infra/agent-client/cluster-host";
import { AgentClusterZoneUnsupportedError } from "../../infra/agent-client/errors";
import { requireInstanceAdmin } from "../../membership";
import { messageOf } from "../../utils";
import { instanceFrozen } from "../deplo-move/freeze";
import { withKeyedLock } from "../keyed-mutex";
import { serverAddresses } from "../servers/addresses";
import { oneMemberPerAddress } from "../../clusters/shared-addresses";
import { getServerById } from "../servers/roster";
import type { ClusterDnsView } from "../../types/cluster-dns";
import { recordClusterActivity } from "./cluster-activity";
import { refreshAcmeCnames } from "./zone-cnames";
import {
  applyCertModes,
  dropDnsChallengeProxy,
  zoneCertificateViews,
  zoneCertMembers,
  zoneCertPass,
  type ZoneCertDomainRow,
} from "./zone-certs";
import { placeOf, placeRows, type ServerPlace } from "./server-place";
import { keepZoneTables, rememberZoneTable, withDrained } from "./proxy-roll";
import { listWorkloadPlacements } from "./placement";
import { syncZoneDelegation } from "./zone-cloudflare";
import { fingerprintOf } from "./relay";
import { getClusterById } from "./roster";

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

export async function memberFacts(
  clusterId: string,
): Promise<ZoneMemberFacts[]> {
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

export async function currentChoice(
  clusterId: string,
): Promise<NameServerChoice[]> {
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
    keepZoneTables(clusterId, [...keep]);
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
    const homes = await appHomes([...byZone.values()].flat());
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
        const base = renderClusterZone({
          clusterId,
          self: m.fingerprint,
          zones: zones.map((z) => ({
            name: z.name,
            names: byZone.get(z.id)!.map((d) => d.target),
            homes: byZone.get(z.id)!.flatMap((d) => {
              const fp = fpOf.get(homes.get(d.appId) ?? "");
              return fp ? [{ name: d.target, fingerprint: fp }] : [];
            }),
          })),
          servers,
          nameServers,
          ttl: cluster.dnsAnswerTtl,
          dropAfter: cluster.dnsDropAfter,
          challenges: certs.challenges,
          certificates: certs.certificatesFor(m.serverId),
        });
        rememberZoneTable(clusterId, m.serverId, base);
        try {
          const r = await setClusterZone(m.serverId, withDrained(base), table);
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
    // A zone under a domain connected for automatic DNS: Deplo keeps its NS and glue in Cloudflare itself.
    const byId = new Map(members.map((m) => [m.serverId, m]));
    const ns = choice
      .map((c) => byId.get(c.serverId))
      .filter((m): m is ZoneMemberFacts => !!m);
    for (const z of zones) {
      const problem = await syncZoneDelegation(z, ns);
      if (problem && delegationSaid.get(z.id) !== problem)
        await recordClusterActivity(clusterId, problem);
      if (problem) delegationSaid.set(z.id, problem);
      else delegationSaid.delete(z.id);
    }
    const byHand = zones.filter((z) => !z.providerId);
    if (moved.length > 0 && byHand.length > 0) {
      const names = byHand.map((z) => z.name).join(", ");
      await recordClusterActivity(
        clusterId,
        `The name servers of ${cluster.name}'s DNS ${byHand.length === 1 ? "zone" : "zones"} ${names} changed: update the records where the domain was bought, as the cluster's settings list them`,
      );
    }
  });
  // Outside the lock: routing an App again may itself ask for the zone to be synced.
  if (routes) await (routes as () => Promise<void>)();
}

/** The server each App runs on when it runs on one at a time: its names are answered with it first. */
async function appHomes(
  domains: { appId: string; serverId: string | null }[],
): Promise<Map<string, string>> {
  const placed = await listWorkloadPlacements("app", [
    ...new Set(domains.map((d) => d.appId)),
  ]);
  const out = new Map<string, string>();
  for (const d of domains) {
    const on = new Set(
      (placed.get(d.appId) ?? []).map((p) => p.serverId).filter(Boolean),
    );
    if (on.size < 2 && d.serverId) out.set(d.appId, d.serverId);
  }
  return out;
}

// The last problem said per zone about its records in Cloudflare, so a pass every minute says it once.
const delegationSaid = new Map<string, string>();

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
  const providerIds = zones.flatMap((z) =>
    z.providerId ? [z.providerId] : [],
  );
  const keptIn = new Map(
    providerIds.length === 0
      ? []
      : (
          await getDb()
            .select({ id: dnsProviders.id, zoneName: dnsProviders.zoneName })
            .from(dnsProviders)
            .where(inArray(dnsProviders.id, providerIds))
        ).map((p) => [p.id, p.zoneName]),
  );
  return {
    wildcard: cluster.dnsWildcard,
    zones: zones.map((z) => ({
      id: z.id,
      name: z.name,
      records: delegationRecords(z.name, ns),
      names: byZone.get(z.id)!.map((d) => d.target),
      keptIn: keptIn.get(z.providerId ?? "") ?? null,
      certificate: certs.get(z.id)!,
    })),
    nameServers: choice.map((c) => ({
      position: c.position,
      serverId: c.serverId,
      serverName: byId.get(c.serverId)?.name ?? c.serverId,
    })),
    servers: await Promise.all(
      states
        .filter((s) => byId.has(s.serverId))
        .map(async (s) => {
          const server = await getServerById(s.serverId);
          return {
            serverId: s.serverId,
            serverName: byId.get(s.serverId)!.name,
            serving: s.serving,
            problem: s.problem,
            state: s.state,
            heard: s.heard,
            checkedAt: s.checkedAt,
            nearest: everyonePlaced && digest != null && s.geoSha256 === digest,
            offlineSince:
              server && server.status !== "online"
                ? (server.lastSeenAt ?? s.checkedAt)
                : null,
          };
        }),
    ),
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
