"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import yaml from "js-yaml";
import { toast } from "sonner";
import {
  uniqueNamesGenerator,
  adjectives,
  animals,
} from "unique-names-generator";
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
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import {
  DomainConfigFields,
  initialDomainConfig,
  resolveDomainConfig,
  type DomainConfigState,
} from "@/components/domains/domain-config-fields";
import { gqlAction } from "@/lib/graphql-client";

/** A project as the dialog needs it: id, name, its compose YAML (when it is a
 * compose stack) so the service selector can be populated client-side, and its
 * default container port so a new single-image domain's port field is pre-filled
 * (every domain now carries an explicit port). */
export interface AddDomainApp {
  id: string;
  name: string;
  compose?: string | null;
  /** The app's default container port (build.port) — seeds the port field. */
  defaultPort?: number;
}

/** Props for {@link AddDomain}. `suggestedDomain` is a ready-to-use zero-config
 * nip.io hostname (`<slug>-<adjective>-<animal>-<hexip>.nip.io`) resolved
 * server-side; the dialog offers a one-click button to drop it into the field. */
export interface AddDomainProps {
  project: AddDomainApp;
  suggestedDomain?: string;
}

/** App names declared in a compose file, parsed in the browser (js-yaml is
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

/**
 * A server-provided suggestion has the shape
 * `<label>-<adjective>-<animal>-<hexip>.nip.io`. This peels off the app label and
 * the trailing hex-IP suffix (both of which must stay fixed for the host to keep
 * resolving to the right server) so only the two random words get regenerated.
 * `.*` is greedy, so the label absorbs any hyphens in the slug and only the last
 * two `[a-z0-9]+` tokens before the hex IP are treated as the words.
 */
const NIP_SUGGESTION_RE = /^(.*)-[a-z0-9]+-[a-z0-9]+-([0-9a-f]{8}\.nip\.io)$/i;

/** A fresh `adjective-animal` pair (same generator the server uses), in the
 * browser, so every click yields new words with no round-trip. */
function freshWords(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: "-",
    length: 2,
  });
}

/**
 * Produce a brand-new zero-config nip.io host from the server's suggestion by
 * swapping only its random words — the app label and hex-IP suffix are preserved,
 * so the result still routes to the correct server. Each call is independent (no
 * limit, no caching), so the Generate button can be clicked indefinitely. Falls
 * back to the original suggestion if it doesn't match the expected shape.
 */
function regenerateNipDomain(suggested: string): string {
  const m = NIP_SUGGESTION_RE.exec(suggested);
  if (!m) return suggested;
  const [, label, hexSuffix] = m;
  return `${label}-${freshWords()}-${hexSuffix}`;
}

export function AddDomain({ project, suggestedDomain }: AddDomainProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState("");
  // The nip.io host shown in the field-help example. Tracks the most recently
  // generated suggestion so the tooltip stays in sync with what Generate dropped
  // into the field; seeded with the server's first (already-fresh) suggestion.
  const [suggestion, setSuggestion] = React.useState(suggestedDomain);
  const [config, setConfig] = React.useState<DomainConfigState>(() =>
    initialDomainConfig(undefined, project.defaultPort),
  );

  // The app's compose services (empty ⇒ single-image). A compose stack
  // offers a service selector; the per-domain port is always available.
  const services = React.useMemo(
    () => composeServices(project.compose),
    [project.compose],
  );

  function reset() {
    setName("");
    setConfig(initialDomainConfig(undefined, project.defaultPort));
  }

  function submit() {
    const resolved = resolveDomainConfig(config, services.length > 0);
    if (!resolved.ok) {
      toast.error(resolved.error);
      return;
    }
    startTransition(async () => {
      const res = await gqlAction(
        `mutation AddDomain($appId: String!, $name: String!, $config: DomainConfigInput) {
          addDomain(appId: $appId, name: $name, config: $config) { id }
        }`,
        {
          appId: project.id,
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
            <div className="flex items-center justify-between gap-2">
              <FieldLabel
                htmlFor="domain-name"
                info={
                  suggestedDomain ? (
                    <>
                      No domain? Generate a free{" "}
                      <span className="font-mono">{suggestion}</span> that works
                      with zero DNS setup. Click again for a different one.
                    </>
                  ) : (
                    "The custom hostname to route to this app, e.g. app.example.com. Add its DNS record afterward to verify."
                  )
                }
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
