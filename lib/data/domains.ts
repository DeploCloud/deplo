import "server-only";

import { resolve4, resolveCname } from "node:dns/promises";
import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  domains as domainsTable,
  domainMiddlewares as domainMiddlewaresTable,
  projects as projectsTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import yaml from "js-yaml";
import {
  instanceHost,
  nipDomain,
  randomWords,
  isIpv4,
  isLoopbackIp,
  nipEmbeddedIp,
  rehostNip,
  domainTlsConfig,
} from "../deploy/domains";
import { usesComposeStack } from "../utils";
import { portFor } from "../deploy/ports";
import {
  insertDomain,
  loadDomain,
  loadDomainsForProject,
  loadDomainsForProjects,
  loadProjectGraph,
  projectInTeam,
} from "./project-graph-load";
import { domainToRow, domainMiddlewaresToRows } from "./project-graph-rows";
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

/** True if any project already owns this exact hostname (global uniqueness —
 * the `domains.name` unique index is the hard backstop; this is the friendly
 * pre-check that lets generation regenerate instead of hitting the violation). */
async function domainNameExists(name: string): Promise<boolean> {
  const hit = await getDb()
    .select({ id: domainsTable.id })
    .from(domainsTable)
    .where(eq(domainsTable.name, name))
    .limit(1);
  return hit.length > 0;
}

/**
 * A generated nip.io hostname for `label` on `ip` whose `adjective-animal` words
 * don't collide with ANY existing domain (global uniqueness). Regenerates the
 * word pair until the candidate is free, bounded so a saturated namespace can't
 * loop forever (~427k word pairs make a real collision astronomically unlikely;
 * the bound is a safety valve, not an expected path). The `domains.name` unique
 * index remains the hard backstop against a concurrent same-name insert.
 */
export async function uniqueAutoDomainName(
  label: string,
  ip: string,
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = nipDomain(label, randomWords(), ip);
    if (!(await domainNameExists(candidate))) return candidate;
  }
  // Exhausted retries (effectively impossible) — fall back to a guaranteed-unique
  // host by folding a random id segment into the words, so creation never wedges.
  return nipDomain(label, `${randomWords()}-${newId("").slice(1, 5)}`, ip);
}

/**
 * Ensure a project has a registered primary domain and return its hostname.
 *
 * Runs without an authenticated user (the deploy pipeline is fire-and-forget),
 * so it talks to the store directly. If a `preferred` name is given (e.g. the
 * domain a template baked into its env), it is used as-is; otherwise the
 * nip.io hostname for the slug is generated. The first domain on a project is
 * marked primary. Idempotent: returns the existing primary if one exists.
 */
export async function ensureAutoDomain(
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
): Promise<string> {
  const existing = await loadDomainsForProject(projectId);
  const primary = existing.find((d) => d.primary) ?? existing[0];
  if (primary) {
    // Self-heal an auto-generated nip.io domain that still encodes a stale or
    // loopback IP (e.g. created before DEPLO_SERVER_IP was set), so a corrected
    // IP takes effect on the next deploy without the operator deleting the
    // domain by hand. Only the hex IP label is rewritten — the words are kept,
    // so the host stays recognisably the same project's. Only auto domains are
    // touched, and never rewritten toward a loopback address.
    if (primary.source === "auto" && isIpv4(opts.ip) && !isLoopbackIp(opts.ip)) {
      const embedded = nipEmbeddedIp(primary.name);
      if (embedded && embedded !== opts.ip) {
        const fixed = rehostNip(primary.name, opts.ip);
        if (fixed !== primary.name) {
          await getDb()
            .update(domainsTable)
            .set({ name: fixed })
            .where(eq(domainsTable.id, primary.id));
          return fixed;
        }
      }
    }
    return primary.name;
  }

  // A template-baked `preferred` host is honored as-is UNLESS it already belongs
  // to another project (a re-used template domain, or a regenerate-after-delete
  // that drew the same words) — in which case fall back to a freshly-generated
  // unique host. Absent a preferred, generate a globally-unique one.
  const preferred = opts.preferred
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const name =
    preferred && !(await domainNameExists(preferred))
      ? preferred
      : await uniqueAutoDomainName(opts.slug, opts.ip);
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
  await insertDomain(getDb(), domain);
  return name;
}

