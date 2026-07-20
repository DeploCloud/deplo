import "server-only";

import { resolve4 } from "node:dns/promises";
import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  domains as domainsTable,
  domainMiddlewares as domainMiddlewaresTable,
  apps as appsTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import yaml from "js-yaml";
import {
  resolveServerIp,
  nipDomain,
  randomWords,
  isIpv4,
  isLoopbackIp,
  nipEmbeddedIp,
  rehostNip,
  domainTlsConfig,
  domainScheme,
} from "../deploy/domains";
import { classifyDomainDns, type DomainDnsClass } from "../deploy/cloudflare";
import { usesComposeStack } from "../utils";
import { portFor } from "../deploy/ports";
import {
  insertDomain,
  loadDomain,
  loadDomainsForApp,
  loadDomainsForApps,
  loadAppGraph,
  appInTeam,
} from "./app-graph-load";
import { domainToRow, domainMiddlewaresToRows } from "./app-graph-rows";
import { requireFolderCapabilityForApp } from "./folder-access";
import { getServerById } from "./servers";
import type { CertProvider, Domain, DomainEntrypoint } from "../types";

const DOMAIN_RE = /^(?!:\/\/)([a-zA-Z0-9-_]+\.)+[a-zA-Z]{2,}$/;

/** The one DNS resolver every domain check goes through, swappable so the
 * pglite test suite stays hermetic (a real `resolve4` would hit the network for
 * every seeded `*.example.io` host). Production always uses node's resolver. */
let dnsResolve4: (name: string) => Promise<string[]> = resolve4;

export function __setDnsResolve4ForTest(
  fn: (name: string) => Promise<string[]>,
): void {
  dnsResolve4 = fn;
}

export function __resetDnsResolve4ForTest(): void {
  dnsResolve4 = resolve4;
}

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
  "Routing to a named service is only available for compose stacks — single-image apps use the service port field.";

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
  appId: string,
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
    defaultApp?: string | null;
    /** TLS choice the domain is born with. Absent ⇒ `none` (no certificate is
     * ever registered by default); createApp passes `letsencrypt` only when the
     * blueprint itself expects HTTPS (it baked an `https://<own host>` URL). */
    certProvider?: CertProvider;
  },
): Promise<string> {
  const existing = await loadDomainsForApp(appId);
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
  // Only honor a preferred host that is one of our OWN generated nip.io hosts or
  // at least a syntactically valid hostname; a garbage value is dropped and a
  // fresh nip.io host is generated instead of being persisted.
  const preferredOk =
    !!preferred && (nipEmbeddedIp(preferred) != null || DOMAIN_RE.test(preferred));
  const name =
    preferredOk && !(await domainNameExists(preferred!))
      ? preferred!
      : await uniqueAutoDomainName(opts.slug, opts.ip);
  // Our own generated nip.io hosts point at the server IP by construction, so
  // they are born routable ("valid"). A caller-supplied CUSTOM host must NOT be
  // trusted as valid on sight — that would let a create squat or capture another
  // team's hostname on the shared server — so derive its status from DNS
  // (pending until it actually resolves to this server), exactly like addDomain.
  const status =
    nipEmbeddedIp(name) != null
      ? ("valid" as const)
      : await checkDomainDns(name, opts.ip);
  // Born WITHOUT a certificate unless the caller opted in: an absent stored
  // provider reads as letsencrypt at the deploy edge (pre-field back-compat),
  // so the default must be stored explicitly, never left off. Only mark ssl when
  // the host is actually routable, so we don't try to issue a cert for a pending
  // (unverified) custom host.
  const certProvider = opts.certProvider ?? "none";
  const domain: Domain = {
    id: newId("dom"),
    appId,
    name,
    status,
    primary: true,
    redirectTo: null,
    ssl: certProvider !== "none" && (status === "valid" || status === "cloudflare"),
    source: "auto",
    // Always born complete: the resolved container port (and, on a compose
    // stack, the service it routes to) so no auto domain is ever portless or
    // appless. These equal the project's default expose/build port, so the
    // compose renderer treats them as the default route (byte-identical YAML).
    port: opts.defaultPort,
    ...(opts.defaultApp ? { service: opts.defaultApp } : {}),
    certProvider,
    createdAt: nowIso(),
  };
  await insertDomain(getDb(), domain);
  return name;
}

