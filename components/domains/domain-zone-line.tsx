"use client";

import * as React from "react";
import { toast } from "sonner";
import { ChevronDown, Globe } from "lucide-react";

import { CopyButton } from "@/components/shared/copy-button";
import { Button } from "@/components/ui/button";
import { DocsLink } from "@/components/ui/docs-link";
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

export type DomainZone = { zone: string; target: string | null };

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
        {native.target && domain.status !== "valid" ? (
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
        <DocsLink topic="clusters.dnsZoneDomains" />
        {canManage && !(native.target === null) && (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => set(null)}
          >
            Use my own records
          </Button>
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
