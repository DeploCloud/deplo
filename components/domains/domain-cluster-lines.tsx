"use client";

import * as React from "react";
import { Layers, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { useAppCan } from "@/components/apps/app-capabilities";
import { CloudflareIcon } from "@/components/shared/brand-icons";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { DocsLink } from "@/components/ui/docs-link";
import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";
import type { AddressAway, Domain } from "@/lib/types/domain";
import { DomainZoneLine, type DomainZone } from "./domain-zone-line";
import {
  LiveSteps,
  useEvery,
  useNow,
  type LiveStep,
} from "@/components/shared/live-state";

const CACHES_FORGET_MS = 5 * 60_000;

/** Where a domain the cluster answers is on its way: its record, the caches, its certificate, its failover. */
function ClusterDomainSteps({ domain }: { domain: Domain }) {
  const router = useRouter();
  const now = useNow(Boolean(domain.recordSwitchedAt));
  const caches =
    domain.recordSwitchedAt != null &&
    now - Date.parse(domain.recordSwitchedAt) < CACHES_FORGET_MS;
  const dns = domain.status === "valid";
  const cert = !domain.failoverWaitsForCertificate;
  const done = dns && !caches && cert;
  // While anything moves the row follows on its own; the certificate takes about a minute.
  useEvery(10_000, () => router.refresh(), !done);
  if (done) return null;
  const steps: LiveStep[] = [
    { label: "Record", state: dns ? "done" : "current" },
    ...(domain.recordSwitchedAt
      ? [
          {
            label: "Caches forget the old one",
            state: caches ? ("current" as const) : ("done" as const),
          },
        ]
      : []),
    {
      label: cert ? "Certificate" : "Certificate, about a minute",
      state: cert ? "done" : dns ? "current" : "todo",
    },
    { label: "Failover ready", state: cert ? "done" : "todo" },
  ];
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
      <LiveSteps steps={steps} />
      <DocsLink topic="clusters.answerEverywhere" />
    </div>
  );
}

/** The lines under a domain of an App on a cluster: where it answers, and what failover still waits for. */
export function DomainClusterLines({
  domain,
  staysOn,
  away,
  native,
  dnsZones,
  noHealthCheck,
  cluster = null,
}: {
  domain: Domain;
  /** The App runs on a cluster; `canMove`: the viewer can put a tunnel domain on it (a zone exists, or they may add one). */
  cluster?: { canMove: boolean } | null;
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

  const [moving, setMoving] = React.useState(false);
  const moveToCluster = async () => {
    setMoving(true);
    const res = await gqlAction<{ moveDomainToCluster: { id: string } }>(
      /* GraphQL */ `
        mutation ($id: String!) {
          moveDomainToCluster(id: $id) {
            id
          }
        }
      `,
      { id: domain.id },
    );
    setMoving(false);
    if (!res.ok) toast.error(res.error);
    else toast.success(`Every server of the cluster answers ${domain.name}`);
    router.refresh();
  };

  return (
    <>
      {cluster && domain.tunnel && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          {domain.clusterFallback ? (
            <TriangleAlert className="size-3.5 shrink-0 text-[var(--warning,#d97706)]" />
          ) : (
            <CloudflareIcon className="size-3.5 shrink-0 text-[#f38020]" />
          )}
          <span>
            {domain.clusterFallback
              ? `On the Cloudflare Tunnel for now: ${domain.clusterFallback}. Once fixed, let the cluster answer it.`
              : "Served through the App's Cloudflare Tunnel."}
          </span>
          <DocsLink topic="clusters.dnsZoneConnected" />
          {canManage && (
            <SimpleTooltip
              content={
                cluster.canMove
                  ? "Every server of the cluster answers it, nearest first. Visitors may see errors for a few minutes while DNS moves over."
                  : "An instance admin has to add the cluster's DNS zone first."
              }
            >
              <span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={moving || !cluster.canMove}
                  onClick={moveToCluster}
                >
                  {moving && <Loader2 className="size-3.5 animate-spin" />}
                  Let the cluster answer
                </Button>
              </span>
            </SimpleTooltip>
          )}
        </div>
      )}
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
      {domain.answersEverywhere && <ClusterDomainSteps domain={domain} />}
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
