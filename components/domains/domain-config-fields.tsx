"use client";

import * as React from "react";
import { CornerDownRight, Lock, Route, Signpost } from "lucide-react";
import { Input } from "@/components/ui/input";
import { CloudflareIcon } from "@/components/shared/brand-icons";
import { CopyButton } from "@/components/shared/copy-button";
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
import type { CertProvider, DomainEntrypoint } from "@/lib/types";

/** The two entrypoints the proxy's static config defines, labelled
 * outcome-first because `websecure` is Traefik vocabulary, not a consequence. */
export const ENTRYPOINTS: { value: DomainEntrypoint; label: string }[] = [
  { value: "websecure", label: "HTTPS — websecure (:443)" },
  { value: "web", label: "HTTP — web (:80)" },
];

/** Sentinel for "derive the entrypoint from the certificate". NOT a Traefik
 * entrypoint: it is the ABSENCE of a manual choice, so it stays out of
 * `ENTRYPOINTS` and `DomainConfigState` and needs no data-layer change. */
const ENTRYPOINT_AUTO = "auto";

/** Certificate providers. The dropdown is the single TLS control - picking one
 * is how a domain opts INTO HTTPS. "None" is first because it is the default;
 * a Cloudflare-proxied host selects "Cloudflare" on its own. */
export const CERT_PROVIDERS: { value: CertProvider; label: string }[] = [
  { value: "none", label: "None (no certificate)" },
  { value: "letsencrypt", label: "Let's Encrypt" },
  { value: "cloudflare", label: "Cloudflare" },
  { value: "custom", label: "Installed on the server" },
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
  /** Which half of this hostname's `www` pair serves the app. Derived from the
   * app's rows by the caller (never a stored flag) and posted back on save. */
  www: WwwRedirect;
}

/** Seed form state from a domain, or defaults for a new one. A NEW domain gets
 * no certificate; an existing row with an absent provider keeps the legacy
 * `letsencrypt` reading, because that is what the deploy edge actually runs. */
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
  /** The `www` pairing the app's rows currently describe (`deriveWwwRedirect`).
   * Defaults to `none`, which is right for a brand-new domain. */
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
    www,
  };
}

/** Split the comma-separated middlewares text into a trimmed, non-empty array. */
export function parseMiddlewares(text: string): string[] {
  return text
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

/** Validate and resolve form state into the action payload, or an error string.
 * A compose stack requires both service and port. `entrypoint` is tri-state:
 * a value means manual, `null` means auto - and `none` always forces `null`. */
export function resolveDomainConfig(
  state: DomainConfigState,
  isCompose: boolean,
  /** The hostname the dialog holds. A `www` pairing is dropped when the hostname
   * has no counterpart, or editing the host would post a pairing the server
   * can only reject. */
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
    // Sent as-is, including when unchanged: the pairing is derived from the app's
    // rows, so posting the current value is a no-op server-side and posting a
    // different one is the whole edit.
    www:
      hostname !== undefined && wwwCounterpart(hostname) == null
        ? "none"
        : state.www,
  };
}

/**
 * What the advanced panel holds, for the closed header. Only parts that DIVERGE
 * from a new domain's defaults are emitted, so a first-run dialog does not greet
 * a newcomer with "No certificate". Middlewares are counted, never named.
 */
export function advancedSummary(
  state: DomainConfigState,
  /** The hostname the dialog currently holds, so the summary can name the
   * hostname a `www` pairing redirects. Absent ⇒ the pairing is summarised
   * generically. */
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
  const path = state.path.trim();
  if (path) parts.push(state.stripPath ? `${path} (stripped)` : path);
  const count = parseMiddlewares(state.middlewares).length;
  if (count) parts.push(count === 1 ? "1 middleware" : `${count} middlewares`);
  return parts.join(" · ");
}

/**
 * The derived answer to "what will this domain actually do" — the public URL on
 * top, where the request lands underneath.
 */
