"use client";

import * as React from "react";
import {
  Cloud,
  CornerDownRight,
  Lock,
  Route,
  Signpost,
} from "lucide-react";
import { Input } from "@/components/ui/input";
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

/** Entrypoint options — the two entrypoints the proxy's static config defines.
 * Labelled outcome-first (HTTPS / HTTP) with the entrypoint name kept, because
 * `websecure` is Traefik's vocabulary and not a consequence anyone can read.
 * The dropdown that renders these also offers "Automatic", which is how
 * `manualEntrypoint: false` is presented — see {@link ENTRYPOINT_AUTO}. */
export const ENTRYPOINTS: { value: DomainEntrypoint; label: string }[] = [
  { value: "websecure", label: "HTTPS — websecure (:443)" },
  { value: "web", label: "HTTP — web (:80)" },
];

/** The sentinel the entrypoint dropdown uses for "derive it from the
 * certificate". It is NOT a Traefik entrypoint — it is the ABSENCE of a manual
 * choice (`manualEntrypoint: false`). Deliberately kept out of `ENTRYPOINTS`
 * and out of `DomainConfigState`, so the stored union stays exactly the two
 * real entrypoints and `resolveDomainConfig` needs no change. */
const ENTRYPOINT_AUTO = "auto";

/** Certificate providers, including "None" (no TLS — plain HTTP on the web
 * entrypoint). The dropdown is the single TLS control: picking a provider is how
 * a domain opts INTO HTTPS (there is no separate checkbox). "None" is listed
 * first because it is the default for a brand-new domain — no certificate is
 * ever registered unless the user (or a template that expects HTTPS) asks, or
 * the DNS check finds the domain proxied through Cloudflare, which serves it
 * over HTTPS anyway and so selects "Cloudflare" on its own. */
export const CERT_PROVIDERS: { value: CertProvider; label: string }[] = [
  { value: "none", label: "None (no certificate)" },
  { value: "letsencrypt", label: "Let's Encrypt" },
  { value: "cloudflare", label: "Cloudflare" },
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

/** Seed config form state from a domain (or defaults for a brand-new domain).
 * `manualEntrypoint` seeds on whether the domain stored an explicit entrypoint
 * — an absent entrypoint means "auto" (the data layer derived it).
 *
 * A BRAND-NEW domain defaults to NO certificate (`none`): a cert is only ever
 * registered when the user opts in. An existing domain with an absent provider
 * keeps the legacy `letsencrypt` reading — that is how the deploy edge routes
 * pre-field rows, so the form must show what actually runs.
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

/** Validate + resolve config form state into the action payload, or return an
 * error string. On a compose stack (`isCompose`) the service and the service
 * port are BOTH required — a domain must name the compose service it routes to
 * and that service's container port. On a single-image project the port stays
 * optional (blank ⇒ the app's default port).
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
  /** The hostname the dialog currently holds. Given, a `www` pairing is dropped
   * when that hostname has no counterpart — otherwise typing `example.com`,
   * picking a pairing and then editing the host into `api.foo.example.com`
   * would post a pairing the server can only reject. */
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
    return { ok: false, error: "Container port is required" };
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
 * One-line description of what the advanced panel currently holds, shown on the
 * closed header so the section is legible without opening it.
 *
 * Every part is emitted ONLY when it diverges from a brand-new domain's
 * defaults, so a first-run Add dialog shows a bare "Advanced settings" instead
 * of greeting a newcomer with the words "No certificate". That fact still
 * reaches them — once, and louder — as the `http://` in the route preview
 * directly above.
 *
 * Middlewares are counted, never named: names overflow the row, and the count
 * answers the only question a closed header needs to answer.
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
  if (state.certProvider === "letsencrypt") parts.push("Let's Encrypt");
  else if (state.certProvider === "cloudflare")
    parts.push("Cloudflare certificate");
  // Mirrors `resolveDomainConfig`'s `manual` gate: with no certificate the
  // stored override is discarded, so naming it here would be a lie.
  if (state.certProvider !== "none" && state.manualEntrypoint) {
    parts.push(state.entrypoint === "web" ? "web (:80)" : "websecure (:443)");
  }
  const path = state.path.trim();
  if (path) parts.push(state.stripPath ? `${path} (stripped)` : path);
  const count = parseMiddlewares(state.middlewares).length;
  if (count) parts.push(count === 1 ? "1 middleware" : `${count} middlewares`);
  return parts.join(" · ");
}