/**
 * Ensure a secondary (non-primary) domain is registered for a project, e.g. the
 * extra hostnames a multi-domain template exposes (garage-with-ui's web UI).
 * Runs without an authenticated user (called from createProject, alongside the
 * primary auto domain). Registered ONCE at creation — never on a deploy — so a
 * deleted extra is never resurrected. Idempotent: a same-named domain on THIS
 * project is left as-is (so a creation retry won't duplicate it).
 *
 * The template-supplied `rawName` is honored when it's globally free. If it
 * already belongs to another project (two extras drew the same random words, or
 * a re-used template host), a fresh globally-unique host is generated from the
 * project's slug + service + `ip` instead — so a word collision regenerates
 * rather than silently dropping the domain.
 */
export async function ensureExtraDomain(
  projectId: string,
  rawName: string,
  route: { port: number; service?: string | null; slug: string; ip: string },
): Promise<void> {
  const clean = rawName
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!clean || !DOMAIN_RE.test(clean)) return;
  const existing = await loadDomainsForProject(projectId);
  // Already on this project (idempotent re-run) ⇒ nothing to do.
  if (existing.some((d) => d.name === clean)) return;
  // Honor the template host when globally free; otherwise regenerate a unique
  // one (labelled by slug + service so it stays recognizable) rather than skip.
  const name = (await domainNameExists(clean))
    ? await uniqueAutoDomainName(
        route.service ? `${route.slug}-${route.service}` : route.slug,
        route.ip,
      )
    : clean;
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
  await insertDomain(getDb(), domain);
}

/**
 * The hostname of a project's current primary domain, or "" when the project
 * has no domains at all. Store-direct (no auth) for the deploy engine: the
 * production deploy routes to this host and NEVER resurrects a deleted auto
 * domain — an empty string means "deploy unrouted". Prefers the `primary`-flagged
 * row, falling back to the first domain (mirrors syncProductionUrl's choice).
 */
export async function primaryDomainName(projectId: string): Promise<string> {
  const domains = await loadDomainsForProject(projectId);
  const primary = domains.find((d) => d.primary) ?? domains[0];
  return primary?.name ?? "";
}

/**
 * The compose service the project's primary domain routes to, or "" when there
 * is none (single-image projects, or a project with no domains). Used to flag
 * the "exposed" instance for console ordering — the role the dropped
 * `project.expose.service` used to fill, now read from the authoritative
 * `domains` table.
 */
export async function primaryDomainService(projectId: string): Promise<string> {
  const domains = await loadDomainsForProject(projectId);
  const primary = domains.find((d) => d.primary) ?? domains[0];
  return primary?.service ?? "";
}