function RoutePreview({
  hostname,
  state,
  isCompose,
}: {
  hostname?: string;
  state: DomainConfigState;
  isCompose: boolean;
}) {
  const host = hostname?.trim() ?? "";
  const scheme = state.certProvider === "none" ? "http" : "https";
  const path = state.path.trim();
  const urlPath = path.startsWith("/") && !path.includes("`") ? path : "";
  const port = state.port.trim();
  const service = state.service.trim();
  const manualEntrypoint =
    state.manualEntrypoint && state.certProvider !== "none";
  const middlewares = parseMiddlewares(state.middlewares).length;
  // The `www` pair, spelled out: the URL on top is always the hostname that SERVES
  // the app — which, under `toCounterpart`, is the counterpart rather than the
  // hostname being edited.
  const counterpart = wwwCounterpart(host);
  const paired = state.www !== "none" && counterpart != null;
  const servedHost =
    paired && state.www === "toCounterpart" ? counterpart! : host;
  const redirectingHost = !paired
    ? ""
    : state.www === "toCounterpart"
      ? host
      : counterpart!;

  const target = [
    // Named only once chosen — "the selected service" while nothing is selected
    // would be a sentence about a thing that isn't there.
    ...(service ? [service] : []),
    port
      ? `port ${port}`
      : isCompose
        ? "port not set"
        : "the app’s default port",
  ].join(" · ");

  return (
    <div className="space-y-1 rounded-md bg-muted px-3 py-2">
      <p className="font-mono text-xs break-all text-foreground">
        {scheme}://
        {servedHost || (
          <span className="text-muted-foreground">your-domain.com</span>
        )}
        {urlPath}
      </p>
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <CornerDownRight className="mt-px size-3 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">
          Forwards to {target}
          {manualEntrypoint &&
            ` on ${state.entrypoint === "web" ? "web (:80)" : "websecure (:443)"}`}
          {middlewares > 0 &&
            `, through ${middlewares} middleware${middlewares === 1 ? "" : "s"}`}
        </span>
      </p>
      {paired && (
        <p className="flex items-start gap-1.5 text-xs break-all text-muted-foreground">
          <Signpost className="mt-px size-3 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">
            <span className="font-mono">{redirectingHost}</span> answers a
            permanent redirect (301) to{" "}
            <span className="font-mono">
              {scheme}://{servedHost}
            </span>
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * A titled group of fields - the same fieldset/legend rhythm
 * `LimitGroup` uses in `components/apps/settings/resource-limits-form.tsx`.
 */
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

/**
 * The shared per-domain routing fields, rendered identically in the Add and Edit
 * dialogs so the two never drift.
 */
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
  /** Compose service names for the service selector; empty ⇒ single-image. */
  services?: string[];
  /**
   * Whether this domain's DNS check found it proxied through Cloudflare (status
   * `cloudflare`).
   */
  proxied?: boolean;
  /** The public IPv4 of the server this app runs on, so the Cloudflare note can
   * name the address the proxied record must point at. */
  serverIp?: string;
  /** The hostname currently typed in the dialog's Domain field, so the route
   * preview shows the real URL as it is typed. Purely presentational — it never
   * enters `DomainConfigState` nor the mutation payload. */
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
  // The same two checks `resolveDomainConfig` runs, with its own error strings:
  // the rewrite preview must never illustrate a config that will be rejected on
  // submit, and saying why beats showing nothing.
  const pathError = !hasPath
    ? null
    : !rawPath.startsWith("/")
      ? "Internal path must start with /"
      : rawPath.includes("`")
        ? "Internal path can't contain a backtick"
        : null;
  const sampleIn = `${rawPath.replace(/\/+$/, "")}/users`;
  const sampleOut = state.stripPath ? "/users" : sampleIn;

  // "auto" is the displayed value whenever no manual choice applies. With no
  // certificate `resolveDomainConfig` ignores the manual flag, so the control
  // shows (and locks to) the truth rather than a stale override.
  const entrypointValue =
    noCert || !state.manualEntrypoint ? ENTRYPOINT_AUTO : state.entrypoint;
  const summary = advancedSummary(state, hostname);

  // The `www` pair of the hostname currently typed. Null for a hostname that has no
  // meaningful one (an `api.` subdomain, a generated nip.io host) — the whole group
  // is then absent rather than offering a choice about a hostname nobody would use.
  const host = (hostname ?? "").trim();
  const counterpart = wwwCounterpart(host);
  const showWww = counterpart != null && (!hasPath || state.www !== "none");
  const redirectingHost =
    state.www === "toCounterpart" ? host : (counterpart ?? "");

  return (
    <>
      {proxied && (
        <div className="flex items-start gap-3 rounded-md border border-[#f38020]/30 bg-[#f38020]/10 px-3 py-2.5">
          <CloudflareIcon className="mt-0.5 size-5 shrink-0 text-[#f38020]" />
          <div className="min-w-0">
            <p className="text-sm font-medium">Cloudflare detected</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Cloudflare serves this domain and its HTTPS, so there is nothing
              else to set up here. Just keep its A record pointed at{" "}
              {serverIp ? (
                <span className="inline-flex items-baseline gap-1">
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
                    {serverIp}
                  </code>
                  <CopyButton value={serverIp} className="size-5" />
                </span>
              ) : (
                "this app's server"
              )}{" "}
              with the proxy on.
            </p>
          </div>
        </div>
      )}
      {isCompose && (
        <div className="space-y-2">
          {/**
           * The stack's containers, by their compose service name — the same names the Logs
           * and Console pickers list for this app.
           */}
          <FieldLabel
            htmlFor={`${idPrefix}-service`}
            info="Which container of this app's compose stack serves this domain."
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
          // Spinner-hiding lifted verbatim from `LimitField` — native arrows
          // collide with a mono value and nobody steps a port by one.
          className="[appearance:textfield] font-mono text-sm [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
      </div>

      <FieldGroup icon={Lock} title="HTTPS">
        <div className="space-y-2">
          <FieldLabel
            htmlFor={`${idPrefix}-cert`}
            info="The source of this domain's TLS certificate. A domain proxied through Cloudflare is set to Cloudflare automatically, since Cloudflare already serves it over HTTPS. Pick Installed on the server when you added the certificate yourself under Settings, Servers. Choosing None serves the domain over plain HTTP with no TLS."
          >
            Certificate
          </FieldLabel>
          <Select
            value={state.certProvider}
            onValueChange={(v) =>
              // Written as ONE onChange, never two set() calls: a second set() would spread the
              // stale `state` and drop the first key.
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
                The proxy entrypoint this domain binds to —{" "}
                <code className="font-mono">websecure</code> (:443) serves
                HTTPS, <code className="font-mono">web</code> (:80) serves plain
                HTTP. Leave it Automatic and deplo follows the certificate. Pick{" "}
                <code className="font-mono">web</code> only when something in
                front already terminates TLS, e.g. Cloudflare in Flexible mode.
              </>
            }
          >
            Entrypoint
          </FieldLabel>
          {/**
           * One stable control replaces a disabled checkbox, a conditionally-mounted Select
           * and two muted paragraphs that used to swap in the same slot.
           */}
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
                  ? "Automatic — HTTP on web (:80)"
                  : "Automatic — HTTPS on websecure (:443)"}
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

      <RoutePreview hostname={hostname} state={state} isCompose={isCompose} />

      {/**
       * Expert territory: collapsed on every open, in Add AND in Edit, so the two dialogs
       * can never drift and the first-run path never meets it.
       */}
      <Accordion type="single" collapsible className="border-t border-border">
        <AccordionItem value="advanced" className="border-none">
          <AccordionTrigger className="group gap-3 rounded-md py-3 hover:no-underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <span className="flex min-w-0 flex-1 items-center gap-3">
              {/* shrink-0 so the title never wraps to two lines while the
                  summary (which owns `truncate`) is what gives way. */}
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
                        hostname as a domain of this app — with its own DNS
                        check and its own certificate — so it shows up in the
                        list and can be removed there.
                      </>
                    }
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
                      {/* Both directions, spelled with the real hostnames rather
                          than the words "www"/"non-www": the option a user reads
                          is exactly the pair of rows the server will write. */}
                      <SelectItem value="toThis">
                        {counterpart} → {host}
                      </SelectItem>
                      <SelectItem value="toCounterpart">
                        {host} → {counterpart}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {state.www !== "none" && (
                    // Said once, next to the control that causes it: the one thing the user still has
                    // to do themselves is point the second hostname's DNS here.
                    <p className="text-xs text-muted-foreground">
                      <span className="font-mono">{redirectingHost}</span> is
                      added as a domain of this app. Point its DNS at this
                      server too — it is checked automatically and appears in
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
                    // Emptying the path also clears strip, so retyping a path
                    // never resurrects a toggle the user can't currently see.
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

              {/**
               * Revealed by the user's own keystroke, never a disabled stub: strip is a property
               * OF the path, so it only exists once one does.
               */}
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
                  // One short, provider-neutral example: the five-item list
                  // overflowed the field, and it wraps happily in the tooltip.
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
