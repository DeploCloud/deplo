"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CertProvider, DomainEntrypoint } from "@/lib/types";

/** Entrypoint options — the two entrypoints the proxy's static config defines.
 * Only offered when the user opts into managing the entrypoint manually;
 * otherwise it is derived from the certificate provider (websecure for TLS,
 * web for none). */
export const ENTRYPOINTS: { value: DomainEntrypoint; label: string }[] = [
  { value: "websecure", label: "websecure (:443)" },
  { value: "web", label: "web (:80)" },
];

/** Certificate providers, including "None" (no TLS — plain HTTP on the web
 * entrypoint). The dropdown is the single TLS control: picking "None" is how a
 * domain opts out of HTTPS (there is no separate checkbox). */
export const CERT_PROVIDERS: { value: CertProvider; label: string }[] = [
  { value: "letsencrypt", label: "Let's Encrypt" },
  { value: "cloudflare", label: "Cloudflare" },
  { value: "none", label: "None (no certificate)" },
];

/** The editable per-domain routing values, held as form state by the caller. */
export interface DomainConfigState {
  port: string;
  /** Whether the user manages the entrypoint by hand. Off ⇒ it's derived from
   * the certificate provider; on ⇒ `entrypoint` below is sent verbatim. */
  manualEntrypoint: boolean;
  entrypoint: DomainEntrypoint;
  /** Certificate provider — the single TLS control. "none" ⇒ plain HTTP. */
  certProvider: CertProvider;
  /** Raw comma-separated middlewares text, split on submit. */
  middlewares: string;
  /** Internal path prefix the router matches (Traefik PathPrefix). */
  path: string;
  /** Strip the path prefix before forwarding (Traefik stripprefix middleware). */
  stripPath: boolean;
  /** Compose-stack only: which compose service this host targets ("" ⇒ default). */
  service: string;
}

/** Seed config form state from a domain (or defaults for a brand-new domain).
 * `manualEntrypoint` seeds on whether the domain stored an explicit entrypoint
 * — an absent entrypoint means "auto" (the data layer derived it).
 *
 * `defaultPort` pre-fills the port field for a BRAND-NEW domain (the Add dialog,
 * where `domain` is undefined) so single-image domains are created with an
 * explicit port rather than blank — every domain now carries a concrete port.
 * Ignored when editing an existing domain (its stored port wins). */
export function initialDomainConfig(
  domain?: {
    port?: number | null;
    entrypoint?: DomainEntrypoint;
    certProvider?: CertProvider;
    middlewares?: string[];
    pathPrefix?: string;
    stripPrefix?: boolean;
    service?: string;
  },
  defaultPort?: number,
): DomainConfigState {
  return {
    port:
      domain?.port != null
        ? String(domain.port)
        : defaultPort != null
          ? String(defaultPort)
          : "",
    manualEntrypoint: domain?.entrypoint != null,
    entrypoint: domain?.entrypoint ?? "websecure",
    certProvider: domain?.certProvider ?? "letsencrypt",
    middlewares: (domain?.middlewares ?? []).join(", "),
    path: domain?.pathPrefix ?? "",
    stripPath: Boolean(domain?.stripPrefix),
    service: domain?.service ?? "",
  };
}

