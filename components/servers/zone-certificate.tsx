"use client";

import * as React from "react";
import { toast } from "sonner";
import { Loader2, ShieldCheck, TriangleAlert } from "lucide-react";

import { DocsLink } from "@/components/ui/docs-link";
import { InfoTip } from "@/components/ui/info-tip";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";
import type { ZoneCertificateView } from "@/lib/types/cluster-dns";

// A zone's own certificate (ADR-0049 phase 3): https://deplo.build/docs/operations/clusters/dns-zone

const SET_WILDCARD = /* GraphQL */ `
  mutation SetClusterDnsWildcard($clusterId: String!, $on: Boolean!) {
    setClusterDnsWildcard(clusterId: $clusterId, on: $on)
  }
`;

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

function served(names: string[]): string {
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** Under a zone: its certificate, who renews it, and why the last order failed. */
export function ZoneCertificateLine({
  zone,
  cert,
  wildcard,
}: {
  zone: string;
  cert: ZoneCertificateView;
  wildcard: boolean;
}) {
  const valid = cert.valid && cert.validUntil;
  if (!wildcard && !valid) return null;
  return (
    <div className="space-y-1 pl-0.5 text-xs text-muted-foreground">
      {valid ? (
        <p className="flex flex-wrap items-center gap-x-1.5">
          <ShieldCheck className="size-3.5 shrink-0 text-success" />
          <span>
            Certificate for{" "}
            <span className="font-mono text-foreground">*.{zone}</span> valid
            until {day(cert.validUntil!)}
            {cert.renewer && <>, renewed by {cert.renewer.serverName}</>}
            {cert.renewedAt && <>, last on {day(cert.renewedAt)}</>}
          </span>
          <DocsLink topic="clusters.dnsZoneCertificates" />
        </p>
      ) : cert.ordering ? (
        <p className="flex items-center gap-1.5">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <span>
            {cert.renewer?.serverName ?? "A server"} is getting the certificate
            for <span className="font-mono text-foreground">*.{zone}</span>
          </span>
        </p>
      ) : cert.serves.length === 0 ? (
        <p>
          A certificate for{" "}
          <span className="font-mono text-foreground">*.{zone}</span> is ordered
          when the first domain in it needs HTTPS.
        </p>
      ) : null}
      {valid && cert.serves.length > 0 && <p>Serves {served(cert.serves)}</p>}
      {cert.error && (
        <p className="flex items-start gap-1.5 text-destructive">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span>
            {cert.error}
            {cert.errorAt && <> ({day(cert.errorAt)})</>}{" "}
            {cert.errorDetail && (
              <InfoTip content={cert.errorDetail.slice(0, 160)} />
            )}
          </span>
        </p>
      )}
    </div>
  );
}

/** Advanced: one certificate per zone (the default), or one of its own for every name. */
export function ZoneWildcardSwitch({
  clusterId,
  on,
}: {
  clusterId: string;
  on: boolean;
}) {
  const router = useRouter();
  const [shown, setShown] = React.useState(on);
  const [saved, setSaved] = React.useState(on);
  const [pending, startTransition] = React.useTransition();
  if (saved !== on) {
    setSaved(on);
    setShown(on);
  }
  const id = `dns-wildcard-${clusterId}`;
  const set = (next: boolean) => {
    setShown(next);
    startTransition(async () => {
      const res = await gqlAction(SET_WILDCARD, { clusterId, on: next });
      if (!res.ok) {
        setShown(!next);
        return void toast.error(res.error);
      }
      toast.success(
        next
          ? "Each zone gets one certificate for all its names"
          : "Each name gets a certificate of its own",
      );
      router.refresh();
    });
  };
  return (
    <div className="flex items-center gap-2">
      <Switch
        id={id}
        checked={shown}
        disabled={pending}
        onCheckedChange={set}
      />
      <Label htmlFor={id} className="font-normal">
        One certificate per zone
      </Label>
      <InfoTip
        content="Off: each name in the zone gets a certificate of its own, still checked through the zone."
        docs="clusters.dnsZoneCertificates"
      />
    </div>
  );
}
