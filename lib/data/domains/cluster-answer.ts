import "server-only";

import { eq } from "drizzle-orm";

import { getCurrentUser } from "../../auth/current-user";
import { getDb } from "../../db/client";
import {
  appTunnelDomains,
  dnsProviders,
  domainDnsRecords,
} from "../../db/schema/control-plane/dns-providers";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { zoneTarget } from "../../deploy/cluster-zone";
import { nowIso } from "../../ids";
import { isInstanceAdmin } from "../../membership";
import { recordActivity } from "../activity";
import { loadAppGraph } from "../app-graph-load";
import { settleAppTunnel } from "../clusters/app-tunnel";
import { nativeZoneOf, zonesOf } from "../clusters/dns-zone";
import {
  pointDomainAtZone,
  type ZoneCnames,
} from "../clusters/zone-cloudflare";
import {
  createClusterZoneUnder,
  zoneAnswerProblem,
} from "../clusters/zone-settings";
import { instanceFrozen } from "../deplo-move/freeze";
import { deleteReleasedDns, takeDomainDns } from "../dns-providers/provision";
import { loadProviderSecret } from "../dns-providers/tunnels";
import { requireAppCapability } from "../node-access";
import { answerEverywhereRefusal } from "./answer-switch";
import { assertTeamLetsencryptQuota } from "./letsencrypt-quota";

// A cluster App's domain under a domain connected for automatic DNS: the cluster's own zone answers it, or the App's
// tunnel does (ADR-0049). https://deplo.build/docs/operations/clusters/dns-zone#dns-at-cloudflare

type ZoneRow = Awaited<ReturnType<typeof zonesOf>>[number];

export type ClusterAnswerPlan =
  | { way: "cluster"; zone: ZoneRow; inside: boolean }
  | { way: "tunnel"; fallback: string | null };

export const NO_ZONE_FOR_MEMBER =
  "The cluster has no DNS zone yet, and only an instance admin can add one. Ask one to, or use the Cloudflare Tunnel.";

/**
 * How a cluster App's new domain is answered: the cluster's zone by default, made first when the cluster has none and
 * an instance admin asks; the App's tunnel when asked, or when the zone cannot answer yet, with the reason. Null for a
 * name no connected Cloudflare zone and no zone of the cluster covers.
 */
export async function planClusterAnswer(input: {
  appId: string;
  teamId: string;
  clusterId: string;
  name: string;
  pathPrefix: string;
  tunnel: boolean | undefined;
  provider: { id: string; zoneName: string } | null;
}): Promise<ClusterAnswerPlan | null> {
  const zones = await zonesOf(input.clusterId);
  const inside = nativeZoneOf({ name: input.name, zoneId: null }, zones);
  if (!inside && !input.provider) return null;
  if (inside && input.tunnel === true)
    throw new Error(
      `${input.name} is inside the cluster's DNS zone ${inside.name}, which answers it: a name there never uses a Cloudflare Tunnel.`,
    );
  if (input.tunnel === true) return { way: "tunnel", fallback: null };
  const tunnelBecause = (why: string): ClusterAnswerPlan => {
    if (inside) throw new Error(why);
    return { way: "tunnel", fallback: why };
  };
  let zone = inside ?? zones[0] ?? null;
  if (!zone && !(await isInstanceAdmin())) {
    if (input.tunnel === false) throw new Error(NO_ZONE_FOR_MEMBER);
    return { way: "tunnel", fallback: null };
  }
  const why = await answerEverywhereRefusal(
    {
      name: input.name,
      inCluster: true,
      tunnel: false,
      https: true,
      pathPrefix: input.pathPrefix,
      sharedByPath: false,
    },
    input.appId,
    input.clusterId,
  );
  if (why) return tunnelBecause(why);
  try {
    await assertTeamLetsencryptQuota(input.teamId, "letsencrypt");
  } catch (e) {
    return tunnelBecause(e instanceof Error ? e.message : String(e));
  }
  zone ??= await createClusterZoneUnder(input.clusterId, input.provider!);
  const problem = await zoneAnswerProblem(zone);
  if (problem && !inside) return { way: "tunnel", fallback: problem };
  return { way: "cluster", zone, inside: inside != null };
}