/**
 * The derived answer to "what will this domain actually do" — the public URL on
 * top, where the request lands underneath. Read-only status, never a control:
 * every value on it is computed from fields the user can already see, so it
 * teaches the routing model instead of requiring anyone to know Traefik. It is
 * also what makes leaving the expert panel closed SAFE (scheme, target and
 * middleware count are legible without opening it), and it is the first place
 * deplo's certs-are-opt-in default is visible BEFORE a site fails to load over
 * https rather than after.
 *
 * Two fidelity rules, because a readout that can lie is worse than none:
 *  - the scheme mirrors `domainScheme()` (lib/deploy/domains.ts) EXACTLY — it
 *    keys off `certProvider` alone and deliberately ignores the entrypoint — so
 *    this line can never disagree with the URL the domain row shows once saved.
 *    A manually-overridden entrypoint is instead STATED on line 2, so the odd
 *    `letsencrypt` + `web` combination is legible rather than hidden;
 *  - the path only joins the URL once it is a path `resolveDomainConfig` would
 *    accept, so typing `api` never renders `https://app.example.comapi`.
 *
 * What the app RECEIVES after stripprefix is deliberately not claimed here — it
 * is shown exactly, as a literal rewrite, next to the switch that causes it.
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
  // The `www` pair, spelled out: the URL on top is always the hostname that
  // SERVES the app — which, under `toCounterpart`, is the counterpart rather than
  // the hostname being edited. Showing the edited host there would advertise a
  // URL that answers 301, which is exactly the confusion this pairing exists to
  // remove.
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
    port ? `port ${port}` : isCompose ? "port not set" : "the app’s default port",
  ].join(" · ");

  return (
    <div className="space-y-1 rounded-md bg-muted px-3 py-2">
      <p className="break-all font-mono text-xs text-foreground">
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
        <p className="flex items-start gap-1.5 break-all text-xs text-muted-foreground">
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

/** A titled group inside the advanced panel — the same fieldset/legend rhythm
 * `LimitGroup` uses in `components/apps/settings/resource-limits-form.tsx`, so
 * "advanced" looks the same everywhere in deplo. Single-column by design: at the
 * dialog's ~464px content width a two-column row clips the entrypoint option
 * labels exactly where they disambiguate. */
function AdvancedGroup({
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
      <legend className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3.5" />
        {title}
      </legend>
      <div className="space-y-4">{children}</div>
    </fieldset>
  );
}

/**
 * The shared per-domain routing fields, rendered identically in the Add and Edit
 * dialogs so the two never drift. Always-visible: the service selector (compose
 * stacks only), the service port, and a read-only preview of the route they
 * produce. Folded into an "Advanced settings" collapsible — whose closed header
 * summarises anything that diverges from the defaults — three grouped concerns:
 * HTTPS (certificate + entrypoint), the `www` redirect (which spelling of the
 * hostname serves the app, offered only when the hostname HAS a meaningful `www`
 * counterpart), and request routing (path, strip, the middleware chain).
 *
 * `idPrefix` namespaces the input ids (multiple instances can coexist on a page).
 * `services` lists a compose app's service names — when non-empty the service
 * selector is shown (empty ⇒ a single-image project, no service concept).
 */
