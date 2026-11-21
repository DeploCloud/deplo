"use client";

import * as React from "react";
import { Layers, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { useAppCan } from "@/components/apps/app-capabilities";
import { Button } from "@/components/ui/button";
import { DocsLink } from "@/components/ui/docs-link";
import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";
import type { AddressAway, Domain } from "@/lib/types/domain";
import { DomainZoneLine, type DomainZone } from "./domain-zone-line";

/** The lines under a domain of an App on a cluster: where it answers, and what failover still waits for. */
export function DomainClusterLines({
  domain,
  staysOn,
  away,
  native,
  dnsZones,
  noHealthCheck,
}: {
  domain: Domain;
  staysOn?: string | null;
  away?: AddressAway | null;
  native: DomainZone | null;
  dnsZones: { id: string; name: string }[];
  noHealthCheck: boolean;
}) {
  const router = useRouter();
  const canManage = useAppCan("manage_domains");
  const [switching, setSwitching] = React.useState(false);
  const setEverywhere = async (on: boolean) => {
    setSwitching(true);
    const res = await gqlAction<{ setDomainAnswersEverywhere: { id: string } }>(
      /* GraphQL */ `
        mutation ($id: String!, $on: Boolean!) {
          setDomainAnswersEverywhere(id: $id, on: $on) {
            id
          }
        }
      `,
      { id: domain.id, on },
    );
    setSwitching(false);
    if (!res.ok) toast.error(res.error);
    else
      toast.success(
        on
          ? `${domain.name} answers on every server`
          : `${domain.name} answers on its App's server only`,
      );
    router.refresh();
  };

  return (
    <>
      {away && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <TriangleAlert className="size-3.5 shrink-0 text-[var(--warning,#d97706)]" />
          <span>
            Not answering while{" "}
            <span className="font-medium text-foreground">{away.server}</span>{" "}
            is offline: this address points at that server only.{" "}
            {away.use ? (
              <>
                <span className="font-mono text-foreground">{away.use}</span>{" "}
                answers from every server meanwhile.
              </>
            ) : (
              "Add a domain of your own: it answers from every server."
            )}
          </span>
          <DocsLink topic="clusters.loadBalancingServerBack" />
        </div>
      )}
      {staysOn && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <TriangleAlert className="size-3.5 shrink-0 text-[var(--warning,#d97706)]" />
          <span>
            Answers only through{" "}
            <span className="font-medium text-foreground">{staysOn}</span>: if
            it stops, this domain stops answering until it is back, even when
            the App moves.
          </span>
          <DocsLink topic="clusters.addresses" />
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              disabled={switching}
              onClick={() => setEverywhere(true)}
            >
              Answer on every server
            </Button>
          )}
        </div>
      )}
      {domain.answersEverywhere && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <Layers className="size-3.5 shrink-0" />
          <span>
            Answers on every server of the cluster, and keeps answering when the
            App moves.
          </span>
          <DocsLink topic="clusters.answerEverywhere" />
          {canManage && (
            <Button
              variant="ghost"
              size="sm"
              disabled={switching}
              onClick={() => setEverywhere(false)}
            >
              Turn off
            </Button>
          )}
        </div>
      )}
      {domain.answersEverywhere && (
        <DomainZoneLine
          domain={domain}
          native={native}
          zones={dnsZones}
          canManage={canManage}
        />
      )}
      {domain.failoverWaitsForCertificate && (
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <TriangleAlert className="size-3.5 shrink-0 text-[var(--warning,#d97706)]" />
          <span>
            Failover is not ready yet: Deplo copies its certificate once the
            App&rsquo;s server has one.
          </span>
        </div>
      )}
      {domain.answersEverywhere && noHealthCheck && (
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <TriangleAlert className="size-3.5 shrink-0 text-[var(--warning,#d97706)]" />
          <span>
            Add a health check, so visitors wait for the App to answer after it
            moves.
          </span>
        </div>
      )}
    </>
  );
}
