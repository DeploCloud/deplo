import { isRoutableDomain } from "@/lib/deploy/cloudflare";
import type { Domain } from "@/lib/types/domain";
import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { DomainDnsAutoCheck } from "./domain-dns-auto-check";
import { ImportedDomainsNotice } from "./imported-domains-notice";

export function DomainNotices({
  appId,
  domains,
  serverIp,
  serverIpv6,
  domainsHref,
}: {
  appId: string;
  domains: Domain[];
  serverIp?: string | null;
  serverIpv6?: string | null;
  domainsHref?: string;
}) {
  const unsettled = domains.filter((domain) => !isRoutableDomain(domain));
  const imported = domains
    .filter((domain) => domain.importedFrom?.trim())
    .map(({ id, name, importedFrom }) => ({
      id,
      name,
      importedFrom: importedFrom!,
    }));
  const action = domainsHref ? (
    <Button asChild size="sm" variant="outline">
      <Link href={domainsHref}>View domains</Link>
    </Button>
  ) : undefined;
  return (
    <>
      <ImportedDomainsNotice appId={appId} domains={imported} action={action} />
      {unsettled.length > 0 && (
        <DomainDnsAutoCheck
          domains={unsettled}
          serverIp={serverIp}
          serverIpv6={serverIpv6}
          action={action}
        />
      )}
    </>
  );
}