export async function listDomains(
  projectId?: string,
): Promise<(Domain & { projectName: string; projectSlug: string })[]> {
  const teamId = await requireActiveTeamId();
  // Only the active team's projects own routable domains; a projectId filter
  // that points outside the team resolves to no project and so yields nothing.
  const teamProjects = new Map(
    (
      await getDb()
        .select({
          id: projectsTable.id,
          name: projectsTable.name,
          slug: projectsTable.slug,
        })
        .from(projectsTable)
        .where(eq(projectsTable.teamId, teamId))
    ).map((p) => [p.id, p] as const),
  );
  const ids = projectId
    ? teamProjects.has(projectId)
      ? [projectId]
      : []
    : [...teamProjects.keys()];
  const domains = await loadDomainsForProjects(ids);
  return domains
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
  const user = (await getCurrentUser())!;
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!DOMAIN_RE.test(clean)) throw new Error("Enter a valid domain name");
  const project = await loadProjectGraph(projectId);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("Project not found");
  const isCompose = usesComposeStack(project);

  // A path lets several rows share one hostname (e.g. `app.com` for `/` and
  // `app.com` for `/api`), so uniqueness is on (host + path), not host alone —
  // the long-standing single-row case is `pathPrefix === ""` on both sides.
  const pathPrefix = normalizePath(config.pathPrefix);
  // Friendly pre-check (the `(name, coalesce(path_prefix,'')) UNIQUE` index is
  // the real guard against a concurrent double-add).
  const dup = await getDb()
    .select({ id: domainsTable.id })
    .from(domainsTable)
    .where(
      and(
        eq(domainsTable.name, clean),
        eq(sql`coalesce(${domainsTable.pathPrefix}, '')`, pathPrefix),
      ),
    )
    .limit(1);
  if (dup.length > 0)
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
  // First domain on the project becomes primary.
  const isFirst = (await loadDomainsForProject(projectId)).length === 0;
  const domain: Domain = {
    id: newId("dom"),
    projectId,
    name: clean,
    status: "pending",
    primary: isFirst,
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
  await insertDomain(getDb(), domain);
  await recordActivity("domain", `Added domain ${clean}`, user.name, projectId);
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
  const user = (await getCurrentUser())!;
  const current = await loadDomain(id);
  if (!current) throw new Error("Not found");
  const project = await loadProjectGraph(current.projectId);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("Project not found");

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
  // Uniqueness on (host + path) against every OTHER domain (the partial-unique
  // index is the real guard; this is the friendly pre-check).
  const dup = await getDb()
    .select({ id: domainsTable.id })
    .from(domainsTable)
    .where(
      and(
        eq(domainsTable.name, nextName),
        eq(sql`coalesce(${domainsTable.pathPrefix}, '')`, nextPath),
      ),
    );
  if (dup.some((x) => x.id !== id))
    throw new Error(
      nextPath ? "Domain + path already added" : "Domain already added",
    );

  // Build the next domain object from `current` + the patch (delete-when-empty →
  // a NULL column), then write the flat row + replace the middleware child rows.
  const next: Domain = { ...current, name: nextName };
  if (patch.port !== undefined) next.port = patch.port ?? undefined;
  // Entrypoint tri-state: a value stores manual mode, `null` clears to auto, and
  // `undefined` leaves it unchanged.
  if (patch.entrypoint !== undefined)
    next.entrypoint = patch.entrypoint ?? undefined;
  if (patch.certProvider !== undefined) next.certProvider = patch.certProvider;
  if (patch.middlewares !== undefined) {
    const mws = normalizeMiddlewares(patch.middlewares);
    next.middlewares = mws.length ? mws : undefined;
  }
  if (patch.pathPrefix !== undefined)
    next.pathPrefix = nextPath || undefined;
  // Strip needs a path; recompute against the path now in effect.
  if (patch.stripPrefix !== undefined || patch.pathPrefix !== undefined) {
    const effPath = patch.pathPrefix !== undefined ? nextPath : current.pathPrefix ?? "";
    const strip = Boolean(effPath) && (patch.stripPrefix ?? current.stripPrefix ?? false);
    next.stripPrefix = strip ? true : undefined;
  }
  if (patch.service !== undefined) next.service = nextService ?? undefined;
  // A renamed custom domain points at a new host whose DNS we haven't checked:
  // drop it back to pending so it stops routing until re-verified. An auto
  // nip.io host always resolves, so it stays valid.
  if (renamed && next.source !== "auto") {
    next.status = "pending";
    next.ssl = false;
  }

  await getDb().transaction(async (tx) => {
    await tx.update(domainsTable).set(domainToRow(next)).where(eq(domainsTable.id, id));
    // Whole-set replace of the ordered middleware child rows.
    await tx.delete(domainMiddlewaresTable).where(eq(domainMiddlewaresTable.domainId, id));
    const mwRows = domainMiddlewaresToRows(next);
    if (mwRows.length > 0) await tx.insert(domainMiddlewaresTable).values(mwRows);
  });
  const dom = next;
  await recordActivity(
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
  const dom = await loadDomain(id);
  if (!dom) throw new Error("Not found");
  if (!(await projectInTeam(dom.projectId, membership.teamId)))
    throw new Error("Project not found");

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

  const updated = await getDb()
    .update(domainsTable)
    .set({ status: ok ? "valid" : "misconfigured", ssl: ok })
    .where(eq(domainsTable.id, id))
    .returning();
  if (updated.length === 0) throw new Error("Not found");
  return { ...dom, status: ok ? "valid" : "misconfigured", ssl: ok };
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
export async function routableDomains(projectId: string): Promise<string[]> {
  return (await routableRoutes(projectId)).map((d) => d.name);
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
 * the long-standing HTTPS/letsencrypt TLS triplet, no path, no strip. Used for
 * synthetic routes that aren't backed by a `valid` stored row — a preview's
 * ephemeral host, the primary fallback when a brand-new project has no `valid`
 * domain yet, or a never-deployed compose preview — so every route handed to the
 * router grammar has the full shape. `service`/`port` default to null (the
 * single-image fallback uses neither); the compose preview passes the stored
 * row's service + port so the right compose service is routed.
 */
export function defaultRoute(
  name: string,
  service: string | null = null,
  port: number | null = null,
): RoutableDomain {
  return {
    name,
    port,
    ...domainTlsConfig({}),
    middlewares: [],
    pathPrefix: "",
    stripPrefix: false,
    service,
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
export async function routableRoutes(
  projectId: string,
): Promise<RoutableDomain[]> {
  return (await loadDomainsForProject(projectId))
    .filter((d) => d.status === "valid")
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
  const dom = await loadDomain(id);
  if (!dom) throw new Error("Not found");
  if (!(await projectInTeam(dom.projectId, membership.teamId)))
    throw new Error("Project not found");
  // The multi-row primary flip is CLEAR-then-SET in one transaction (PLAN §4).
  // A single `SET is_primary = (id = $target)` UPDATE is NOT safe: the
  // `(project_id) WHERE is_primary` index is a plain (non-deferrable) unique, and
  // Postgres checks each updated tuple's index entry as it processes that row —
  // if the executor sets the NEW target true before clearing the OLD primary,
  // their two live `is_primary=true` entries collide (a transient duplicate-key
  // abort whose likelihood depends on physical scan order). Clearing every
  // primary first guarantees no two rows are ever simultaneously primary, so the
  // index can't transiently collide; the partial-unique still backstops two
  // concurrent flips (the loser aborts cleanly).
  await getDb().transaction(async (tx) => {
    await tx
      .update(domainsTable)
      .set({ isPrimary: false })
      .where(
        and(
          eq(domainsTable.projectId, dom.projectId),
          eq(domainsTable.isPrimary, true),
        ),
      );
    await tx
      .update(domainsTable)
      .set({ isPrimary: true })
      .where(eq(domainsTable.id, id));
  });
  return dom.projectId;
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
export async function syncProductionUrl(projectId: string): Promise<void> {
  const domains = await loadDomainsForProject(projectId);
  const primary = domains.find((x) => x.primary) ?? domains[0];
  await getDb()
    .update(projectsTable)
    .set({
      productionUrl: primary ? `https://${primary.name}` : null,
      updatedAt: nowIso(),
    })
    .where(eq(projectsTable.id, projectId));
}

export async function removeDomain(id: string): Promise<string> {
  const { membership } = await requireCapability("manage_domains");
  const user = (await getCurrentUser())!;
  const dom = await loadDomain(id);
  if (!dom) throw new Error("Not found");
  if (!(await projectInTeam(dom.projectId, membership.teamId)))
    throw new Error("Project not found");
  // The domain_middlewares child rows CASCADE on the domain delete.
  await getDb().delete(domainsTable).where(eq(domainsTable.id, id));
  await recordActivity(
    "domain",
    `Removed domain ${dom.name}`,
    user.name,
    dom.projectId,
  );
  // Caller re-applies routing so the removed host stops being served.
  return dom.projectId;
}
