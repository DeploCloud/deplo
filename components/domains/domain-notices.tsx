import { isRoutableDomain } from "@/lib/deploy/cloudflare";
import type { Domain } from "@/lib/types/domain";
import { DomainDnsAutoCheck } from "./domain-dns-auto-check";
import { ImportedDomainsNotice } from "./imported-domains-notice";

export function DomainNotices({
  appId,
  domains,
  serverIp,
  serverIpv6,
}: {
  appId: string;
  domains: Domain[];
  serverIp?: string | null;
  serverIpv6?: string | null;
}) {
  const unsettled = domains.filter((domain) => !isRoutableDomain(domain));
  const imported = domains
    .filter((domain) => domain.importedFrom?.trim())
    .map(({ id, name, importedFrom }) => ({
      id,
      name,
      importedFrom: importedFrom!,
    }));
  return (
    <>
      <ImportedDomainsNotice appId={appId} domains={imported} />
      {unsettled.length > 0 && (
        <DomainDnsAutoCheck
          domains={unsettled}
          serverIp={serverIp}
          serverIpv6={serverIpv6}
        />
      )}
    </>
  );
}
