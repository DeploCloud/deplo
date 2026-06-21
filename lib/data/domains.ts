import "server-only";

import { resolve4, resolveCname } from "node:dns/promises";
import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import yaml from "js-yaml";
import {
  instanceHost,
  sslipDomain,
  isIpv4,
  isLoopbackIp,
  sslipEmbeddedIp,
  rehostSslip,
  domainTlsConfig,
} from "../deploy/domains";
import { usesComposeStack } from "../utils";
import { portFor } from "../deploy/ports";
import type { CertProvider, Domain, DomainEntrypoint } from "../types";

const DOMAIN_RE = /^(?!:\/\/)([a-zA-Z0-9-_]+\.)+[a-zA-Z]{2,}$/;

/** A per-domain port override applies to every project: on a single-image
 * project it picks the container port this host routes to; on a compose stack it
 * overrides the chosen `service`'s compose-declared port (blank ⇒ the service's
 * own port). The deploy path threads it through for both. */

/** A `service` is the compose analogue of the single-image `port` override: it
 * picks which compose service a hostname routes to (the port defaults to that
 * service's compose definition, or the per-domain `port` when set). It is
 * meaningless on a single-image project, which has exactly one container — reject
 * it there rather than persist an inert value the UI would falsely report as
 * applied. */
const SERVICE_UNSUPPORTED =
  "Routing to a named service is only available for compose stacks — single-image projects use the service port field.";

/**
 * Generated sslip.io hostname for a project's slug on a given server IP. Pure
 * helper used by both the deploy engine and project creation so the domain
 * baked into a stack always matches the one shown in the Domains section.
 */
export function autoDomainName(slug: string, ip: string): string {
  return sslipDomain(slug, ip);
}

/**
 * Ensure a project has a registered primary domain and return its hostname.
 *
 * Runs without an authenticated user (the deploy pipeline is fire-and-forget),
 * so it talks to the store directly. If a `preferred` name is given (e.g. the
 * domain a template baked into its env), it is used as-is; otherwise the
 * sslip.io hostname for the slug is generated. The first domain on a project is
 * marked primary. Idempotent: returns the existing primary if one exists.
 */
export function ensureAutoDomain(
  projectId: string,
  opts: {
    slug: string;
    ip: string;
    preferred?: string;
    /** The container port this host routes to: the compose default expose port,
     * or the single-image build.port. Always written so no auto domain is ever
     * portless. */
    defaultPort: number;
    /** Compose default expose service (null/absent for single-image). Written so
     * a compose auto domain always names the service it routes to. */
    defaultService?: string | null;
  },
): string {
  const existing = read().domains.filter((d) => d.projectId === projectId);
  const primary = existing.find((d) => d.primary) ?? existing[0];
  if (primary) {
    // Self-heal an auto-generated sslip.io domain that still encodes a stale or
    // loopback IP (e.g. created before DEPLO_SERVER_IP was set), so a corrected
    // IP takes effect on the next deploy without the operator deleting the
    // domain by hand. Only auto domains are touched, and never rewritten toward
    // a loopback address.
    if (primary.source === "auto" && isIpv4(opts.ip) && !isLoopbackIp(opts.ip)) {
      const embedded = sslipEmbeddedIp(primary.name);
      if (embedded && embedded !== opts.ip) {
        const fixed = rehostSslip(primary.name, opts.ip);
        if (fixed !== primary.name) {
          mutate((d) => {
            const x = d.domains.find((y) => y.id === primary.id);
            if (x) x.name = fixed;
          });
          return fixed;
        }
      }
    }
    return primary.name;
  }

  const name = (opts.preferred?.trim() || autoDomainName(opts.slug, opts.ip))
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const domain: Domain = {
    id: newId("dom"),
    projectId,
    name,
    status: "valid",
    primary: true,
    redirectTo: null,
    ssl: true,
    source: "auto",
    // Always born complete: the resolved container port (and, on a compose
    // stack, the service it routes to) so no auto domain is ever portless or
    // serviceless. These equal the project's default expose/build port, so the
    // compose renderer treats them as the default route (byte-identical YAML).
    port: opts.defaultPort,
    ...(opts.defaultService ? { service: opts.defaultService } : {}),
    createdAt: nowIso(),
  };
  mutate((d) => d.domains.push(domain));
  return name;
}