/**
 * Ensure a secondary (non-primary) domain is registered for a project, e.g. the
 * extra hostnames a multi-domain template exposes (garage-with-ui's web UI).
 * Runs without an authenticated user (called from createApp, alongside the
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
  appId: string,
  rawName: string,
  route: {
    port: number;
    service?: string | null;
    slug: string;
    ip: string;
    /** TLS choice — same rule as {@link ensureAutoDomain}: absent ⇒ `none`. */
    certProvider?: CertProvider;
  },
): Promise<void> {
  const clean = rawName
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!clean || !DOMAIN_RE.test(clean)) return;
  const existing = await loadDomainsForApp(appId);
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
  // Same explicit-store rule as the primary: absent reads as letsencrypt at the
  // deploy edge (back-compat), so the born-without-a-cert default is written.
  const certProvider = route.certProvider ?? "none";
  const domain: Domain = {
    id: newId("dom"),
    appId,
    name,
    status: "valid",
    primary: false,
    redirectTo: null,
    ssl: certProvider !== "none",
    source: "auto",
    // The extra host comes from a compose `exposes` entry that carries its own
    // service + port; store both so the row is never appless/portless. They
    // equal that host's default expose, so the renderer keeps it byte-identical.
    port: route.port,
    ...(route.service ? { service: route.service } : {}),
    certProvider,
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
export async function primaryDomainName(appId: string): Promise<string> {
  return (await primaryDomainRow(appId))?.name ?? "";
}

/**
 * The full stored row behind {@link primaryDomainName} — for callers that also
 * need the domain's config (e.g. its cert provider, to pick the URL scheme).
 * Same primary-first-then-first fallback; null when the project has no domains.
 */
export async function primaryDomainRow(appId: string): Promise<Domain | null> {
  const domains = await loadDomainsForApp(appId);
  return domains.find((d) => d.primary) ?? domains[0] ?? null;
}

/**
 * The compose service the project's primary domain routes to, or "" when there
 * is none (single-image apps, or a project with no domains). Used to flag
 * the "exposed" instance for console ordering — the role the dropped
 * `project.expose.service` used to fill, now read from the authoritative
 * `domains` table.
 */
export async function primaryDomainApp(appId: string): Promise<string> {
  const domains = await loadDomainsForApp(appId);
  const primary = domains.find((d) => d.primary) ?? domains[0];
  return primary?.service ?? "";
}

export async function listDomains(
  appId?: string,
): Promise<(Domain & { serviceName: string; appSlug: string })[]> {
  const teamId = await requireActiveTeamId();
  // Only the active team's apps own routable domains; a appId filter
  // that points outside the team resolves to no project and so yields nothing.
  const teamApps = new Map(
    (
      await getDb()
        .select({
          id: appsTable.id,
          name: appsTable.name,
          slug: appsTable.slug,
        })
        .from(appsTable)
        .where(eq(appsTable.teamId, teamId))
    ).map((p) => [p.id, p] as const),
  );
  const ids = appId
    ? teamApps.has(appId)
      ? [appId]
      : []
    : [...teamApps.keys()];
  const domains = await loadDomainsForApps(ids);
  return domains
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .map((x) => {
      const p = teamApps.get(x.appId);
      return { ...x, serviceName: p?.name ?? "", appSlug: p?.slug ?? "" };
    });
}

/** The per-domain routing config a user sets when adding a domain — the same
 * knobs the Edit dialog exposes (port, entrypoint, cert provider, middlewares).
 * All optional. An omitted `certProvider` means NO certificate (`none`): a cert
 * is only ever registered when explicitly requested. (Only rows created BEFORE
 * the field existed read an absent stored provider as letsencrypt.) */
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
  appId: string,
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
  const project = await loadAppGraph(appId);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");
  await requireFolderCapabilityForApp(appId, "manage_domains");
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

  const service = resolveApp(config.service, project, isCompose);
  // On a compose stack the port is required (the chosen service's container
  // port); single-image keeps it optional (blank ⇒ the project's default port).
  if (isCompose && config.port == null)
    throw new Error("App port is required");
  const middlewares = normalizeMiddlewares(config.middlewares);
  // Strip is only meaningful with a path (a stripprefix middleware needs a
  // prefix to strip), so drop it otherwise — the router grammar does the same.
  const stripPrefix = Boolean(pathPrefix && config.stripPrefix);
  // First domain on the project becomes primary.
  const existing = await loadDomainsForApp(appId);
  const isFirst = existing.length === 0;
  // A path-routed row is a SECOND row on a hostname that may already be verified
  // (`app.com` for `/`, `app.com` for `/api`). DNS verification is a property of
  // the HOSTNAME, not of the path — the new row resolves to exactly the same
  // A/CNAME record the sibling already proved — so inherit the sibling's verified
  // status instead of restarting at `pending`. Without this the new row is filtered
  // out of `routableRoutes` (which only routes `valid`/`cloudflare`) and the path
  // silently never routes until the user hunts down the Verify button.
  const sibling = existing.find(
    (d) => d.name === clean && (d.status === "valid" || d.status === "cloudflare"),
  );
  // No verified sibling ⇒ check DNS RIGHT NOW instead of parking the row at
  // `pending` until someone finds the Verify button: a host whose record is
  // already in place (a suggested nip.io domain, a pre-pointed custom domain)
  // is born `valid`/`cloudflare` and the caller's routing re-apply makes it
  // live in the same click — zero manual steps. A host that doesn't check out
  // yet lands on `pending` (no record) or `misconfigured` (wrong address) and
  // the domains page keeps re-checking it automatically.
  const status =
    sibling?.status ??
    (await checkDomainDns(clean, await appServerIp(appId)));
  const domain: Domain = {
    id: newId("dom"),
    appId,
    name: clean,
    status,
    primary: isFirst,
    redirectTo: null,
    ssl: sibling ? sibling.ssl : status === "valid" || status === "cloudflare",
    // Always store a concrete port so no domain is ever portless. Compose
    // already required one above; single-image falls back to the project's
    // production port (build.port) — byte-identical to leaving it null, since
    // the router resolves an absent port to build.port anyway.
    port: config.port ?? portFor(project),
    // Entrypoint persists only when the user picked it explicitly (manual mode).
    // Absent ⇒ derived at deploy time by domainTlsConfig (websecure for TLS, web
    // for the `none` provider). Storing it only when given keeps the auto/manual
    // distinction round-trippable and a default domain byte-identical.
    ...(config.entrypoint ? { entrypoint: config.entrypoint } : {}),
    certProvider: config.certProvider ?? "none",
    ...(middlewares.length ? { middlewares } : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
    ...(stripPrefix ? { stripPrefix } : {}),
    ...(service ? { service } : {}),
    createdAt: nowIso(),
  };
  await insertDomain(getDb(), domain);
  await recordActivity("domain", `Added domain ${clean}`, user.name, appId);
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
  // Strip the backtick (the value is interpolated into a Traefik backtick literal
  // inside a router rule) plus double-quotes and control characters (incl.
  // newlines): the rule is emitted into a compose label, and although the label
  // emitter now JSON-escapes, keeping these out preserves a clean rule grammar.
  p = p.replace(/[`"\u0000-\u001f]/g, "");
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/+$/, "");
  return p; // "" for a bare "/" (the trailing-slash strip leaves "")
}

/** The service names declared in a project's compose file, or [] when there is
 * no parseable compose (single-image apps, malformed YAML). Used to validate
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
 * (→ error) on single-image apps. Single-image returns null (no service).
 * Rejecting an unknown/absent service keeps an inert value from being persisted. */
function resolveApp(
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
    throw new Error(`App "${service}" is not defined in the compose file`);
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
    if (!m || seen.has(m)) continue;
    // A middleware name is emitted verbatim into a Traefik `middlewares=` label,
    // which is rendered into the compose YAML. Restrict it to the characters a
    // real Traefik middleware reference uses (name, optional `@provider`) so a
    // crafted value can't carry quotes/newlines/`:` toward the renderer. The
    // label emitter also JSON-escapes as a backstop, but rejecting here gives the
    // user a clear error instead of a silently-broken router.
    if (!/^[A-Za-z0-9._@-]+$/.test(m))
      throw new Error(`Invalid middleware name: ${m}`);
    seen.add(m);
    out.push(m);
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
 * mutation — and return the appId so the caller can re-apply routing (the
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
  const project = await loadAppGraph(current.appId);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");
  await requireFolderCapabilityForApp(current.appId, "manage_domains");

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
  const nextApp =
    patch.service !== undefined
      ? resolveApp(patch.service, project, isCompose)
      : current.service ?? null;
  // On a compose stack the resulting domain must name a service and a port; the
  // Edit dialog always sends both, this guards a direct/legacy call.
  const nextPort = patch.port !== undefined ? patch.port : current.port ?? null;
  if (isCompose) {
    if (!nextApp) throw new Error("Select the service this domain routes to");
    if (nextPort == null) throw new Error("App port is required");
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
  if (patch.service !== undefined) next.service = nextApp ?? undefined;
  // A renamed custom domain points at a new host whose DNS the stored status
  // says nothing about — so check the NEW name right now, exactly like addDomain
  // does: a pre-pointed host keeps routing across the rename with zero manual
  // steps, an unpointed one drops to pending/misconfigured and stops routing
  // until the automatic re-checks see it settle. An auto nip.io host always
  // resolves, so it stays valid untouched.
  if (renamed && next.source !== "auto") {
    next.status = await checkDomainDns(nextName, await appServerIp(current.appId));
    next.ssl = next.status === "valid" || next.status === "cloudflare";
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
    dom.appId,
  );
  return dom.appId;
}

/**
 * Verify a domain against real DNS and settle its status into one of three
 * outcomes (the classification is pure — {@link classifyDomainDns}):
 *
 *   - `valid`         its A records — following any CNAME chain, which resolve4
 *                     does — include the public IPv4 of the server this project
 *                     runs on. Traefik issues the Let's Encrypt cert on the next
 *                     request, so `ssl` flips on. (The long-standing check.)
 *   - `cloudflare`    the domain is proxied through Cloudflare's orange-cloud:
 *                     its A records are Cloudflare's shared anycast IPs, which
 *                     INTENTIONALLY mask the origin, so a bare server-IP match
 *                     can never see this server. That is a correct, working setup
 *                     — not a misconfiguration — so it gets its own status and is
 *                     treated as routable (see {@link routableRoutes}). TLS is
 *                     served at Cloudflare's edge, so `ssl` is on.
 *   - `misconfigured` its A records point at some unrelated address (a different
 *                     server, an unrelated site).
 *   - `pending`       it doesn't resolve at all yet (no A record) — the normal
 *                     state of a record the user just created; the domains page
 *                     re-checks it automatically until it settles.
 *
 * The server-IP DNS check (deplo's core) is unchanged; the Cloudflare case is a
 * new, additive branch that stops a correctly-proxied domain from reading as
 * broken. A domain whose DNS is on Cloudflare but NOT proxied (grey-cloud)
 * resolves straight to the origin and so verifies as `valid` exactly as before.
 *
 * Returns the settled domain plus `statusChanged`, so the caller can skip the
 * routing re-apply (an agent round-trip) when a check settles on the status the
 * row already had — the common case for the page's automatic interval checks.
 */
export async function verifyDomain(
  id: string,
): Promise<Domain & { statusChanged: boolean }> {
  const { membership } = await requireCapability("manage_domains");
  const dom = await loadDomain(id);
  if (!dom) throw new Error("Not found");
  if (!(await appInTeam(dom.appId, membership.teamId)))
    throw new Error("App not found");
  await requireFolderCapabilityForApp(dom.appId, "manage_domains");

  // The domain must point at the server THIS project runs on — not always the
  // panel host: a project on a remote server needs its A record on that server.
  const target = await appServerIp(dom.appId);
  const status = await checkDomainDns(dom.name, target);
  // `valid` (points straight here) and `cloudflare` (proxied — DNS correctly
  // delegated to Cloudflare, origin masked) are both working, routable states,
  // so `ssl` (a cert is in effect for end users) is on for those two only — a
  // `pending`/`misconfigured` host has no working DNS and thus no live cert.
  const ssl = status === "valid" || status === "cloudflare";
  const statusChanged = status !== dom.status || ssl !== dom.ssl;

  const updated = await getDb()
    .update(domainsTable)
    .set({ status, ssl })
    .where(eq(domainsTable.id, id))
    .returning();
  if (updated.length === 0) throw new Error("Not found");
  return { ...dom, status, ssl, statusChanged };
}

/** The public IPv4 a project's custom domains must resolve to: the IP of the
 * server the project is deployed on, falling back to this instance's host when
 * that server has no usable recorded IP (mirrors the deploy path's choice). */
async function appServerIp(appId: string): Promise<string> {
  const project = await loadAppGraph(appId);
  const server = project?.serverId
    ? await getServerById(project.serverId)
    : null;
  return resolveServerIp(server ?? undefined);
}

/**
 * Resolve `name`'s A records and classify them against `target` (the server IP
 * this domain must reach) into `pending` / `valid` / `cloudflare` /
 * `misconfigured`. This is the thin resolver boundary; the verdict itself is
 * pure ({@link classifyDomainDns}) so it stays exhaustively unit-testable
 * without a network.
 *
 * resolve4 follows CNAME chains and returns the final A records, so a CNAME'd
 * host is handled here too — including a Cloudflare-proxied host, whose CNAME is
 * flattened to Cloudflare's anycast A records. IPv4-only, matching the IPv4 the
 * rest of the domain system uses.
 *
 * A host that doesn't resolve AT ALL (NXDOMAIN, SERVFAIL, no A record) reads as
 * `pending`, not `misconfigured`: checks now run automatically (at add time and
 * on the domains page's interval), so "no record yet" is the normal state of a
 * record the user just created and DNS hasn't propagated — calling that
 * "misconfigured" would flash red at everyone doing the right thing.
 * `misconfigured` is reserved for a host that DOES resolve, to an address that
 * is neither this server nor a Cloudflare edge.
 */
async function checkDomainDns(
  name: string,
  target: string,
): Promise<"pending" | DomainDnsClass> {
  let ips: string[] = [];
  try {
    ips = await dnsResolve4(name);
  } catch {
    ips = [];
  }
  if (ips.length === 0) return "pending";
  return classifyDomainDns(ips, target);
}

/**
 * Working, routable hostnames for a project, primary first.
 *
 * Only `valid` and `cloudflare` domains are returned: a pending/misconfigured
 * host has no working DNS, so routing to it would make Traefik fail HTTP-01
 * issuance and (because all hosts share one cert order) could jeopardise the
 * cert for the domains that *do* work. A `cloudflare` (proxied) host DOES route
 * — Cloudflare forwards to this origin — so it must be included. The primary is
 * sorted first so it stays the canonical host. Store-direct (no auth) so the
 * deploy engine can call it like [[ensure-auto-domain]] does. Empty when the
 * project has no working domain.
 */
export async function routableDomains(appId: string): Promise<string[]> {
  return (await routableRoutes(appId)).map((d) => d.name);
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
 * expose different apps on different hostnames; the TLS triplet lets each
 * host pick its entrypoint and certificate provider. A `null` port means "use
 * the project's default port". Same `valid`/`cloudflare` filtering rationale as
 * {@link routableDomains}.
 */
export async function routableRoutes(
  appId: string,
): Promise<RoutableDomain[]> {
  return (await loadDomainsForApp(appId))
    // `valid` (points straight here) and `cloudflare` (proxied — Cloudflare
    // forwards to this origin) are both working, routable hosts; a
    // pending/misconfigured host has no working DNS and is left off the router.
    .filter((d) => d.status === "valid" || d.status === "cloudflare")
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .map(toRoutableDomain);
}

/**
 * The stored row → the route its Traefik router is rendered from. The ONE mapper,
 * so every path into the router grammar carries the row's full config — port
 * override, TLS triplet, middleware chain, and (the part that used to get lost)
 * its `pathPrefix` + `stripPrefix`.
 *
 * {@link defaultRoute} is its counterpart for a hostname with no row behind it at
 * all (a preview's ephemeral host). Reaching for `defaultRoute` when a row DOES
 * exist is the bug this exists to prevent: it silently flattens the row to
 * whole-host HTTPS-on-the-default-port and the path never routes.
 */
export function toRoutableDomain(d: Domain): RoutableDomain {
  return {
    name: d.name,
    port: d.port ?? null,
    ...domainTlsConfig(d),
    middlewares: d.middlewares ?? [],
    pathPrefix: d.pathPrefix ?? "",
    stripPrefix: Boolean(d.stripPrefix),
    service: d.service ?? null,
  };
}

/**
 * The primary's stored row as a route, verified or NOT — the fallback a deploy
 * uses when the canonical host hasn't passed its DNS check yet (a brand-new app,
 * or a custom domain added minutes ago). Null when the app has no row for that
 * hostname, in which case the caller synthesises a {@link defaultRoute}.
 *
 * Store-direct (no auth) so the deploy engine can call it like {@link
 * routableDomains} does.
 */
export async function pendingPrimaryRoute(
  appId: string,
  primary: string,
): Promise<RoutableDomain | null> {
  if (!primary) return null;
  const rows = (await loadDomainsForApp(appId)).filter((d) => d.name === primary);
  // A hostname can carry SEVERAL rows (one per path), so prefer the one actually
  // flagged primary — `primary` is only a name, and picking whichever row happens
  // to come back first would route an arbitrary sibling's path as the canonical
  // host. Fall back to any row on that hostname when none is flagged (a legacy
  // app whose primary flag was never set).
  const row = rows.find((d) => d.primary) ?? rows[0];
  return row ? toRoutableDomain(row) : null;
}

/**
 * Flip which domain is primary for its project. Returns the affected appId
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
  if (!(await appInTeam(dom.appId, membership.teamId)))
    throw new Error("App not found");
  await requireFolderCapabilityForApp(dom.appId, "manage_domains");
  // A misconfigured domain has no working DNS to this server, so it can't be the
  // canonical host — block promoting it until its DNS is fixed and re-verified.
  // (A `pending` domain is allowed: the first domain added is pending+primary.)
  if (dom.status === "misconfigured")
    throw new Error(
      "This domain’s DNS is misconfigured — fix its DNS and re-verify before setting it as primary.",
    );
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
          eq(domainsTable.appId, dom.appId),
          eq(domainsTable.isPrimary, true),
        ),
      );
    await tx
      .update(domainsTable)
      .set({ isPrimary: true })
      .where(eq(domainsTable.id, id));
  });
  return dom.appId;
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
export async function syncProductionUrl(appId: string): Promise<void> {
  const domains = await loadDomainsForApp(appId);
  const primary = domains.find((x) => x.primary) ?? domains[0];
  await getDb()
    .update(appsTable)
    .set({
      // Scheme follows the primary's certificate provider: a cert-less (`none`)
      // domain is served plain-HTTP, so its canonical URL must say so.
      productionUrl: primary ? `${domainScheme(primary)}://${primary.name}` : null,
      updatedAt: nowIso(),
    })
    .where(eq(appsTable.id, appId));
}

export async function removeDomain(id: string): Promise<string> {
  const { membership } = await requireCapability("manage_domains");
  const user = (await getCurrentUser())!;
  const dom = await loadDomain(id);
  if (!dom) throw new Error("Not found");
  if (!(await appInTeam(dom.appId, membership.teamId)))
    throw new Error("App not found");
  await requireFolderCapabilityForApp(dom.appId, "manage_domains");
  // The domain_middlewares child rows CASCADE on the domain delete.
  await getDb().delete(domainsTable).where(eq(domainsTable.id, id));
  await recordActivity(
    "domain",
    `Removed domain ${dom.name}`,
    user.name,
    dom.appId,
  );
  // Caller re-applies routing so the removed host stops being served.
  return dom.appId;
}
