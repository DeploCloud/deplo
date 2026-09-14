"use client";

import * as React from "react";
import { Lock, Route, Signpost, Waypoints } from "lucide-react";
import { Input } from "@/components/ui/input";
import { CloudflareNote } from "@/components/domains/cloudflare-note";
import { FieldLabel } from "@/components/ui/info-tip";
import { Switch } from "@/components/ui/switch";
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
import { wwwCounterpart, type WwwRedirect } from "@/lib/www-redirect";
import type { CertProvider, DomainEntrypoint } from "@/lib/types/domain";

// The two entrypoints the proxy's static config defines.
export const ENTRYPOINTS: { value: DomainEntrypoint; label: string }[] = [
  { value: "websecure", label: "HTTPS - websecure (:443)" },
  { value: "web", label: "HTTP - web (:80)" },
];

// Sentinel for "derive from the certificate": the absence of a manual choice, not a Traefik entrypoint.
const ENTRYPOINT_AUTO = "auto";

// Certificate providers - the dropdown is the single TLS control, and picking one is how a domain opts into HTTPS.
export const CERT_PROVIDERS: { value: CertProvider; label: string }[] = [
  { value: "none", label: "None (no certificate)" },
  { value: "letsencrypt", label: "Let's Encrypt" },
  { value: "cloudflare", label: "Cloudflare" },
  { value: "custom", label: "Installed on the server" },
];

// The editable per-domain routing values, held as form state by the caller.
export interface DomainConfigState {
  port: string;
  // Off ⇒ the entrypoint is derived from the certificate provider; on ⇒ `entrypoint` is sent verbatim.
  manualEntrypoint: boolean;
  entrypoint: DomainEntrypoint;
  // The single TLS control. "none" ⇒ plain HTTP.
  certProvider: CertProvider;
  // Raw comma-separated text, split on submit.
  middlewares: string;
  // Internal path prefix the router matches (Traefik PathPrefix).
  path: string;
  // Strip the path prefix before forwarding (Traefik stripprefix middleware).
  stripPath: boolean;
  // Compose-stack only: which compose service this host targets ("" ⇒ default).
  service: string;
  // Its DNS never points here, so the check can only ever say `misconfigured`. Routed anyway.
  proxied: boolean;
  // Derived from the app's rows by the caller (never a stored flag) and posted back on save.
  www: WwwRedirect;
}

// Seed form state from a domain. An existing row with no provider reads as legacy `letsencrypt`, which is what the deploy edge runs.
export function initialDomainConfig(
  domain?: {
    port?: number | null;
    entrypoint?: DomainEntrypoint;
    certProvider?: CertProvider;
    middlewares?: string[];
    pathPrefix?: string;
    stripPrefix?: boolean;
    service?: string;
    proxied?: boolean;
  },
  defaultPort?: number,
  // The pairing the app's rows describe (`deriveWwwRedirect`); `none` for a brand-new domain.
  www: WwwRedirect = "none",
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
    certProvider: domain ? (domain.certProvider ?? "letsencrypt") : "none",
    middlewares: (domain?.middlewares ?? []).join(", "),
    path: domain?.pathPrefix ?? "",
    stripPath: Boolean(domain?.stripPrefix),
    service: domain?.service ?? "",
    proxied: Boolean(domain?.proxied),
    www,
  };
}