/** The records a planned cluster answer needs in Cloudflare: none inside the zone, two CNAMEs outside it. */
export async function writeClusterAnswer(
  plan: Extract<ClusterAnswerPlan, { way: "cluster" }>,
  name: string,
  providerId: string | null,
  replace: string[] = [],
): Promise<(ZoneCnames & { providerId: string; zoneId: string }) | null> {
  if (plan.inside || !providerId) return null;
  const provider = await loadProviderSecret(providerId);
  if (!provider) return null;
  const cn = await pointDomainAtZone(
    provider,
    name,
    zoneTarget(name, plan.zone.name),
    replace,
  );
  return { ...cn, providerId, zoneId: provider.zoneId };
}

/** What a domain answered by the cluster's zone holds besides the row `insertDomain` writes. */
export async function markClusterAnswer(
  domainId: string,
  plan: Extract<ClusterAnswerPlan, { way: "cluster" }>,
  acme: boolean,
): Promise<void> {
  await getDb()
    .update(domainsTable)
    .set({
      dnsZoneId: plan.inside ? null : plan.zone.id,
      acmeCnameSeenAt: acme ? nowIso() : null,
      clusterFallback: null,
    })
    .where(eq(domainsTable.id, domainId));
}

/** Moves a domain from the App's Cloudflare Tunnel to the cluster's own zone, once the zone answers. */
export async function moveDomainToCluster(domainId: string): Promise<string> {
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
  if (!app.clusterId)
    throw new Error("Only an App on a cluster can be answered by the cluster.");
  if (d.tunnel !== true)
    throw new Error(`${d.name} is not on the Cloudflare Tunnel.`);
  const [row] = await getDb()
    .select({
      providerId: domainDnsRecords.providerId,
      recordId: domainDnsRecords.recordId,
      zoneName: dnsProviders.zoneName,
    })
    .from(domainDnsRecords)
    .innerJoin(dnsProviders, eq(dnsProviders.id, domainDnsRecords.providerId))
    .where(eq(domainDnsRecords.domainId, d.id));
  if (!row)
    throw new Error(
      `Deplo does not keep ${d.name}'s DNS record, so it cannot point it at the cluster.`,
    );
  const plan = await planClusterAnswer({
    appId: d.appId,
    teamId: membership.teamId,
    clusterId: app.clusterId,
    name: d.name,
    pathPrefix: d.pathPrefix ?? "",
    tunnel: false,
    provider: { id: row.providerId, zoneName: row.zoneName },
  });
  if (!plan || plan.way === "tunnel") {
    const why =
      plan?.fallback ?? `${d.name} cannot be answered by the cluster.`;
    await getDb()
      .update(domainsTable)
      .set({ clusterFallback: why })
      .where(eq(domainsTable.id, d.id));
    throw new Error(why);
  }
  const cn = await writeClusterAnswer(plan, d.name, row.providerId, [
    row.recordId,
  ]);
  if (cn)
    await getDb()
      .update(domainDnsRecords)
      .set({
        recordId: cn.recordId,
        acmeRecordId: cn.acmeRecordId,
        created: true,
        tunnelId: null,
      })
      .where(eq(domainDnsRecords.domainId, d.id));
  // A name inside the zone needs no record above it: the tunnel's goes.
  else await deleteReleasedDns(await takeDomainDns([d.id]));
  await getDb()
    .update(domainsTable)
    .set({
      tunnel: null,
      proxied: null,
      certProvider: "letsencrypt",
      answersEverywhere: true,
      status: "pending",
      ssl: true,
    })
    .where(eq(domainsTable.id, d.id));
  await markClusterAnswer(d.id, plan, cn?.acmeRecordId != null);
  await getDb()
    .delete(appTunnelDomains)
    .where(eq(appTunnelDomains.domainId, d.id));
  await settleAppTunnel(d.appId);
  const user = await getCurrentUser();
  await recordActivity(
    "domain",
    `${d.name} moved from the Cloudflare Tunnel to the cluster: every server of it answers ${d.name}, through its DNS zone ${plan.zone.name}`,
    user?.name ?? "Deplo",
    d.appId,
    membership.teamId,
  );
  return d.appId;
}
