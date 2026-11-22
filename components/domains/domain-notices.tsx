import { isRoutableDomain } from "@/lib/deploy/cloudflare";
import type { Domain } from "@/lib/types/domain";
import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { DomainDnsAutoCheck, type ZoneRecord } from "./domain-dns-auto-check";
import type { DomainZone } from "./domain-zone-line";

/** The one record each domain the cluster's zone answers needs: its CNAME into the zone, and the optional check one. */
export function zoneTargetsOf(
  native: Map<string, DomainZone>,
): Record<string, ZoneRecord> {
  const out: Record<string, ZoneRecord> = {};
  for (const [id, z] of native)
    if (z.target)
      out[id] = {
        target: z.target,
        check: z.cert?.check
          ? { name: z.cert.check.name, target: z.cert.check.target }
          : null,
        kept: z.kept === true,
      };
  return out;
}
import { ImportedDomainsNotice } from "./imported-domains-notice";

export function DomainNotices({
  appId,
  domains,
  serverIp,
  serverIpv6,
  zoneTargets = {},
  domainsHref,
}: {
  appId: string;
  domains: Domain[];
  serverIp?: string | null;
  serverIpv6?: string | null;
  zoneTargets?: Record<string, ZoneRecord>;
  domainsHref?: string;
}) {
  const unsettled = domains
    .filter((domain) => !isRoutableDomain(domain))
    .map((d) => ({ ...d, zone: zoneTargets[d.id] ?? null }));
  const imported = domains
    .filter((domain) => domain.importedFrom?.trim())
    .map(({ id, name, importedFrom }) => ({
      id,
      name,
      importedFrom: importedFrom!,
    }));
  const action = domainsHref ? (
    <Button asChild size="sm" variant="default">
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
