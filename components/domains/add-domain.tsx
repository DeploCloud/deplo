"use client";

import * as React from "react";
import { servicesOf } from "@/lib/deploy/compose-lint/document";
import { toast } from "sonner";
import { Plus } from "lucide-react";
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
}

export function AddDomain({
  project,
  suggestedDomain,
  autoDnsZones = [],
}: AddDomainProps) {
  const canManage = useAppCan("manage_domains");
  const [open, setOpen] = React.useState(false);
  const { create } = usePendingCreate();
  const [name, setName] = React.useState("");
  const [config, setConfig] = React.useState<DomainConfigState>(() =>
    initialDomainConfig(undefined, project.defaultPort),
  );
  const [wantsTunnel, setWantsTunnel] = React.useState(false);
  const zone = coveringZone(autoDnsZones, name);
  const tunnel = wantsTunnel && zone !== null;

  const services = React.useMemo(
    () => Object.keys(servicesOf(project.compose ?? null) ?? {}),
    [project.compose],
  );

  function reset() {
    setName("");
    setConfig(initialDomainConfig(undefined, project.defaultPort));
    setWantsTunnel(false);
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
    const typed = { name: name.trim(), config, tunnel };
    setOpen(false);
    reset();
    create(
      { label: typed.name, note: "Adding domain…" },
      () =>
        gqlAction<{ addDomain: { id: string; status: string } }>(
          `mutation AddDomain($appId: String!, $name: String!, $config: DomainConfigInput) {
          addDomain(appId: $appId, name: $name, config: $config) { id status }
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
              ...(typed.tunnel ? { tunnel: true } : {}),
            },
          },
        ),
      {
        onSuccess: (data) => {
          const status = data?.addDomain.status;
          if (typed.tunnel)
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
              {zone && (
                <AutoDnsField
                  id="add-domain-tunnel"
                  zone={zone}
                  tunnel={tunnel}
                  onTunnel={setWantsTunnel}
                />
              )}
              <DomainConfigFields
                state={config}
                onChange={setConfig}
                services={services}
                idPrefix="add-domain"
                hostname={name}
                tunnel={tunnel}
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
