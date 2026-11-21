import "server-only";

import { promises as dnsp } from "node:dns";
import { and, eq } from "drizzle-orm";

import { getCurrentUser } from "../../auth/current-user";
import { getDb } from "../../db/client";
import { clusterDnsZones } from "../../db/schema/control-plane/clusters";
import { domainDnsRecords } from "../../db/schema/control-plane/dns-providers";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { zoneTarget } from "../../deploy/cluster-zone";
import { challengeName, type CertChallenge } from "../../deploy/dns-challenge";
import { zoneCovers } from "../../dns-zone";
import { recordActivity } from "../activity";
import { loadAppGraph } from "../app-graph-load";
import { instanceFrozen } from "../deplo-move/freeze";
import { requireAppCapability } from "../node-access";
import { nativeZoneOf, syncClusterZoneSoon, zonesOf } from "./dns-zone";

// The domains a cluster's own DNS zone answers (ADR-0049): https://deplo.build/docs/operations/clusters/dns-zone

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

export type DomainZoneInfo = {
  zone: string;
  target: string | null;
  /** How its certificate is checked as routed now, and for a name outside the zone the CNAME that moves it to DNS. */
  cert: {
    mode: CertChallenge;
    check: { name: string; target: string; seen: boolean } | null;
  };
};

/** The record a domain answered by the cluster needs, if any: the CNAME into the zone, or none inside it. */
export async function domainZoneTargets(
  appId: string,
): Promise<Map<string, DomainZoneInfo>> {
  const app = await loadAppGraph(appId);
  const out = new Map<string, DomainZoneInfo>();
  if (!app?.clusterId) return out;
  const zones = await zonesOf(app.clusterId);
  if (zones.length === 0) return out;
  const rows = await getDb()
    .select({
      id: domainsTable.id,
      name: domainsTable.name,
      zoneId: domainsTable.dnsZoneId,
      certChallenge: domainsTable.certChallenge,
      seenAt: domainsTable.acmeCnameSeenAt,
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
    if (!z) continue;
    const target = zoneCovers(z.name, d.name)
      ? null
      : zoneTarget(d.name, z.name);
    out.set(d.id, {
      zone: z.name,
      target,
      cert: {
        mode:
          d.certChallenge === "zone" ||
          d.certChallenge === "shared" ||
          d.certChallenge === "dns"
            ? d.certChallenge
            : "http",
        check: target
          ? {
              name: challengeName(d.name),
              target: challengeName(target),
              seen: d.seenAt != null,
            }
          : null,
      },
    });
  }
  return out;
}