/**
 * Ensure a secondary (non-primary) domain is registered for a project, e.g. the
 * extra hostnames a multi-domain template exposes (garage-with-ui's web UI).
 * Runs without an authenticated user (called from the fire-and-forget deploy).
 * Idempotent: a domain with the same name is left as-is.
 */
export function ensureExtraDomain(
  projectId: string,
  rawName: string,
  route: { port: number; service?: string | null },
): void {
  const name = rawName
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!name || !DOMAIN_RE.test(name)) return;
  const exists = read().domains.some(
    (d) => d.projectId === projectId && d.name === name,
  );
  if (exists) return;
  const domain: Domain = {
    id: newId("dom"),
    projectId,
    name,
    status: "valid",
    primary: false,
    redirectTo: null,
    ssl: true,
    source: "auto",
    // The extra host comes from a compose `exposes` entry that carries its own
    // service + port; store both so the row is never serviceless/portless. They
    // equal that host's default expose, so the renderer keeps it byte-identical.
    port: route.port,
    ...(route.service ? { service: route.service } : {}),
    createdAt: nowIso(),
  };
  mutate((d) => d.domains.push(domain));
}

export async function listDomains(
  projectId?: string,
): Promise<(Domain & { projectName: string; projectSlug: string })[]> {
  const teamId = await requireActiveTeamId();
  const d = read();
  // Only the active team's projects own routable domains; a projectId filter
  // that points outside the team resolves to no project and so yields nothing.
  const teamProjects = new Map(
    d.projects.filter((p) => p.teamId === teamId).map((p) => [p.id, p]),
  );
  return d.domains
    .filter((x) => (!projectId || x.projectId === projectId) && teamProjects.has(x.projectId))
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .map((x) => {
      const p = teamProjects.get(x.projectId);
      return { ...x, projectName: p?.name ?? "", projectSlug: p?.slug ?? "" };
    });
}

/** The per-domain routing config a user sets when adding a domain — the same
 * knobs the Edit dialog exposes (port, entrypoint, cert provider, middlewares).
 * All optional; omitted fields fall back to the long-standing HTTPS defaults. */
export interface DomainConfig {
  port?: number | null;
  entrypoint?: DomainEntrypoint;
  certProvider?: CertProvider;
  middlewares?: string[];
  /** Path prefix this host routes (Traefik PathPrefix). See {@link normalizePath}. */
  pathPrefix?: string;
  /** Strip {@link pathPrefix} before forwarding (Traefik stripprefix middleware). */
  stripPrefix?: boolean;
  /** Compose-stack only: which compose service this host targets. */
  service?: string;
}

export async function addDomain(
  projectId: string,
  name: string,
  config: DomainConfig = {},
): Promise<Domain> {
  const { membership } = await requireCapability("manage_domains");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!DOMAIN_RE.test(clean)) throw new Error("Enter a valid domain name");
  const project = read().projects.find(
    (p) => p.id === projectId && p.teamId === membership.teamId,
  );
  if (!project) throw new Error("Project not found");
  const isCompose = usesComposeStack(project);

  // A path lets several rows share one hostname (e.g. `app.com` for `/` and
  // `app.com` for `/api`), so uniqueness is on (host + path), not host alone —
  // the long-standing single-row case is `pathPrefix === ""` on both sides.
  const pathPrefix = normalizePath(config.pathPrefix);
  if (read().domains.some((x) => x.name === clean && (x.pathPrefix ?? "") === pathPrefix))
    throw new Error(
      pathPrefix ? "Domain + path already added" : "Domain already added",
    );

  const service = resolveService(config.service, project, isCompose);
  // On a compose stack the port is required (the chosen service's container
  // port); single-image keeps it optional (blank ⇒ the project's default port).
  if (isCompose && config.port == null)
    throw new Error("Service port is required");
  const middlewares = normalizeMiddlewares(config.middlewares);
  // Strip is only meaningful with a path (a stripprefix middleware needs a
  // prefix to strip), so drop it otherwise — the router grammar does the same.
  const stripPrefix = Boolean(pathPrefix && config.stripPrefix);
  const domain: Domain = {
    id: newId("dom"),
    projectId,
    name: clean,
    status: "pending",
    primary:
      read().domains.filter((x) => x.projectId === projectId).length === 0,
    redirectTo: null,
    ssl: false,
    // Always store a concrete port so no domain is ever portless. Compose
    // already required one above; single-image falls back to the project's
    // production port (build.port) — byte-identical to leaving it null, since
    // the router resolves an absent port to build.port anyway.
    port: config.port ?? portFor(project, "production"),
    // Entrypoint persists only when the user picked it explicitly (manual mode).
    // Absent ⇒ derived at deploy time by domainTlsConfig (websecure for TLS, web
    // for the `none` provider). Storing it only when given keeps the auto/manual
    // distinction round-trippable and a default domain byte-identical.
    ...(config.entrypoint ? { entrypoint: config.entrypoint } : {}),
    certProvider: config.certProvider ?? "letsencrypt",
    ...(middlewares.length ? { middlewares } : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
    ...(stripPrefix ? { stripPrefix } : {}),
    ...(service ? { service } : {}),
    createdAt: nowIso(),
  };
  mutate((d) => d.domains.push(domain));
  recordActivity("domain", `Added domain ${clean}`, user.name, projectId);
  return domain;
}

