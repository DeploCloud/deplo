"use client";

import { CloudflareIcon } from "@/components/shared/brand-icons";
import { DocsLink } from "@/components/ui/docs-link";
import { SlidingButtonGroup } from "@/components/ui/sliding-button-group";
import { cn } from "@/lib/utils";

// A cluster App's domain under a domain connected for automatic DNS (ADR-0049):
// https://deplo.build/docs/guides/networking/automatic-dns#an-app-on-a-cluster

export type ClusterWay = "cluster" | "tunnel";

/** Picks who answers the domain: the cluster's own DNS zone (the default) or the App's Cloudflare Tunnel. */
export function ClusterAnswerField({
  zone,
  clusterZone,
  canAddZone,
  way,
  onWay,
}: {
  /** The domain connected for automatic DNS that covers the name. */
  zone: string;
  /** The cluster's DNS zone, or null when it has none yet. */
  clusterZone: string | null;
  canAddZone: boolean;
  way: ClusterWay;
  onWay: (way: ClusterWay) => void;
}) {
  const clusterPossible = clusterZone != null || canAddZone;
  const option = (value: ClusterWay, label: string, disabled = false) => (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={way === value}
      onClick={() => onWay(value)}
      className={cn(
        "flex-1 rounded-md px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50",
        way === value
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="space-y-2 rounded-md border border-[#f38020]/40 bg-[#f38020]/5 px-3 py-2">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <CloudflareIcon className="size-3.5 shrink-0 text-[#f38020]" />
        <span>
          Deplo writes its DNS records in{" "}
          <span className="font-mono text-foreground">{zone}</span>.{" "}
          <DocsLink topic="domains.automaticDnsCluster" />
        </span>
      </p>
      <SlidingButtonGroup aria-label="Who answers this domain">
        {option("cluster", "Let the cluster answer", !clusterPossible)}
        {option("tunnel", "Cloudflare Tunnel")}
      </SlidingButtonGroup>
      <p className="text-xs text-muted-foreground">
        {way === "tunnel"
          ? clusterPossible
            ? "Cloudflare reaches the App over a connection it opens: no port to open, HTTPS included."
            : "Let the cluster answer: an instance admin has to add the cluster's DNS zone first."
          : clusterZone
            ? `Every server of the cluster answers it, through ${clusterZone}.`
            : `Deplo first makes the cluster's DNS zone under ${zone}, then every server answers it.`}
      </p>
    </div>
  );
}
