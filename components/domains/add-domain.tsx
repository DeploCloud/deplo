"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import yaml from "js-yaml";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DomainConfigFields,
  initialDomainConfig,
  resolveDomainConfig,
  type DomainConfigState,
} from "@/components/domains/domain-config-fields";
import { gqlAction } from "@/lib/graphql-client";

/** A project as the dialog needs it: id, name, and its compose YAML (when it is
 * a compose stack) so the service selector can be populated client-side. */
export interface AddDomainProject {
  id: string;
  name: string;
  compose?: string | null;
}

/** Service names declared in a compose file, parsed in the browser (js-yaml is
 * a client-safe dep, also used by the compose linter). Returns [] for a missing
 * or malformed compose — the dialog then shows no service selector. */
function composeServices(compose?: string | null): string[] {
  if (!compose || !compose.trim()) return [];
  try {
    const doc = yaml.load(compose) as { services?: Record<string, unknown> } | undefined;
    const svc = doc?.services;
    return svc && typeof svc === "object" && !Array.isArray(svc) ? Object.keys(svc) : [];
  } catch {
    return [];
  }
}

export function AddDomain({ project }: { project: AddDomainProject }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState("");
  const [config, setConfig] = React.useState<DomainConfigState>(() =>
    initialDomainConfig(),
  );

  // The project's compose services (empty ⇒ single-image). A compose stack
  // offers a service selector; the per-domain port is always available.
  const services = React.useMemo(
    () => composeServices(project.compose),
    [project.compose],
  );

  function reset() {
    setName("");
    setConfig(initialDomainConfig());
  }

  function submit() {
    const resolved = resolveDomainConfig(config, services.length > 0);
    if (!resolved.ok) {
      toast.error(resolved.error);
      return;
    }
    startTransition(async () => {
      const res = await gqlAction(
        `mutation AddDomain($projectId: String!, $name: String!, $config: DomainConfigInput) {
          addDomain(projectId: $projectId, name: $name, config: $config) { id }
        }`,
        {
          projectId: project.id,
          name,
          config: {
            port: resolved.port,
            // Add takes the auto entrypoint by omitting it (null ⇒ undefined).
            entrypoint: resolved.entrypoint ?? undefined,
            certProvider: resolved.certProvider,
            middlewares: resolved.middlewares,
            pathPrefix: resolved.pathPrefix,
            stripPrefix: resolved.stripPrefix,
            service: resolved.service,
          },
        },
      );
      if (res.ok) {
        toast.success("Domain added — configure DNS to verify");
        setOpen(false);
        reset();
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          Add Domain
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a domain</DialogTitle>
          <DialogDescription>
            Point a custom domain at{" "}
            <span className="font-medium">{project.name}</span>. Deplo issues TLS
            automatically via Let&apos;s Encrypt.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="domain-name">Domain</Label>
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
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !name.trim()}>
            {pending ? "Adding…" : "Add domain"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