/** Normalise a router path prefix to its canonical stored form: trim, strip a
 * pasted scheme/host, drop backticks (it is interpolated into a Traefik backtick
 * literal), force a single leading slash, drop a trailing slash. Empty or a bare
 * `/` ⇒ `""` (no path). One choke point so the data layer and the router grammar
 * (`normalizeRulePath`) agree on what a path looks like. */
export function normalizePath(input?: string | null): string {
  let p = (input ?? "").trim();
  if (!p) return "";
  // Strip a pasted URL down to its path (`https://host/api` → `/api`).
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      /* not a URL — fall through and treat it as a raw path */
    }
  }
  p = p.replace(/`/g, "");
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/+$/, "");
  return p; // "" for a bare "/" (the trailing-slash strip leaves "")
}

/** The service names declared in a project's compose file, or [] when there is
 * no parseable compose (single-image projects, malformed YAML). Used to validate
 * a domain's chosen `service` against the stack it routes to. */
export function composeServiceNames(compose?: string | null): string[] {
  if (!compose || !compose.trim()) return [];
  try {
    const doc = yaml.load(compose) as { services?: Record<string, unknown> } | undefined;
    const svc = doc?.services;
    return svc && typeof svc === "object" && !Array.isArray(svc) ? Object.keys(svc) : [];
  } catch {
    return [];
  }
}

/** Validate + normalise a domain's chosen compose `service`: REQUIRED on a
 * compose stack (a domain must name the service it routes to — there is no
 * "default service"), must name a real service in that stack, and is rejected
 * (→ error) on single-image projects. Single-image returns null (no service).
 * Rejecting an unknown/absent service keeps an inert value from being persisted. */
function resolveService(
  raw: string | undefined,
  project: { compose: string | null },
  isCompose: boolean,
): string | null {
  const service = raw?.trim();
  if (!isCompose) {
    if (service) throw new Error(SERVICE_UNSUPPORTED);
    return null;
  }
  if (!service) throw new Error("Select the service this domain routes to");
  const names = composeServiceNames(project.compose);
  if (!names.includes(service))
    throw new Error(`Service "${service}" is not defined in the compose file`);
  return service;
}

/** Trim, drop blanks, and de-duplicate a middleware list (order-preserving).
 * One choke point so the comma-split from the UI is cleaned identically on the
 * add and update paths before it reaches the router grammar. */
export function normalizeMiddlewares(input?: string[] | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input ?? []) {
    const m = raw.trim();
    if (m && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

/** A full-domain edit: every field the user can change from the Edit dialog.
 * Each is optional so the action only sends what changed; `port: null` clears
 * the override (revert to the project default). */
export interface DomainPatch {
  name?: string;
  port?: number | null;
  certProvider?: CertProvider;
  middlewares?: string[];
  /** Path prefix this host routes; "" clears it. */
  pathPrefix?: string;
  /** Strip the path prefix before forwarding; ignored when there is no path. */
  stripPrefix?: boolean;
  /** Compose-stack only: which compose service this host targets; "" clears it. */
  service?: string;
  /**
   * The entrypoint, expressed as a tri-state because the Edit dialog always
   * sends the full routing config:
   *   - a concrete value      → manual mode: store it
   *   - `null`                → auto mode: delete it (derived at deploy time)
   *   - absent (`undefined`)  → leave whatever is stored unchanged
   * This lets the "set entrypoint manually" checkbox round-trip (auto persists
   * as a genuinely-absent field) without colliding with "field not in this edit".
   */
  entrypoint?: DomainEntrypoint | null;
}

/**
 * Apply a full edit to a domain — name, port override, entrypoint, cert
 * provider, middleware chain, path prefix (+strip), and compose service in one
 * mutation — and return the projectId so the caller can re-apply routing (the
 * new Traefik labels only reach the running container once its stack file is
 * re-rendered). Renaming re-runs the same regex + normalisation as {@link
 * addDomain}; uniqueness is on (host + path) so one hostname can carry several
 * path-routed rows. A renamed `custom` domain drops back to `pending`/no-SSL
 * because the new host's DNS hasn't been verified against this server.
 * Per-domain ports stay unsupported on compose stacks (they pick a `service`
 * instead). Each optional routing field uses delete-when-empty so a cleared
 * value re-renders byte-identically to a domain that never had it.
 */
export async function updateDomain(
  id: string,
  patch: DomainPatch,
): Promise<string> {
  const { membership } = await requireCapability("manage_domains");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const current = read().domains.find((x) => x.id === id);
  if (!current) throw new Error("Not found");
  const project = read().projects.find(
    (p) => p.id === current.projectId && p.teamId === membership.teamId,
  );
  if (!project) throw new Error("Project not found");

  const isCompose = usesComposeStack(project);

  // The next name (after an optional rename) and the next path together form the
  // uniqueness key — several rows may share a host on different paths.
  let nextName = current.name;
  if (patch.name !== undefined) {
    nextName = patch.name
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
    if (!DOMAIN_RE.test(nextName)) throw new Error("Enter a valid domain name");
  }
  const renamed = nextName !== current.name;
  // Resolve + validate the new path (when the edit touches it) and the service
  // BEFORE mutating, so a bad value rejects without a partial write.
  const nextPath =
    patch.pathPrefix !== undefined
      ? normalizePath(patch.pathPrefix)
      : current.pathPrefix ?? "";
  const nextService =
    patch.service !== undefined
      ? resolveService(patch.service, project, isCompose)
      : current.service ?? null;
  // On a compose stack the resulting domain must name a service and a port; the
  // Edit dialog always sends both, this guards a direct/legacy call.
  const nextPort = patch.port !== undefined ? patch.port : current.port ?? null;
  if (isCompose) {
    if (!nextService) throw new Error("Select the service this domain routes to");
    if (nextPort == null) throw new Error("Service port is required");
  }
  // Uniqueness on (host + path) against every OTHER domain.
  if (
    read().domains.some(
      (x) => x.id !== id && x.name === nextName && (x.pathPrefix ?? "") === nextPath,
    )
  )
    throw new Error(
      nextPath ? "Domain + path already added" : "Domain already added",
    );

  const dom = mutate((d) => {
    const x = d.domains.find((y) => y.id === id);
    if (!x) throw new Error("Not found");
    x.name = nextName;
    if (patch.port !== undefined) x.port = patch.port;
    // Entrypoint tri-state: a value stores manual mode, `null` clears to auto
    // (so domainTlsConfig derives it), `undefined` leaves it unchanged.
    if (patch.entrypoint !== undefined) {
      if (patch.entrypoint === null) delete x.entrypoint;
      else x.entrypoint = patch.entrypoint;
    }
    if (patch.certProvider !== undefined) x.certProvider = patch.certProvider;
    if (patch.middlewares !== undefined) {
      const mws = normalizeMiddlewares(patch.middlewares);
      // Drop the field entirely when the chain is empty, so a cleared list
      // re-renders byte-identically to a domain that never had middlewares.
      if (mws.length) x.middlewares = mws;
      else delete x.middlewares;
    }
    // Path / strip / service all use delete-when-empty so a cleared value
    // serialises byte-identically to a domain that never had one.
    if (patch.pathPrefix !== undefined) {
      if (nextPath) x.pathPrefix = nextPath;
      else delete x.pathPrefix;
    }
    // Strip needs a path; recompute against the path now in effect (whether this
    // edit changed it or not) so clearing the path also drops a stale strip.
    if (patch.stripPrefix !== undefined || patch.pathPrefix !== undefined) {
      const effPath = patch.pathPrefix !== undefined ? nextPath : x.pathPrefix ?? "";
      const strip = Boolean(effPath) && (patch.stripPrefix ?? x.stripPrefix ?? false);
      if (strip) x.stripPrefix = true;
      else delete x.stripPrefix;
    }
    if (patch.service !== undefined) {
      if (nextService) x.service = nextService;
      else delete x.service;
    }
    // A renamed custom domain points at a new host whose DNS we haven't checked:
    // drop it back to pending so it stops routing until re-verified. An auto
    // sslip.io host always resolves, so it stays valid. (verifyDomain re-issues
    // the cert; routableRoutes only serves `valid` hosts.)
    if (renamed && x.source !== "auto") {
      x.status = "pending";
      x.ssl = false;
    }
    return x;
  });
  recordActivity(
    "domain",
    renamed
      ? `Updated domain ${current.name} → ${dom.name}`
      : `Updated domain ${dom.name}`,
    user.name,
    dom.projectId,
  );
  return dom.projectId;
}

/**
 * Verify a domain by checking real DNS: the name must resolve to this server's
 * IP (or have a CNAME). Traefik then issues the Let's Encrypt cert on the next
 * request, so `ssl` is set once DNS is correct.
 */
export async function verifyDomain(id: string): Promise<Domain> {
  const { membership } = await requireCapability("manage_domains");
  const dom = read().domains.find((x) => x.id === id);
  if (!dom) throw new Error("Not found");
  const project = read().projects.find(
    (p) => p.id === dom.projectId && p.teamId === membership.teamId,
  );
  if (!project) throw new Error("Project not found");

  const target = instanceHost();
  let ok = false;
  try {
    const ips = await resolve4(dom.name);
    ok = ips.includes(target) || ips.length > 0;
  } catch {
    try {
      const cnames = await resolveCname(dom.name);
      ok = cnames.length > 0;
    } catch {
      ok = false;
    }
  }

  return mutate((d) => {
    const x = d.domains.find((y) => y.id === id);
    if (!x) throw new Error("Not found");
    x.status = ok ? "valid" : "misconfigured";
    x.ssl = ok;
    return x;
  });
}

/**
 * Valid, routable hostnames for a project, primary first.
 *
 * Only `valid` domains are returned: a pending/misconfigured host has no
 * working DNS, so routing to it would make Traefik fail HTTP-01 issuance and
 * (because all hosts share one cert order) could jeopardise the cert for the
 * domains that *do* work. The primary is sorted first so it stays the canonical
 * host. Store-direct (no auth) so the deploy engine can call it like
 * [[ensure-auto-domain]] does. Empty when the project has no valid domain.
 */
export function routableDomains(projectId: string): string[] {
  return routableRoutes(projectId).map((d) => d.name);
}

/** A routable hostname plus everything its Traefik router needs: the per-domain
 * port override (null ⇒ project default) and the resolved TLS triplet
 * (entrypoint, whether TLS is on, and the cert resolver). The triplet is derived
 * from the domain's `entrypoint`/`certProvider` via {@link domainTlsConfig}, so
 * callers hand these straight to `traefikRouterLabels` without re-deriving. Same
 * filtering/ordering as {@link routableDomains}. */
export interface RoutableDomain {
  name: string;
  port: number | null;
  /** Entrypoint the router binds to (`websecure` by default, `web` for HTTP). */
  entrypoint: string;
  /** Whether the router terminates TLS (`false` for the `none` provider). */
  tls: boolean;
  /** Resolved ACME resolver name (empty when `tls` is false). */
  certResolver: string;
  /** Traefik middlewares applied to this host's router, in order (empty ⇒ none). */
  middlewares: string[];
  /** Path prefix this host's router matches (empty ⇒ a `Host()`-only rule). */
  pathPrefix: string;
  /** Strip `pathPrefix` before forwarding (false ⇒ forward unchanged). */
  stripPrefix: boolean;
  /** Compose-stack only: the compose service this host targets (null ⇒ the
   * stack's default exposed service). Ignored by the single-image path. */
  service: string | null;
}

/**
 * A {@link RoutableDomain} for a bare hostname carrying no per-domain config:
 * the project default port and the long-standing HTTPS/letsencrypt TLS triplet,
 * no path, no strip, the default service. Used for synthetic routes that aren't
 * backed by a stored `Domain` row — a preview's ephemeral host, or the primary
 * fallback when a brand-new project has no `valid` domain yet — so every route
 * handed to the router grammar has the full shape.
 */
export function defaultRoute(name: string): RoutableDomain {
  return {
    name,
    port: null,
    ...domainTlsConfig({}),
    middlewares: [],
    pathPrefix: "",
    stripPrefix: false,
    service: null,
  };
}

/**
 * Valid, routable hostnames for a project (primary first), each with its port
 * override and resolved TLS triplet. The per-domain port lets one container
 * expose different services on different hostnames; the TLS triplet lets each
 * host pick its entrypoint and certificate provider. A `null` port means "use
 * the project's default port". Same `valid`-only filtering rationale as
 * {@link routableDomains}.
 */
export function routableRoutes(projectId: string): RoutableDomain[] {
  return read()
    .domains.filter((d) => d.projectId === projectId && d.status === "valid")
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .map((d) => ({
      name: d.name,
      port: d.port ?? null,
      ...domainTlsConfig(d),
      middlewares: d.middlewares ?? [],
      pathPrefix: d.pathPrefix ?? "",
      stripPrefix: Boolean(d.stripPrefix),
      service: d.service ?? null,
    }));
}

/**
 * Flip which domain is primary for its project. Returns the affected projectId
 * so the caller can re-apply routing (the running container's Traefik labels
 * are baked at deploy time, so the switch only takes effect once the stack is
 * re-rendered and `docker compose up -d` recreates it). `productionUrl` is NOT
 * advanced here — the caller updates it only after routing is confirmed, so the
 * dashboard never points at a host the container isn't serving yet.
 */
export async function setPrimaryDomain(id: string): Promise<string> {
  const { membership } = await requireCapability("manage_domains");
  const dom = read().domains.find((x) => x.id === id);
  if (!dom) throw new Error("Not found");
  const project = read().projects.find(
    (p) => p.id === dom.projectId && p.teamId === membership.teamId,
  );
  if (!project) throw new Error("Project not found");
  return mutate((d) => {
    const target = d.domains.find((x) => x.id === id);
    if (!target) throw new Error("Not found");
    for (const x of d.domains)
      if (x.projectId === target.projectId) x.primary = x.id === id;
    return target.projectId;
  });
}

/**
 * Point a project's canonical `productionUrl` at its current primary domain.
 * The primary domain IS the canonical URL the moment the user picks it, so the
 * domain actions call this on every successful change regardless of whether the
 * running container has been rerouted yet — the title-bar URL must reflect the
 * chosen primary immediately, not lag a deploy behind. Falls back to the first
 * remaining domain when none is flagged primary (e.g. the primary was removed),
 * and clears the URL when the last domain is gone.
 */
export function syncProductionUrl(projectId: string): void {
  mutate((d) => {
    const p = d.projects.find((x) => x.id === projectId);
    if (!p) return;
    const domains = d.domains.filter((x) => x.projectId === projectId);
    const primary = domains.find((x) => x.primary) ?? domains[0];
    p.productionUrl = primary ? `https://${primary.name}` : null;
    p.updatedAt = nowIso();
  });
}

export async function removeDomain(id: string): Promise<string> {
  const { membership } = await requireCapability("manage_domains");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const dom = read().domains.find((x) => x.id === id);
  if (!dom) throw new Error("Not found");
  const project = read().projects.find(
    (p) => p.id === dom.projectId && p.teamId === membership.teamId,
  );
  if (!project) throw new Error("Project not found");
  mutate((d) => {
    d.domains = d.domains.filter((x) => x.id !== id);
  });
  recordActivity(
    "domain",
    `Removed domain ${dom.name}`,
    user.name,
    dom.projectId,
  );
  // Caller re-applies routing so the removed host stops being served.
  return dom.projectId;
}
