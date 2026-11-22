"use client";

import * as React from "react";
import { toast } from "sonner";
import { ChevronDown, Globe, ShieldCheck } from "lucide-react";

import { CopyButton } from "@/components/shared/copy-button";
import { Button } from "@/components/ui/button";
import { DocsLink } from "@/components/ui/docs-link";
import { InfoTip } from "@/components/ui/info-tip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";

// A domain answered by its cluster's own DNS zone (ADR-0049): https://deplo.build/docs/operations/clusters/dns-zone

const SET_ZONE = /* GraphQL */ `
  mutation SetDomainDnsZone($id: String!, $zoneId: String) {
    setDomainDnsZone(id: $id, zoneId: $zoneId)
  }
`;

const CHECK_CNAME = /* GraphQL */ `
  mutation CheckDomainAcmeCname($id: String!) {
    checkDomainAcmeCname(id: $id)
  }
`;

export type DomainZone = {
  zone: string;
  target: string | null;
  /** Cloudflare answers where the cluster should: the record is proxied, not DNS only. */
  cloudflare?: boolean;
  /** Deplo keeps its records in Cloudflare: nothing for the person to type. */
  kept?: boolean;
  cert?: {
    mode: "zone" | "shared" | "dns" | "http";
    check: { name: string; target: string; seen: boolean } | null;
  };
};

/** Under a domain that answers on every server: whether the cluster's zone answers it, and the one record it needs. */
export function DomainZoneLine({
  domain,
  native,
  zones,
  canManage,
}: {
  domain: { id: string; name: string; status: string };
  native: DomainZone | null;
  zones: { id: string; name: string }[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const set = (zoneId: string | null, zoneName?: string) =>
    startTransition(async () => {
      const res = await gqlAction(SET_ZONE, { id: domain.id, zoneId });
      if (!res.ok) return void toast.error(res.error);
      toast.success(
        zoneId
          ? `The cluster answers for ${domain.name} through ${zoneName}`
          : `${domain.name} uses its own records again`,
      );
      router.refresh();
    });

  if (native) {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        <Globe className="size-3.5 shrink-0" />
        {native.cloudflare && domain.status !== "valid" ? (
          <span>
            Cloudflare answers for{" "}
            <span className="font-mono text-foreground">{domain.name}</span> in
            the cluster&rsquo;s place: in Cloudflare, set its record to{" "}
            <span className="font-medium text-foreground">DNS only</span> (grey
            cloud).
          </span>
        ) : native.kept ? (
          <span>
            Deplo keeps its records in Cloudflare, pointed at the
            cluster&rsquo;s zone{" "}
            <span className="font-mono text-foreground">{native.zone}</span>.
          </span>
        ) : native.target && domain.status !== "valid" ? (
          <>
            <span>
              Add a{" "}
              <span className="font-medium text-foreground">CNAME record</span>{" "}
              for{" "}
              <span className="font-mono text-foreground">{domain.name}</span> →
            </span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
              {native.target}
            </code>
            <CopyButton value={native.target} className="size-6" />
          </>
        ) : (
          <span>
            The cluster answers its DNS through{" "}
            <span className="font-mono text-foreground">{native.zone}</span>.
          </span>
        )}
        <DocsLink
          topic={
            native.cloudflare && domain.status !== "valid"
              ? "clusters.dnsZoneCloudflare"
              : native.kept
                ? "clusters.dnsZoneConnected"
                : "clusters.dnsZoneDomains"
          }
        />
        {canManage && native.target !== null && !native.kept && (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => set(null)}
          >
            Use my own records
          </Button>
        )}
        {native.cert && (
          <DomainCertLine
            domainId={domain.id}
            zone={native.zone}
            cert={native.cert}
            canManage={canManage}
          />
        )}
      </div>
    );
  }
  if (zones.length === 0 || !canManage) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      <Globe className="size-3.5 shrink-0" />
      <span>
        The cluster can answer its DNS itself, so no record changes when a
        server stops.
      </span>
      {zones.length === 1 ? (
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => set(zones[0].id, zones[0].name)}
        >
          Let the cluster answer
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={pending}>
              Let the cluster answer
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {zones.map((z) => (
              <DropdownMenuItem key={z.id} onSelect={() => set(z.id, z.name)}>
                Through {z.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** How the domain's certificate is checked through the zone, and for a name outside it the optional CNAME that does it. */
function DomainCertLine({
  domainId,
  zone,
  cert,
  canManage,
}: {
  domainId: string;
  zone: string;
  cert: NonNullable<DomainZone["cert"]>;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const check = () =>
    startTransition(async () => {
      const res = await gqlAction<{ checkDomainAcmeCname: boolean }>(
        CHECK_CNAME,
        { id: domainId },
      );
      if (!res.ok) return void toast.error(res.error);
      if (res.data?.checkDomainAcmeCname)
        toast.success("Found it: the certificate is checked through the zone");
      else toast.error("That record is not there yet");
      router.refresh();
    });
  if (cert.mode === "zone")
    return (
      <span className="flex basis-full items-center gap-1.5">
        <ShieldCheck className="size-3.5 shrink-0" />
        Covered by the zone&apos;s certificate for{" "}
        <span className="font-mono text-foreground">*.{zone}</span>
      </span>
    );
  const throughZone = (
    <span className="flex basis-full items-center gap-1.5">
      <ShieldCheck className="size-3.5 shrink-0" />
      {cert.mode === "shared"
        ? "Its certificate is checked through the zone, and every server of the cluster holds it."
        : "Its certificate is checked through the zone."}
    </span>
  );
  if (!cert.check)
    return cert.mode === "dns" || cert.mode === "shared" ? throughZone : null;
  if (cert.check.seen) return throughZone;
  return (
    <span className="flex basis-full flex-wrap items-center gap-x-1.5 gap-y-1">
      <ShieldCheck className="size-3.5 shrink-0" />
      <span>
        Optional: a{" "}
        <span className="font-medium text-foreground">CNAME record</span> for{" "}
        <span className="font-mono text-foreground">{cert.check.name}</span> →
      </span>
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
        {cert.check.target}
      </code>
      <CopyButton value={cert.check.target} className="size-6" />
      <InfoTip
        content="With it, the certificate is checked through the zone instead of over HTTP, and every server holds it, so load balancing can run the app on all of them."
        docs="clusters.dnsZoneCertCname"
      />
      {canManage && (
        <Button variant="outline" size="sm" disabled={pending} onClick={check}>
          Check
        </Button>
      )}
    </span>
  );
}
