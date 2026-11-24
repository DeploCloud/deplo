"use client";

import * as React from "react";
import { servicesOf } from "@/lib/deploy/compose-lint/document";
import { toast } from "sonner";
import { Globe, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CapabilityTip, useAppCan } from "@/components/apps/app-capabilities";
import { AnimatedHeight } from "@/components/shared/animated-height";
import {
  DomainConfigFields,
  initialDomainConfig,
  resolveDomainConfig,
  type DomainConfigState,
} from "@/components/domains/domain-config-fields";
import { usePendingCreate } from "@/components/shared/pending-create";
import { gqlAction } from "@/lib/graphql-client";
import { DomainNameField } from "./domain-name-field";
import { AutoDnsField } from "./auto-dns-field";
import { ClusterAnswerField, type ClusterWay } from "./cluster-answer-field";
import { coveringZone } from "@/lib/dns-zone";
import { DocsLink } from "@/components/ui/docs-link";

export interface AddDomainApp {
  id: string;
  name: string;
  compose?: string | null;
  defaultPort?: number;
}

export interface AddDomainProps {
  project: AddDomainApp;
  suggestedDomain?: string;
  // Domains connected for automatic DNS that the viewer may use in this team.
  autoDnsZones?: string[];
  // The Tunnels experiment is on, so a domain may be served through Cloudflare Tunnel.
  tunnels?: boolean;
  // The App runs on a cluster: its DNS zones, and whether the viewer may make the first one (an instance admin).
  cluster?: { zones: string[]; canAddZone: boolean } | null;
}

