import { listDomains } from "@/lib/data/domains/crud";
import { domainDnsHints } from "@/lib/data/domains/dns-check";
import { serverIpForApp } from "@/lib/data/servers/roster";
import { isRoutableDomain } from "@/lib/deploy/cloudflare";
import type { App } from "@/lib/types/app";
import { DomainNotices } from "./domain-notices";

export async function AppDomainNotices({ app }: { app: App }) {
  const domains = await listDomains(app.id);
  if (
    !domains.some(
      (domain) => !isRoutableDomain(domain) || domain.importedFrom?.trim(),
    )
  )
    return null;
  const [serverIp, hints] = await Promise.all([
    serverIpForApp(app.id),
    domainDnsHints(app.id, domains),
  ]);
  return (
    <DomainNotices
      appId={app.id}
      domains={domains}
      serverIp={serverIp}
      serverIpv6={hints.serverIpv6}
      domainsHref={`/apps/${app.slug}/domains`}
    />
  );
}