export function DomainConfigFields({
  state,
  onChange,
  idPrefix,
  services = [],
  proxied = false,
  hostname,
}: {
  state: DomainConfigState;
  onChange: (next: DomainConfigState) => void;
  idPrefix: string;
  /** Compose service names for the service selector; empty ⇒ single-image. */
  services?: string[];
  /** Whether this domain's DNS check found it proxied through Cloudflare
   * (status `cloudflare`). Only the Edit dialog knows — an Add hasn't resolved
   * the host yet — and it exists solely to explain why the certificate provider
   * is already on Cloudflare, so the user reads it as a decision deplo made for
   * them rather than one they have to second-guess. */
  proxied?: boolean;
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

  // The `www` pair of the hostname currently typed. Null for a hostname that has
  // no meaningful one (an `api.` subdomain, a generated nip.io host) — the whole
  // group is then absent rather than offering a choice about a hostname nobody
  // would use. A path-routed domain is offered the group only while a pair
  // already exists, so an existing pair stays visible (and undoable) but a path
  // route can't start one: a redirect answers for a whole hostname.
  const host = (hostname ?? "").trim();
  const counterpart = wwwCounterpart(host);
  const showWww = counterpart != null && (!hasPath || state.www !== "none");
  const redirectingHost =
    state.www === "toCounterpart" ? host : (counterpart ?? "");

  return (
    <>
      {isCompose && (
        <div className="space-y-2">
          {/* The stack's containers, by their compose service name — the same
              names the Logs and Console pickers list for this app. Labelled
              "Container", not "App": the App is the whole stack, and calling one
              of its containers an App is what made the domains table look like
              it was naming the app rather than what actually serves the host. */}
          <FieldLabel
            htmlFor={`${idPrefix}-service`}
            info="Which container of this app's compose stack serves this domain."
          >
            Container
          </FieldLabel>
          <Select value={state.service} onValueChange={(v) => set("service", v)}>
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
              : "The container port this domain routes to. Defaults to the app's port."
          }
        >
          Container port
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
          className="font-mono text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
      </div>

      <RoutePreview hostname={hostname} state={state} isCompose={isCompose} />

      {/* Expert territory: collapsed on every open, in Add AND in Edit, so the
          two dialogs can never drift and the first-run path never meets it.
          Uncontrolled — Radix stamps `data-state` on the trigger, which carries
          `group`, so the summary steps aside in CSS. No React state, and no
          flash of the summary during the 200ms collapse animation. */}
      <Accordion type="single" collapsible className="border-t border-border">
        <AccordionItem value="advanced" className="border-none">
          <AccordionTrigger className="group gap-3 rounded-md py-3 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
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
            <AdvancedGroup icon={Lock} title="HTTPS">
              <div className="space-y-2">
                <FieldLabel
                  htmlFor={`${idPrefix}-cert`}
                  info="The source of this domain's TLS certificate. A domain proxied through Cloudflare is set to Cloudflare automatically, since Cloudflare already serves it over HTTPS. Choosing None serves the domain over plain HTTP with no TLS."
                >
                  Certificate
                </FieldLabel>
                <Select
                  value={state.certProvider}
                  onValueChange={(v) =>
                    // Written as ONE onChange, never two set() calls: a second
                    // set() would spread the stale `state` and drop the first
                    // key. Dropping to "none" also clears the manual entrypoint
                    // — resolveDomainConfig discards it there anyway, and
                    // keeping it alive under a locked control means a stale
                    // override silently reappears when a cert comes back.
                    onChange({
                      ...state,
                      certProvider: v as CertProvider,
                      manualEntrypoint:
                        v === "none" ? false : state.manualEntrypoint,
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
                {proxied && state.certProvider === "cloudflare" && (
                  // Not field help (that lives in the tooltip): this names a
                  // decision DEPLO made, said once, next to the dropdown that
                  // undoes it. It is the only conditional prose left in the
                  // panel, and it only ever renders in the Edit dialog.
                  <p className="flex items-start gap-2 text-xs text-muted-foreground">
                    <Cloud className="mt-px size-3.5 shrink-0" aria-hidden />
                    <span>
                      Selected automatically — this domain is proxied through
                      Cloudflare, which issues its certificate. Change it only to
                      give the origin a certificate of its own.
                    </span>
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <FieldLabel
                  htmlFor={`${idPrefix}-entrypoint`}
                  info={
                    <>
                      The proxy entrypoint this domain binds to —{" "}
                      <code className="font-mono">websecure</code> (:443) serves
                      HTTPS, <code className="font-mono">web</code> (:80) serves
                      plain HTTP. Leave it Automatic and deplo follows the
                      certificate. Pick <code className="font-mono">web</code>{" "}
                      only when something in front already terminates TLS, e.g.
                      Cloudflare in Flexible mode.
                    </>
                  }
                >
                  Entrypoint
                </FieldLabel>
                {/* One stable control replaces a disabled checkbox, a
                    conditionally-mounted Select and two muted paragraphs that
                    used to swap in the same slot. The default option IS the
                    derived outcome spelled out, so the disabled state displays
                    the truth instead of an ambiguous unchecked box. */}
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
            </AdvancedGroup>

            {showWww && (
              <AdvancedGroup icon={Signpost} title="Redirect">
                <div className="space-y-2">
                  <FieldLabel
                    htmlFor={`${idPrefix}-www`}
                    info={
                      <>
                        Sends one of the two spellings of this site to the other
                        with a permanent redirect (301), so visitors and search
                        engines settle on a single address. Deplo adds the other
                        hostname as a domain of this app — with its own DNS check
                        and its own certificate — so it shows up in the list and
                        can be removed there.
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
                    // Said once, next to the control that causes it: the one
                    // thing the user still has to do themselves is point the
                    // second hostname's DNS here. It is re-checked automatically,
                    // so this is a heads-up, not a chore list.
                    <p className="text-xs text-muted-foreground">
                      <span className="font-mono">{redirectingHost}</span> is
                      added as a domain of this app. Point its DNS at this server
                      too — it is checked automatically and appears in the list
                      with its own status.
                    </p>
                  )}
                </div>
              </AdvancedGroup>
            )}

            <AdvancedGroup icon={Route} title="Request routing">
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
                      stripPath: e.target.value.trim() ? state.stripPath : false,
                    })
                  }
                  placeholder="/api"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-sm"
                />
              </div>

              {/* Revealed by the user's own keystroke, never a disabled stub:
                  strip is a property OF the path, so it only exists once one
                  does. The bordered container makes that containment visible,
                  and the line under the switch is the literal rewrite — the one
                  thing that teaches Traefik stripprefix without naming it. */}
              {hasPath && (
                <div className="space-y-2 rounded-md border border-border px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <FieldLabel
                      htmlFor={`${idPrefix}-strip`}
                      className="cursor-pointer font-normal"
                      info={
                        <>
                          Removes the internal path prefix from the request
                          before forwarding, so the app receives the path without
                          it (Traefik{" "}
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
                    <p className="break-all text-xs text-muted-foreground">
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
            </AdvancedGroup>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </>
  );
}