export function AddDomain({
  project,
  suggestedDomain,
  autoDnsZones = [],
  tunnels = false,
  cluster = null,
}: AddDomainProps) {
  const canManage = useAppCan("manage_domains");
  const [open, setOpen] = React.useState(false);
  const { create } = usePendingCreate();
  const [name, setName] = React.useState("");
  const [config, setConfig] = React.useState<DomainConfigState>(() =>
    initialDomainConfig(undefined, project.defaultPort),
  );
  const [wantsTunnel, setWantsTunnel] = React.useState(false);
  const [way, setWay] = React.useState<ClusterWay | null>(null);
  const zone = coveringZone(autoDnsZones, name);
  // A name inside the cluster's own zone is answered by it, never by a tunnel.
  const inside = cluster ? coveringZone(cluster.zones, name) : null;
  const choosing = cluster != null && zone !== null && inside === null;
  const clusterWay: ClusterWay =
    way ??
    (cluster && (cluster.zones.length > 0 || cluster.canAddZone)
      ? "cluster"
      : "tunnel");
  // An App off a cluster, in a connected zone: Deplo makes the record, straight at the server by default.
  const autoDns = cluster == null && zone !== null;
  const tunnel = choosing
    ? clusterWay === "tunnel"
    : tunnels && autoDns && wantsTunnel;
  const byCluster = inside !== null || (choosing && clusterWay === "cluster");

  const services = React.useMemo(
    () => Object.keys(servicesOf(project.compose ?? null) ?? {}),
    [project.compose],
  );

  function reset() {
    setName("");
    setConfig(initialDomainConfig(undefined, project.defaultPort));
    setWantsTunnel(false);
    setWay(null);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function submit() {
    const resolved = resolveDomainConfig(
      config,
      services.length > 0,
      name.trim(),
    );
    if (!resolved.ok) {
      toast.error(resolved.error);
      return;
    }
    const typed = { name: name.trim(), config, tunnel, way, choosing };
    setOpen(false);
    reset();
    create(
      { label: typed.name, note: "Adding domain…" },
      () =>
        gqlAction<{
          addDomain: {
            id: string;
            status: string;
            answersEverywhere: boolean;
            clusterFallback: string | null;
          };
        }>(
          `mutation AddDomain($appId: String!, $name: String!, $config: DomainConfigInput) {
          addDomain(appId: $appId, name: $name, config: $config) { id status answersEverywhere clusterFallback }
        }`,
          {
            appId: project.id,
            name: typed.name,
            config: {
              port: resolved.port,
              entrypoint: resolved.entrypoint ?? undefined,
              certProvider: resolved.certProvider,
              middlewares: resolved.middlewares,
              securityHeaders: resolved.securityHeaders,
              corsOrigins: resolved.corsOrigins,
              pathPrefix: resolved.pathPrefix,
              stripPrefix: resolved.stripPrefix,
              service: resolved.service,
              proxied: resolved.proxied,
              www: resolved.www,
              ...(typed.choosing
                ? { tunnel: typed.tunnel }
                : typed.tunnel
                  ? { tunnel: true }
                  : {}),
            },
          },
        ),
      {
        onSuccess: (data) => {
          const status = data?.addDomain.status;
          if (data?.addDomain.clusterFallback)
            toast.warning(
              "Domain added on the Cloudflare Tunnel for now - its row says why",
            );
          else if (data?.addDomain.answersEverywhere)
            toast.success(
              "Domain added - every server of the cluster answers it, HTTPS included",
            );
          else if (typed.tunnel)
            toast.success(
              "Domain added - Cloudflare serves it through a tunnel, HTTPS included",
            );
          else if (zone)
            toast.success(
              status === "valid"
                ? "Domain added - Deplo created its DNS record, routing is live"
                : "Domain added - Deplo created its DNS record in Cloudflare. It verifies automatically.",
            );
          else if (resolved.proxied)
            toast.success(
              "Domain added - routed through your proxy. Point the proxy at this server.",
            );
          else if (status === "valid")
            toast.success(
              "Domain added - DNS already points here, routing is live",
            );
          else if (status === "cloudflare")
            toast.success(
              "Domain added - Cloudflare is proxying it. Make sure its record points at this server.",
            );
          else if (status === "misconfigured")
            toast.warning(
              "Domain added, but its DNS points at another address - see the hint on its row",
            );
          else
            toast.success(
              "Domain added - point its DNS at the server and it verifies automatically",
            );
        },
        onError: () => {
          setName(typed.name);
          setConfig(typed.config);
          setWantsTunnel(typed.tunnel);
          setWay(typed.way);
          setOpen(true);
        },
      },
    );
  }

  if (!canManage) {
    return (
      <CapabilityTip cap="manage_domains">
        <Button size="sm" disabled>
          <Plus className="size-4" />
          Add Domain
        </Button>
      </CapabilityTip>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          Add Domain
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a domain</DialogTitle>
          <DialogDescription>
            Point a custom domain at <strong>{project.name}</strong>. Deplo
            checks its DNS as you add it. <DocsLink topic="domains.overview" />
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <AnimatedHeight className="grid gap-4" scroll={false}>
            <div className="space-y-4">
              <DomainNameField
                id="domain-name"
                value={name}
                onChange={setName}
                suggestedDomain={suggestedDomain}
              />
              {inside ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Globe className="size-3.5 shrink-0" />
                  <span>
                    The cluster&rsquo;s DNS zone{" "}
                    <span className="font-mono text-foreground">{inside}</span>{" "}
                    answers it. <DocsLink topic="clusters.dnsZoneDomains" />
                  </span>
                </p>
              ) : choosing && cluster ? (
                <ClusterAnswerField
                  zone={zone}
                  clusterZone={cluster.zones[0] ?? null}
                  canAddZone={cluster.canAddZone}
                  way={clusterWay}
                  onWay={setWay}
                />
              ) : (
                autoDns &&
                zone && (
                  <AutoDnsField
                    id="add-domain-cf"
                    zone={zone}
                    tunnel={tunnel}
                    onTunnel={tunnels ? setWantsTunnel : undefined}
                    proxied={config.proxied}
                    onProxied={(on) => setConfig({ ...config, proxied: on })}
                  />
                )
              )}
              <DomainConfigFields
                state={config}
                onChange={setConfig}
                services={services}
                idPrefix="add-domain"
                hostname={name}
                tunnel={tunnel}
                clusterAnswer={byCluster}
                autoDns={autoDns}
              />
            </div>
          </AnimatedHeight>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Add domain
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
