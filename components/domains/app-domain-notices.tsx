import { listDomains } from "@/lib/data/domains/crud";
import { domainDnsHints } from "@/lib/data/domains/dns-check";
import { serverIpForApp } from "@/lib/data/servers/roster";
import { isRoutableDomain } from "@/lib/deploy/cloudflare";
import { clusterAddressNote } from "@/lib/data/clusters/app-tunnel";
import type { App } from "@/lib/types/app";
import { ClusterAddressNote } from "@/components/shared/cluster-address-note";
import { DomainNotices, zoneTargetsOf } from "./domain-notices";
import { domainZoneTargets } from "@/lib/data/clusters/zone-domains";

/** On a cluster with no domain on Cloudflare: the App's address changes when it fails over. */
export async function AppAddressNotice({ app }: { app: App }) {
  const note = app.clusterId ? await clusterAddressNote(app) : null;
  return note ? <ClusterAddressNote note={note} /> : null;
}

export async function AppDomainNotices({ app }: { app: App }) {
  const domains = await listDomains(app.id);
  if (
    !domains.some(
      (domain) => !isRoutableDomain(domain) || domain.importedFrom?.trim(),
    )
  )
    return null;
  const [serverIp, hints, native] = await Promise.all([
    serverIpForApp(app.id),
    domainDnsHints(app.id, domains),
    domainZoneTargets(app.id),
  ]);
  return (
    <DomainNotices
      appId={app.id}
      domains={domains}
      serverIp={serverIp}
      serverIpv6={hints.serverIpv6}
      zoneTargets={zoneTargetsOf(native)}
      domainsHref={`/apps/${app.slug}/domains`}
    />
  );
}