// Split the comma-separated middlewares text into a trimmed, non-empty array.
export function parseMiddlewares(text: string): string[] {
  return text
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

// Resolve form state into the action payload. `entrypoint` is tri-state: a value is manual, `null` is auto, and "none" forces `null`.
export function resolveDomainConfig(
  state: DomainConfigState,
  isCompose: boolean,
  // A `www` pairing is dropped when the hostname has no counterpart - the server can only reject one.
  hostname?: string,
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
      proxied: boolean;
      www: WwwRedirect;
    }
  | { ok: false; error: string } {
  const service = state.service.trim();
  if (isCompose && !service) {
    return { ok: false, error: "Select the container this domain routes to" };
  }
  const rawPort = state.port.trim();
  if (isCompose && !rawPort) {
    return { ok: false, error: "Application port is required" };
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
    proxied: state.proxied,
    // Sent as-is: the pairing is derived from the app's rows, so the current value is a no-op server-side.
    www:
      hostname !== undefined && wwwCounterpart(hostname) == null
        ? "none"
        : state.www,
  };
}

// Only the parts that diverge from a new domain's defaults, so a first-run dialog summarises nothing.
export function advancedSummary(
  state: DomainConfigState,
  // Absent ⇒ a `www` pairing is summarised without naming the hostname.
  hostname?: string,
): string {
  const parts: string[] = [];
  if (state.www !== "none") {
    const counterpart = wwwCounterpart(hostname ?? "");
    parts.push(
      state.www === "toThis"
        ? counterpart
          ? `${counterpart} redirects here`
          : "www redirects here"
        : counterpart
          ? `redirects to ${counterpart}`
          : "redirects to www",
    );
  }
  if (state.proxied) parts.push("behind a proxy");
  const path = state.path.trim();
  if (path) parts.push(state.stripPath ? `${path} (stripped)` : path);
  const count = parseMiddlewares(state.middlewares).length;
  if (count) parts.push(count === 1 ? "1 middleware" : `${count} middlewares`);
  return parts.join(" · ");
}

function FieldGroup({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="flex items-center gap-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        <Icon className="size-3.5" />
        {title}
      </legend>
      <div className="space-y-4">{children}</div>
    </fieldset>
  );
}

// The shared per-domain routing fields, rendered identically in the Add and Edit dialogs so the two never drift.
export function DomainConfigFields({
  state,
  onChange,
  idPrefix,
  services = [],
  proxied = false,
  hostname,
  serverIp,
}: {
  state: DomainConfigState;
  onChange: (next: DomainConfigState) => void;
  idPrefix: string;
  // Compose service names for the service selector; empty ⇒ single-image.
  services?: string[];
  // True when this domain's DNS check came back `cloudflare`.
  proxied?: boolean;
  serverIp?: string;
  // Purely presentational - it never enters `DomainConfigState` nor the mutation payload.
  hostname?: string;
}) {
  const set = <K extends keyof DomainConfigState>(
    key: K,
    value: DomainConfigState[K],
  ) => onChange({ ...state, [key]: value });

  const isCompose = services.length > 0;
  const noCert = state.certProvider === "none";
  const rawPath = state.path.trim();
  const hasPath = rawPath.length > 0;
  // The same two checks `resolveDomainConfig` runs: the preview must never illustrate a config the submit rejects.
  const pathError = !hasPath
    ? null
    : !rawPath.startsWith("/")
      ? "Internal path must start with /"
      : rawPath.includes("`")
        ? "Internal path can't contain a backtick"
        : null;
  const sampleIn = `${rawPath.replace(/\/+$/, "")}/users`;
  const sampleOut = state.stripPath ? "/users" : sampleIn;

  // With no certificate `resolveDomainConfig` ignores the manual flag, so the control shows auto rather than a stale override.
  const entrypointValue =
    noCert || !state.manualEntrypoint ? ENTRYPOINT_AUTO : state.entrypoint;
  const summary = advancedSummary(state, hostname);

  // Null for a hostname with no meaningful pair (an `api.` subdomain, a generated nip.io host).
  const host = (hostname ?? "").trim();
  const counterpart = wwwCounterpart(host);
  const showWww = counterpart != null && (!hasPath || state.www !== "none");
  const redirectingHost =
    state.www === "toCounterpart" ? host : (counterpart ?? "");

  return (
    <>
      {proxied && <CloudflareNote serverIp={serverIp} />}
      {isCompose && (
        <div className="space-y-2">
          {/* The stack's containers, by the same compose service names the Logs and Console pickers list. */}
          <FieldLabel
            htmlFor={`${idPrefix}-service`}
            info="Which container of this app's compose stack serves this domain."
            docs="compose.differences"
          >
            Container
          </FieldLabel>
          <Select
            value={state.service}
            onValueChange={(v) => set("service", v)}
          >
            <SelectTrigger id={`${idPrefix}-service`}>
              <SelectValue placeholder="Select a container" />
            </SelectTrigger>
            <SelectContent>
              {services.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-2">
        <FieldLabel
          htmlFor={`${idPrefix}-port`}
          info={
            isCompose
              ? "The port the selected container listens on."
              : "The port your app listens on inside its container. Defaults to the app's port."
          }
          docs="build.port"
        >
          Application port
        </FieldLabel>
        <Input
          id={`${idPrefix}-port`}
          type="number"
          inputMode="numeric"
          min={1}
          max={65535}
          value={state.port}
          onChange={(e) => set("port", e.target.value)}
          placeholder="e.g. 8080"
          // Native spinner arrows collide with a mono value; same hiding as `LimitField`.
          className="[appearance:textfield] font-mono text-sm [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
      </div>

      <FieldGroup icon={Lock} title="HTTPS">
        <div className="space-y-2">
          <FieldLabel
            htmlFor={`${idPrefix}-cert`}
            info="Where this domain's HTTPS certificate comes from. A Cloudflare-proxied domain is set automatically; None serves plain HTTP."
            docs="domains.certificates"
          >
            Certificate
          </FieldLabel>
          <Select
            value={state.certProvider}
            onValueChange={(v) =>
              // ONE onChange, never two set() calls: the second would spread the stale `state` and drop the first key.
              onChange({
                ...state,
                certProvider: v as CertProvider,
                manualEntrypoint: v === "none" ? false : state.manualEntrypoint,
              })
            }
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
        </div>

        <div className="space-y-2">
          <FieldLabel
            htmlFor={`${idPrefix}-entrypoint`}
            info={
              <>
                The proxy entrypoint this domain binds to:{" "}
                <code className="font-mono">websecure</code> (:443) serves
                HTTPS, <code className="font-mono">web</code> (:80) serves plain
                HTTP. Leave it Automatic and Deplo follows the certificate. Pick{" "}
                <code className="font-mono">web</code> only when something in
                front already terminates TLS, e.g. Cloudflare in Flexible mode.
              </>
            }
            docs="domains.certificates"
          >
            Entrypoint
          </FieldLabel>
          {/* One stable control rather than a checkbox and a Select swapping in the same slot. */}
          <Select
            value={entrypointValue}
            disabled={noCert}
            onValueChange={(v) =>
              v === ENTRYPOINT_AUTO
                ? onChange({ ...state, manualEntrypoint: false })
                : onChange({
                    ...state,
                    manualEntrypoint: true,
                    entrypoint: v as DomainEntrypoint,
                  })
            }
          >
            <SelectTrigger id={`${idPrefix}-entrypoint`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ENTRYPOINT_AUTO}>
                {noCert
                  ? "Automatic - HTTP on web (:80)"
                  : "Automatic - HTTPS on websecure (:443)"}
              </SelectItem>
              {ENTRYPOINTS.map((e) => (
                <SelectItem key={e.value} value={e.value}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </FieldGroup>

      {/* Collapsed on every open, in Add and in Edit, so the first-run path never meets it. */}
      <Accordion type="single" collapsible className="border-t border-border">
        <AccordionItem value="advanced" className="border-none">
          <AccordionTrigger className="group gap-3 rounded-md py-3 hover:no-underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <span className="flex min-w-0 flex-1 items-center gap-3">
              {/* shrink-0 so the title never wraps while the summary, which owns `truncate`, gives way. */}
              <span className="shrink-0 group-hover:underline">
                Advanced settings
              </span>
              {summary ? (
                <span className="ml-auto truncate text-xs font-normal text-muted-foreground group-data-[state=open]:hidden">
                  {summary}
                </span>
              ) : null}
            </span>
          </AccordionTrigger>

          <AccordionContent className="space-y-6 pt-2 text-foreground">
            <FieldGroup icon={Waypoints} title="Proxy">
              <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                <FieldLabel
                  htmlFor={`${idPrefix}-proxied`}
                  className="cursor-pointer font-normal"
                  info="Turn this on when a CDN or another proxy answers for this domain. Deplo then routes it without waiting for a DNS check."
                  docs="domains.dnsStates"
                >
                  Behind a proxy
                </FieldLabel>
                <Switch
                  id={`${idPrefix}-proxied`}
                  checked={state.proxied}
                  onCheckedChange={(c) => set("proxied", c)}
                />
              </div>
            </FieldGroup>

            {showWww && (
              <FieldGroup icon={Signpost} title="Redirect">
                <div className="space-y-2">
                  <FieldLabel
                    htmlFor={`${idPrefix}-www`}
                    info={
                      <>
                        Sends one of the two spellings of this site to the other
                        with a permanent redirect (301), so visitors and search
                        engines settle on a single address. Deplo adds the other
                        hostname as a domain of this app - with its own DNS
                        check and its own certificate, so it shows up in the
                        list and can be removed there.
                      </>
                    }
                    docs="domains.redirects"
                  >
                    www redirect
                  </FieldLabel>
                  <Select
                    value={state.www}
                    onValueChange={(v) => set("www", v as WwwRedirect)}
                  >
                    <SelectTrigger id={`${idPrefix}-www`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No redirect</SelectItem>
                      {/* Real hostnames, not "www"/"non-www": the option reads as the pair of rows the server writes. */}
                      <SelectItem value="toThis">
                        {counterpart} → {host}
                      </SelectItem>
                      <SelectItem value="toCounterpart">
                        {host} → {counterpart}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {state.www !== "none" && (
                    <p className="text-xs text-muted-foreground">
                      <span className="font-mono">{redirectingHost}</span> is
                      added as a domain of this app. Point its DNS at this
                      server too - it is checked automatically and appears in
                      the list with its own status.
                    </p>
                  )}
                </div>
              </FieldGroup>
            )}

            <FieldGroup icon={Route} title="Request routing">
              <div className="space-y-2">
                <FieldLabel
                  htmlFor={`${idPrefix}-path`}
                  info="Only requests under this path are routed to this target. Leave blank to route the whole host."
                  docs="domains.pathRouting"
                >
                  Internal path{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    (optional)
                  </span>
                </FieldLabel>
                <Input
                  id={`${idPrefix}-path`}
                  value={state.path}
                  onChange={(e) =>
                    // Emptying the path clears strip, so retyping a path never resurrects a toggle the user can't see.
                    onChange({
                      ...state,
                      path: e.target.value,
                      stripPath: e.target.value.trim()
                        ? state.stripPath
                        : false,
                    })
                  }
                  placeholder="/api"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-sm"
                />
              </div>

              {/* Strip is a property OF the path, so it exists only once one does. */}
              {hasPath && (
                <div className="space-y-2 rounded-md border border-border px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <FieldLabel
                      htmlFor={`${idPrefix}-strip`}
                      className="cursor-pointer font-normal"
                      info={
                        <>
                          Removes the internal path prefix from the request
                          before forwarding, so the app receives the path
                          without it (Traefik{" "}
                          <code className="font-mono">stripprefix</code>).
                        </>
                      }
                      docs="domains.pathRouting"
                    >
                      Strip path before forwarding
                    </FieldLabel>
                    <Switch
                      id={`${idPrefix}-strip`}
                      checked={state.stripPath}
                      onCheckedChange={(c) => set("stripPath", c)}
                    />
                  </div>
                  {pathError ? (
                    <p className="text-xs text-muted-foreground">{pathError}</p>
                  ) : (
                    <p className="text-xs break-all text-muted-foreground">
                      <span className="font-mono">{sampleIn}</span>
                      {" → "}
                      <span className="font-mono">{sampleOut}</span>
                    </p>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <FieldLabel
                  htmlFor={`${idPrefix}-middlewares`}
                  info={
                    <>
                      Comma-separated Traefik middlewares applied in order, e.g.{" "}
                      <code className="font-mono">
                        redirect-https, secure-headers@file, rate-limit,
                        auth@file, compress
                      </code>
                      . Each must already be defined on the proxy.
                    </>
                  }
                  docs="domains.overview"
                >
                  Middlewares{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    (optional)
                  </span>
                </FieldLabel>
                <Input
                  id={`${idPrefix}-middlewares`}
                  value={state.middlewares}
                  onChange={(e) => set("middlewares", e.target.value)}
                  // One short example: the five-item list overflowed the field.
                  placeholder="redirect-https"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-sm"
                />
              </div>
            </FieldGroup>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </>
  );
}
