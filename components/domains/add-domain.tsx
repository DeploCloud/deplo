"use client";

import * as React from "react";
import yaml from "@/lib/yaml";
import { toast } from "sonner";
import { Plus, Sparkles } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { AnimatedHeight } from "@/components/shared/animated-height";
import { FieldLabel } from "@/components/ui/info-tip";
import {
  DomainConfigFields,
  initialDomainConfig,
  resolveDomainConfig,
  type DomainConfigState,
} from "@/components/domains/domain-config-fields";
import { usePendingCreate } from "@/components/shared/pending-create";
import { gqlAction } from "@/lib/graphql-client";
import { regenerateNipDomain } from "@/lib/nip-suggestion";
import { DocsLink } from "@/components/ui/docs-link";

// A project as the dialog needs it: the compose YAML populates the service selector.
export interface AddDomainApp {
  id: string;
  name: string;
  compose?: string | null;
  // The app's default container port (build.port) - seeds the port field.
  defaultPort?: number;
}

// `suggestedDomain` is a zero-config nip.io hostname (`<slug>-<adjective>-<animal>-<hexip>.nip.io`) resolved server-side.
export interface AddDomainProps {
  project: AddDomainApp;
  suggestedDomain?: string;
}

// Parsed in the browser (js-yaml is a client-safe dep); [] for a missing or malformed compose ⇒ no service selector.
function composeServices(compose?: string | null): string[] {
  if (!compose || !compose.trim()) return [];
  try {
    const doc = yaml.load(compose) as
      { services?: Record<string, unknown> } | undefined;
    const svc = doc?.services;
    return svc && typeof svc === "object" && !Array.isArray(svc)
      ? Object.keys(svc)
      : [];
  } catch {
    return [];
  }
}

export function AddDomain({ project, suggestedDomain }: AddDomainProps) {
  const canManage = useAppCan("manage_domains");
  const [open, setOpen] = React.useState(false);
  const { create } = usePendingCreate();
  const [name, setName] = React.useState("");
  // Tracks the last generated suggestion so the field help matches what Generate dropped into the field.
  const [suggestion, setSuggestion] = React.useState(suggestedDomain);
  const [config, setConfig] = React.useState<DomainConfigState>(() =>
    initialDomainConfig(undefined, project.defaultPort),
  );

  const services = React.useMemo(
    () => composeServices(project.compose),
    [project.compose],
  );

  function reset() {
    setName("");
    setConfig(initialDomainConfig(undefined, project.defaultPort));
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
    // What was typed is kept aside so a rejected add can hand the form back untouched.
    const typed = { name: name.trim(), config };
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
              // Add takes the auto entrypoint by omitting it (null ⇒ undefined).
              entrypoint: resolved.entrypoint ?? undefined,
              certProvider: resolved.certProvider,
              middlewares: resolved.middlewares,
              pathPrefix: resolved.pathPrefix,
              stripPrefix: resolved.stripPrefix,
              service: resolved.service,
              proxied: resolved.proxied,
              // The server adds the second hostname, checks its DNS and wires the 301 before the add returns.
              www: resolved.www,
            },
          },
        ),
      {
        onSuccess: (data) => {
          // DNS is checked as part of the add, so the toast reports the real outcome.
          const status = data?.addDomain.status;
          if (resolved.proxied)
            // A proxied host's DNS verdict says nothing; what matters is that it is routed.
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
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <FieldLabel
                    htmlFor="domain-name"
                    info={
                      suggestedDomain ? (
                        <>
                          No domain? Generate a free{" "}
                          <span className="font-mono">{suggestion}</span> that
                          works with zero DNS setup. Click again for a different
                          one.
                        </>
                      ) : (
                        "The custom hostname to route to this app, e.g. app.example.com. Add its DNS record afterward to verify."
                      )
                    }
                    docs="domains.noDomainYet"
                  >
                    Domain
                  </FieldLabel>
                  {suggestedDomain ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      onClick={() => {
                        const next = regenerateNipDomain(suggestedDomain);
                        setSuggestion(next);
                        setName(next);
                      }}
                    >
                      <Sparkles className="size-3.5" />
                      Generate
                    </Button>
                  ) : null}
                </div>
                <Input
                  id="domain-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="app.example.com"
                  className="font-mono text-sm"
                />
              </div>
              <DomainConfigFields
                state={config}
                onChange={setConfig}
                services={services}
                idPrefix="add-domain"
                hostname={name}
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