/** Split the comma-separated middlewares text into a trimmed, non-empty array. */
export function parseMiddlewares(text: string): string[] {
  return text
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

/** Validate + resolve config form state into the action payload, or return an
 * error string. On a compose stack (`isCompose`) the service and the service
 * port are BOTH required — a domain must name the compose service it routes to
 * and that service's container port. On a single-image project the port stays
 * optional (blank ⇒ the service's default port).
 *
 * `entrypoint` resolves to a tri-state the action layer understands:
 *   - a concrete value → manual mode
 *   - `null`           → auto (the data layer derives it)
 * The `none` provider always resolves to `null` (auto) because it forces the
 * `web` entrypoint regardless — surfacing a manual choice there would be a lie.
 */
export function resolveDomainConfig(
  state: DomainConfigState,
  isCompose: boolean,
):
  | {
      ok: true;
      port: number | null;
      entrypoint: DomainEntrypoint | null;
      certProvider: CertProvider;
      middlewares: string[];
      pathPrefix: string;
      stripPrefix: boolean;
      service: string;
    }
  | { ok: false; error: string } {
  const service = state.service.trim();
  if (isCompose && !service) {
    return { ok: false, error: "Select the service this domain routes to" };
  }
  const rawPort = state.port.trim();
  if (isCompose && !rawPort) {
    return { ok: false, error: "Service port is required" };
  }
  const port = rawPort ? Number(rawPort) : null;
  if (rawPort && (!Number.isInteger(port) || port! < 1 || port! > 65535)) {
    return { ok: false, error: "Port must be between 1 and 65535" };
  }
  const path = state.path.trim();
  if (path && !path.startsWith("/")) {
    return { ok: false, error: "Internal path must start with /" };
  }
  if (path.includes("`")) {
    return { ok: false, error: "Internal path can't contain a backtick" };
  }
  const manual = state.manualEntrypoint && state.certProvider !== "none";
  return {
    ok: true,
    port,
    entrypoint: manual ? state.entrypoint : null,
    certProvider: state.certProvider,
    middlewares: parseMiddlewares(state.middlewares),
    pathPrefix: path,
    // Strip is meaningless without a path; never send a true with no path.
    stripPrefix: path ? state.stripPath : false,
    service,
  };
}

/**
 * The shared per-domain routing fields, rendered identically in the Add and Edit
 * dialogs so the two never drift. Always-visible: the service selector (compose
 * stacks only) and the service port. Folded into an "Advanced settings"
 * collapsible: the certificate provider, entrypoint (with a manual-override
 * checkbox), the internal path + strip-path option, and the middleware chain.
 * `idPrefix` namespaces the input ids (multiple instances can coexist on a page).
 * `services` lists a compose service's service names — when non-empty the service
 * selector is shown (empty ⇒ a single-image project, no service concept).
 */
export function DomainConfigFields({
  state,
  onChange,
  idPrefix,
  services = [],
}: {
  state: DomainConfigState;
  onChange: (next: DomainConfigState) => void;
  idPrefix: string;
  /** Compose service names for the service selector; empty ⇒ single-image. */
  services?: string[];
}) {
  const set = <K extends keyof DomainConfigState>(
    key: K,
    value: DomainConfigState[K],
  ) => onChange({ ...state, [key]: value });

  const isCompose = services.length > 0;
  const noCert = state.certProvider === "none";
  const hasPath = state.path.trim().length > 0;

  return (
    <>
      {isCompose && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-service`}>Service</Label>
          <Select
            value={state.service}
            onValueChange={(v) => set("service", v)}
          >
            <SelectTrigger id={`${idPrefix}-service`}>
              <SelectValue placeholder="Select a service" />
            </SelectTrigger>
            <SelectContent>
              {services.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Which compose service this domain routes to.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-port`}>Service port</Label>
        <Input
          id={`${idPrefix}-port`}
          type="number"
          min={1}
          max={65535}
          value={state.port}
          onChange={(e) => set("port", e.target.value)}
          placeholder="e.g. 8080"
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          {isCompose
            ? "The container port of the selected service to route to."
            : "The container port this domain routes to. Defaults to the service's port."}
        </p>
      </div>

      <Accordion type="single" collapsible>
        <AccordionItem value="advanced" className="border-none">
          <AccordionTrigger className="py-2">Advanced settings</AccordionTrigger>
          <AccordionContent className="space-y-4 pt-1 text-foreground">
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-cert`}>Certificate provider</Label>
              <Select
                value={state.certProvider}
                onValueChange={(v) => set("certProvider", v as CertProvider)}
              >
                <SelectTrigger id={`${idPrefix}-cert`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CERT_PROVIDERS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {noCert && (
                <p className="text-xs text-muted-foreground">
                  No certificate — this domain is served over plain HTTP on the{" "}
                  <span className="font-mono">web</span> entrypoint.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`${idPrefix}-manual-ep`}
                  checked={state.manualEntrypoint}
                  disabled={noCert}
                  onCheckedChange={(c) => set("manualEntrypoint", c === true)}
                />
                <Label
                  htmlFor={`${idPrefix}-manual-ep`}
                  className="cursor-pointer font-normal"
                >
                  Set entrypoint manually
                </Label>
              </div>
              {noCert ? (
                <p className="text-xs text-muted-foreground">
                  With no certificate the entrypoint is always{" "}
                  <span className="font-mono">web</span>.
                </p>
              ) : state.manualEntrypoint ? (
                <Select
                  value={state.entrypoint}
                  onValueChange={(v) => set("entrypoint", v as DomainEntrypoint)}
                >
                  <SelectTrigger id={`${idPrefix}-entrypoint`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ENTRYPOINTS.map((e) => (
                      <SelectItem key={e.value} value={e.value}>
                        {e.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Managed automatically (
                  <span className="font-mono">websecure</span> for HTTPS).
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-path`}>
                Internal path{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Input
                id={`${idPrefix}-path`}
                value={state.path}
                onChange={(e) => set("path", e.target.value)}
                placeholder="/api"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Only requests under this path are routed to this target. Leave
                blank to route the whole host.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id={`${idPrefix}-strip`}
                checked={hasPath && state.stripPath}
                disabled={!hasPath}
                onCheckedChange={(c) => set("stripPath", c === true)}
              />
              <Label
                htmlFor={`${idPrefix}-strip`}
                className="cursor-pointer font-normal"
              >
                Strip path before forwarding
                {!hasPath && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    (set an internal path first)
                  </span>
                )}
              </Label>
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-middlewares`}>
                Middlewares{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Input
                id={`${idPrefix}-middlewares`}
                value={state.middlewares}
                onChange={(e) => set("middlewares", e.target.value)}
                placeholder="redirect-https, secure-headers@file, rate-limit, auth@file, compress"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated Traefik middlewares applied in order. Each must
                already be defined on the proxy.
              </p>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </>
  );
}
