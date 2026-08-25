import "server-only";

// https://deplo.build/docs/guides/domains-and-https

import { resolve4 } from "node:dns/promises";
import { and, count, eq, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  domains as domainsTable,
  domainMiddlewares as domainMiddlewaresTable,
  apps as appsTable,
  appPreviews as appPreviewsTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId } from "../membership";
import { recordActivity } from "./activity";
import { dispatchAlert } from "../notify/dispatch";
import { assertLetsencryptQuota } from "../deploy/domains";
import yaml from "../yaml";
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
import {
  classifyDomainDns,
  certProviderForDns,
  type DomainDnsClass,
} from "../deploy/cloudflare";
import { usesComposeStack } from "../utils";
import { portFor } from "../deploy/ports";
import {
  insertDomain,
  loadDomain,
  loadDomainsForApp,
  loadDomainsForApps,
  loadAppGraph,
  appInTeam,
  appScopeWhere,
} from "./app-graph-load";
import { domainToRow, domainMiddlewaresToRows } from "./app-graph-rows";
import { appCapabilitiesForTeam, requireAppCapability } from "./node-access";
import { getServerById } from "./servers";
import {
  wwwCounterpart,
  deriveWwwRedirect,
  type WwwRedirect,
} from "../www-redirect";
import type { CertProvider, Domain, DomainEntrypoint } from "../types";

const DOMAIN_RE = /^(?!:\/\/)([a-zA-Z0-9-_]+\.)+[a-zA-Z]{2,}$/;

/** A caller-supplied hostname as it would be STORED: trimmed, lowercased, with
 *  the scheme and any trailing slash taken off. */
export function normalizePreferredHost(raw: string | null | undefined): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

/**
 * Whether a caller-supplied hostname is a CLAIM on a name — the thing
 * `manage_domains` exists to gate.
 */
export function isHostnameClaim(raw: string | null | undefined): boolean {
  const host = normalizePreferredHost(raw);
  return host !== "" && DOMAIN_RE.test(host) && nipEmbeddedIp(host) == null;
}

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

/**
 * A per-domain port override applies to every project: on a single-image project
 * it picks the container port this host routes to; on a compose stack it overrides
 * the chosen `service`'s compose-declared port (blank ⇒ the service's own port).
 */

/**
 * A `service` is the compose analogue of the single-image `port` override: it
 * picks which compose service a hostname routes to (the port defaults to that
 * service's compose definition, or the per-domain `port` when set).
 */
const SERVICE_UNSUPPORTED =
  "Picking a container is only available for compose stacks — a single-image app has exactly one, so use the container port field.";

/**
 * Refuse a hostname an app in ANOTHER TEAM already routes. The stored uniqueness
 * is `(name, coalesce(path_prefix,''))`, not `name`, so that one team can serve
 * `app.com` on `/` and `app.com` on `/api` from two apps.
 */
async function assertHostnameNotAnotherTeams(
  name: string,
  teamId: string,
  exceptDomainId: string | null,
): Promise<void> {
  const rows = await getDb()
    .select({ id: domainsTable.id, teamId: appsTable.teamId })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId))
    .where(eq(domainsTable.name, name));
  if (rows.some((r) => r.id !== exceptDomainId && r.teamId !== teamId))
    throw new Error(
      `${name} is already routed by another team on this Deplo. A hostname belongs to one team.`,
    );
}

/**
 * Refuse a PREVIEW BASE DOMAIN that lives under a hostname another team routes.
 */
export async function assertPreviewBaseNotAnotherTeams(
  base: string,
  teamId: string,
): Promise<void> {
  const clean = base.trim().toLowerCase();
  if (!clean) return;
  const rows = await getDb()
    .select({ name: domainsTable.name, teamId: appsTable.teamId })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId));
  const sameZone = (a: string, b: string) =>
    a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
  const taken = rows.find(
    (r) => r.teamId !== teamId && sameZone(r.name.toLowerCase(), clean),
  );
  if (taken)
    throw new Error(
      `${clean} is served by another team on this Deplo, so previews can't be published under it. A preview domain belongs to one team.`,
    );
}

/**
 * Whether `name` is unavailable. With a `pathPrefix` the stored uniqueness rule
 * applies - `(name, coalesce(path_prefix,''))` - so one team may serve `app.com`
 * on `/` and `app.com` on `/api` from two apps; another team's claim on the name
 * still refuses it at any path. Without one, any row with that name is a taken
 * name (what a generated host has to avoid).
 */
async function domainNameExists(
  name: string,
  pathPrefix?: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ teamId: appsTable.teamId, pathPrefix: domainsTable.pathPrefix })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId))
    .where(eq(domainsTable.name, name));
  if (rows.length === 0) return false;
  if (pathPrefix === undefined) return true;
  const teamId = await requireActiveTeamId();
  return rows.some(
    (r) => r.teamId !== teamId || (r.pathPrefix ?? "") === pathPrefix,
  );
}

/**
 * A generated nip.io hostname for `label` on `ip` whose `adjective-animal` words
 * don't collide with ANY existing domain (global uniqueness).
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
 * Ensure a project has a registered primary domain and return its hostname. If a
 * `preferred` name is given (e.g. the domain a template baked into its env), it is
 * used as-is; otherwise the nip.io hostname for the slug is generated.
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
    /**
     * The path this host routes here. An import brings apps that share ONE
     * hostname on different paths (a frontend on `/`, an API on `/api`), which
     * the stored uniqueness allows and a name-only check refused - so the second
     * one answered on an invented address.
     */
    preferredPath?: string;
  },
): Promise<string> {
  const existing = await loadDomainsForApp(appId);
  const primary = existing.find((d) => d.primary) ?? existing[0];
  if (primary) {
    // Self-heal an auto-generated nip.io domain that still encodes a stale or loopback
    // IP (e.g. created before DEPLO_SERVER_IP was set), so a corrected IP takes effect
    // on the next deploy without the operator deleting the domain by hand.
    if (
      primary.source === "auto" &&
      isIpv4(opts.ip) &&
      !isLoopbackIp(opts.ip)
    ) {
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

  // A template-baked `preferred` host is honored as-is UNLESS it already belongs to
  // another project (a re-used template domain, or a regenerate-after-delete that
  // drew the same words) — in which case fall back to a freshly-generated unique
  // host.
  const preferred = normalizePreferredHost(opts.preferred) || undefined;
  // Only honor a preferred host that is one of our OWN generated nip.io hosts or
  // at least a syntactically valid hostname; a garbage value is dropped and a
  // fresh nip.io host is generated instead of being persisted.
  const preferredOk =
    !!preferred &&
    (nipEmbeddedIp(preferred) != null || DOMAIN_RE.test(preferred));
  const preferredPath = (opts.preferredPath ?? "").trim();
  const name =
    preferredOk && !(await domainNameExists(preferred!, preferredPath))
      ? preferred!
      : await uniqueAutoDomainName(opts.slug, opts.ip);
  // The path only comes across with the host it belongs to.
  const pathPrefix = name === preferred ? preferredPath : "";
  // Our own generated nip.io hosts point at the server IP by construction, so they
  // are born routable ("valid").
  const status =
    nipEmbeddedIp(name) != null
      ? ("valid" as const)
      : await checkDomainDns(name, opts.ip);
  // Born WITHOUT a certificate unless the caller opted in: an absent stored provider
  // reads as letsencrypt at the deploy edge (pre-field back-compat), so the default
  // must be stored explicitly, never left off.
  const certProvider = certProviderForDns(status, opts.certProvider ?? "none");
  const domain: Domain = {
    id: newId("dom"),
    appId,
    name,
    status,
    primary: true,
    redirectTo: null,
    ssl:
      certProvider !== "none" &&
      (status === "valid" || status === "cloudflare"),
    source: "auto",
    // Always born complete: the resolved container port (and, on a compose stack, the
    // service it routes to) so no auto domain is ever portless or appless.
    port: opts.defaultPort,
    ...(opts.defaultApp ? { service: opts.defaultApp } : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
    certProvider,
    createdAt: nowIso(),
  };
  await insertDomain(getDb(), domain);
  return name;
}

/**
 * Ensure a secondary (non-primary) domain is registered for a project, e.g. the
 * extra hostnames a multi-domain template exposes (garage-with-ui's web UI).
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
  const clean = normalizePreferredHost(rawName);
  if (!clean || !DOMAIN_RE.test(clean)) return;
  const existing = await loadDomainsForApp(appId);
  // Already on this project (idempotent re-run) ⇒ nothing to do.
  if (existing.some((d) => d.name === clean && !d.primary)) return;
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
 * One route an import could not keep the address of: everything Deplo needs to
 * put it back on an address of its own.
 */
export interface ImportedRoute {
  /** The hostname it answered on over there. Kept as provenance, never used. */
  sourceHost: string;
  port: number | null;
  pathPrefix: string;
  stripPrefix: boolean;
  certProvider: CertProvider;
  entrypoint: DomainEntrypoint;
  service: string | null;
}

/**
 * Re-host the routes an import could not keep the address of, and answer with the
 * addresses they landed on (`sourceHost` -> the new hostname). An app that
 * answered on two addresses over there must answer on two here.
 */
export async function addImportedDomains(
  appId: string,
  routes: ImportedRoute[],
  opts: {
    slug: string;
    ip: string;
    /**
     * Source hosts that already landed somewhere - in practice the ONE the app's
     * primary domain became. Without it a second row on that same source host
     * would mint a second address, splitting an address that was never split.
     */
    seed?: Map<string, string>;
  },
): Promise<Map<string, string>> {
  const landed = new Map<string, string>(opts.seed);
  if (routes.length === 0) return landed;
  const existing = await loadDomainsForApp(appId);
  const taken = new Set(
    existing.map((d) => `${d.name}\u0000${d.pathPrefix ?? ""}`),
  );

  for (const route of routes) {
    // One mint per source host; every later row on that host joins it.
    let name = landed.get(route.sourceHost);
    if (!name) {
      name = await uniqueAutoDomainName(
        // Labelled by service where there is one, the convention
        // `ensureExtraDomain` set: on an app with several addresses, which is
        // which has to be readable without opening each row.
        route.service ? `${opts.slug}-${route.service}` : opts.slug,
        opts.ip,
      );
      landed.set(route.sourceHost, name);
    }
    const key = `${name}\u0000${route.pathPrefix}`;
    if (taken.has(key)) continue; // idempotent re-run, or a duplicate source row
    taken.add(key);

    const domain: Domain = {
      id: newId("dom"),
      appId,
      name,
      // Ours by construction: a nip.io host encodes this server's own IP, so it
      // resolves here the moment it exists (same reasoning as ensureAutoDomain).
      status: "valid",
      // Never primary: createApp already minted the app's primary, and this runs
      // after it. The import decides which route lands on THAT one.
      primary: false,
      redirectTo: null,
      ssl: route.certProvider !== "none",
      source: "auto",
      port: route.port,
      ...(route.service ? { service: route.service } : {}),
      certProvider: route.certProvider,
      entrypoint: route.entrypoint,
      ...(route.pathPrefix ? { pathPrefix: route.pathPrefix } : {}),
      ...(route.stripPrefix ? { stripPrefix: true } : {}),
      importedFrom: route.sourceHost,
      createdAt: nowIso(),
    };
    await insertDomain(getDb(), domain);
  }
  return landed;
}

/**
 * Put an imported route onto a domain row that already exists - the app's primary,
 * which `createApp` minted before the import could say what it should answer on.
 */
export async function applyImportedRoute(
  domainId: string,
  route: ImportedRoute,
): Promise<void> {
  await getDb()
    .update(domainsTable)
    .set({
      port: route.port,
      service: route.service,
      certProvider: route.certProvider,
      entrypoint: route.entrypoint,
      pathPrefix: route.pathPrefix || null,
      stripPrefix: route.stripPrefix || null,
      ssl: route.certProvider !== "none",
      importedFrom: route.sourceHost,
    })
    .where(eq(domainsTable.id, domainId));
}

/**
 * Stop telling this app that its addresses changed.
 */
export async function dismissImportedDomains(appId: string): Promise<void> {
  const { membership } = await requireAppCapability(appId, "manage_domains");
  const project = await loadAppGraph(appId);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");
  await getDb()
    .update(domainsTable)
    .set({ importedFrom: null })
    .where(eq(domainsTable.appId, appId));
}

/**
 * The hostname of a project's current primary domain, or "" when the project has
 * no domains at all. Prefers the `primary`-flagged row, falling back to the first
 * domain (mirrors syncProductionUrl's choice).
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
  // Same fallback rule as {@link syncProductionUrl}: a redirecting hostname is
  // never the canonical host, it only points at it.
  return (
    domains.find((d) => d.primary) ??
    domains.find((d) => !d.redirectTo) ??
    domains[0] ??
    null
  );
}

/**
 * The compose service the project's primary domain routes to, or "" when there is
 * none (single-image apps, or a project with no domains).
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
  // that points outside the team (or outside an API token's project scope)
  // resolves to no project and so yields nothing.
  const scopedApps = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      slug: appsTable.slug,
      folderId: appsTable.folderId,
      projectId: appsTable.projectId,
      environmentId: appsTable.environmentId,
    })
    .from(appsTable)
    .where(and(eq(appsTable.teamId, teamId), appScopeWhere()));
  // A domain names its app and its hostname, so an app the caller can't reach (one
  // inside a folder they can't see) contributes none.
  const reach = await appCapabilitiesForTeam(
    teamId,
    scopedApps.map((p) => ({
      id: p.id,
      folderId: p.folderId ?? null,
      projectId: p.projectId ?? null,
      environmentId: p.environmentId ?? null,
    })),
  );
  const teamApps = new Map(
    scopedApps
      .filter((p) => (reach.get(p.id)?.length ?? 0) > 0)
      .map((p) => [p.id, p] as const),
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

/**
 * The per-domain routing config a user sets when adding a domain — the same knobs
 * the Edit dialog exposes (port, entrypoint, cert provider, middlewares).
 */
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
  /** `www` ⇄ non-`www` pairing for this hostname — see {@link applyWwwRedirect}.
   * Absent/`none` ⇒ the hostname is routed on its own, exactly as before. */
  www?: WwwRedirect;
}

export async function addDomain(
  appId: string,
  name: string,
  config: DomainConfig = {},
): Promise<Domain> {
  const { membership } = await requireAppCapability(appId, "manage_domains");
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
  // The hostname must also not already belong to another team, whatever the path.
  await assertHostnameNotAnotherTeams(clean, membership.teamId, null);

  await assertTeamLetsencryptQuota(
    membership.teamId,
    config.certProvider ?? "none",
  );

  const service = resolveApp(config.service, project, isCompose);
  // On a compose stack the port is required (the chosen service's container
  // port); single-image keeps it optional (blank ⇒ the project's default port).
  if (isCompose && config.port == null)
    throw new Error("Container port is required");
  const middlewares = normalizeMiddlewares(config.middlewares);
  // Strip is only meaningful with a path (a stripprefix middleware needs a
  // prefix to strip), so drop it otherwise — the router grammar does the same.
  const stripPrefix = Boolean(pathPrefix && config.stripPrefix);
  // First domain on the project becomes primary.
  const existing = await loadDomainsForApp(appId);
  const isFirst = existing.length === 0;
  // A path-routed row is a SECOND row on a hostname that may already be verified
  // (`app.com` for `/`, `app.com` for `/api`).
  const sibling = existing.find(
    (d) =>
      d.name === clean && (d.status === "valid" || d.status === "cloudflare"),
  );
  // No verified sibling ⇒ check DNS RIGHT NOW instead of parking the row at `pending`
  // until someone finds the Verify button: a host whose record is already in place (a
  // suggested nip.io domain, a pre-pointed custom domain) is born
  // `valid`/`cloudflare` and the caller's routing re-apply makes it live in the same
  // click — zero manual steps.
  const status =
    sibling?.status ?? (await checkDomainDns(clean, await appServerIp(appId)));
  // A host the check found PROXIED is served over HTTPS by Cloudflare, so it is born
  // with the `cloudflare` provider instead of the cert-less default — the user never
  // has to open Advanced settings to match what Cloudflare already does.
  const certProvider = certProviderForDns(
    status,
    config.certProvider ?? "none",
  );
  const domain: Domain = {
    id: newId("dom"),
    appId,
    name: clean,
    status,
    primary: isFirst,
    redirectTo: null,
    ssl: sibling ? sibling.ssl : status === "valid" || status === "cloudflare",
    // Always store a concrete port so no domain is ever portless.
    port: config.port ?? portFor(project),
    // Entrypoint persists only when the user picked it explicitly (manual mode).
    ...(config.entrypoint ? { entrypoint: config.entrypoint } : {}),
    certProvider,
    ...(middlewares.length ? { middlewares } : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
    ...(stripPrefix ? { stripPrefix } : {}),
    ...(service ? { service } : {}),
    createdAt: nowIso(),
  };
  await insertDomain(getDb(), domain);
  // Pair the hostname with its www counterpart when the add asked for one. Runs
  // BEFORE the canonical URL is synced, because a `toCounterpart` pairing hands
  // `primary` to the hostname that ends up serving the app.
  if (config.www && config.www !== "none")
    await applyWwwRedirect(domain, config.www, membership.teamId);
  // The FIRST domain is the app's canonical URL from this second on (before it, the
  // card reads "No domain yet"); a later one can still change the scheme of the
  // fallback the app is showing.
  await syncProductionUrl(appId);
  await recordActivity("domain", `Added domain ${clean}`, user.name, appId);
  return domain;
}

/**
 * Per-team Let's Encrypt quota: the whole fleet shares ONE ACME account/resolver,
 * so an uncapped tenant registering hundreds of letsencrypt subdomains would
 * exhaust the shared account's rate limit for every other team.
 */
async function assertTeamLetsencryptQuota(
  teamId: string,
  provider: CertProvider,
): Promise<void> {
  if (provider !== "letsencrypt") return;
  const [domains, previews] = await Promise.all([
    getDb()
      .select({ n: count() })
      .from(domainsTable)
      .innerJoin(appsTable, eq(domainsTable.appId, appsTable.id))
      .where(
        and(
          eq(appsTable.teamId, teamId),
          eq(domainsTable.certProvider, "letsencrypt"),
        ),
      ),
    getDb()
      .select({ n: count() })
      .from(appPreviewsTable)
      .innerJoin(appsTable, eq(appPreviewsTable.appId, appsTable.id))
      .where(
        and(
          eq(appsTable.teamId, teamId),
          eq(appPreviewsTable.certProvider, "letsencrypt"),
          eq(appPreviewsTable.state, "open"),
        ),
      ),
  ]);
  assertLetsencryptQuota(
    (domains[0]?.n ?? 0) + (previews[0]?.n ?? 0),
    provider,
  );
}

/**
 * Normalise a router path prefix to its canonical stored form: trim, strip a
 * pasted scheme/host, drop backticks (it is interpolated into a Traefik backtick
 * literal), force a single leading slash, drop a trailing slash.
 */
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
  // inside a router rule) plus double-quotes and control characters (incl. newlines):
  // the rule is emitted into a compose label, and although the label emitter now
  // JSON-escapes, keeping these out preserves a clean rule grammar.
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

/**
 * Validate + normalise a domain's chosen compose `service`: REQUIRED on a compose
 * stack (a domain must name the service it routes to — there is no "default
 * service"), must name a real service in that stack, and is rejected (→ error) on
 * single-image apps.
 */
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
  if (!service) throw new Error("Select the container this domain routes to");
  const names = composeServiceNames(project.compose);
  if (!names.includes(service))
    throw new Error(`No container named "${service}" in the compose file`);
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
    // A middleware name is emitted verbatim into a Traefik `middlewares=` label, which
    // is rendered into the compose YAML.
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
  /** `www` ⇄ non-`www` pairing — see {@link applyWwwRedirect}. Absent ⇒ the
   * pairing is left exactly as it is (the Edit dialog always sends the derived
   * current value, so an untouched dropdown is a no-op). */
  www?: WwwRedirect;
  /**
   * The entrypoint, expressed as a tri-state because the Edit dialog always sends
   * the full routing config: - a concrete value → manual mode: store it - `null` →
   * auto mode: delete it (derived at deploy time) - absent (`undefined`) → leave
   * whatever is stored unchanged This lets the "set entrypoint manually" checkbox
   * round-trip (auto persists as a genuinely-absent field) without colliding with
   * "field not in this edit".
   */
  entrypoint?: DomainEntrypoint | null;
}

/**
 * Apply a full edit to a domain — name, port override, entrypoint, cert provider,
 * middleware chain, path prefix (+strip), and compose service in one mutation —
 * and return the appId so the caller can re-apply routing (the new Traefik labels
 * only reach the running container once its stack file is re-rendered).
 */
export async function updateDomain(
  id: string,
  patch: DomainPatch,
): Promise<string> {
  const user = (await getCurrentUser())!;
  const current = await loadDomain(id);
  if (!current) throw new Error("Not found");
  const { membership } = await requireAppCapability(
    current.appId,
    "manage_domains",
  );
  const project = await loadAppGraph(current.appId);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");

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
      : (current.pathPrefix ?? "");
  const nextApp =
    patch.service !== undefined
      ? resolveApp(patch.service, project, isCompose)
      : (current.service ?? null);
  // On a compose stack the resulting domain must name a service and a port; the
  // Edit dialog always sends both, this guards a direct/legacy call.
  const nextPort =
    patch.port !== undefined ? patch.port : (current.port ?? null);
  if (isCompose) {
    if (!nextApp) throw new Error("Select the container this domain routes to");
    if (nextPort == null) throw new Error("Container port is required");
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
  // A RENAME is the other way onto someone else's hostname, so it gets the same
  // refusal `addDomain` does. This row is excluded from the comparison - an edit
  // that only moves a port must not trip over itself.
  await assertHostnameNotAnotherTeams(nextName, membership.teamId, id);

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
  if (patch.pathPrefix !== undefined) next.pathPrefix = nextPath || undefined;
  // Strip needs a path; recompute against the path now in effect.
  if (patch.stripPrefix !== undefined || patch.pathPrefix !== undefined) {
    const effPath =
      patch.pathPrefix !== undefined ? nextPath : (current.pathPrefix ?? "");
    const strip =
      Boolean(effPath) && (patch.stripPrefix ?? current.stripPrefix ?? false);
    next.stripPrefix = strip ? true : undefined;
  }
  if (patch.service !== undefined) next.service = nextApp ?? undefined;
  // A renamed domain points at a new host whose DNS the stored status says nothing
  // about — so check the NEW name right now, exactly like addDomain does: a
  // pre-pointed host keeps routing across the rename with zero manual steps, an
  // unpointed one drops to pending/misconfigured and stops routing until the
  // automatic re-checks see it settle.
  if (renamed) {
    next.status = await checkDomainDns(
      nextName,
      await appServerIp(current.appId),
    );
    next.ssl = next.status === "valid" || next.status === "cloudflare";
    // The rename's check can discover the NEW host is proxied, so it gets the same
    // automatic Cloudflare provider an add would have given it — UNLESS this edit
    // deliberately moved the provider, which always wins.
    const chosen =
      patch.certProvider !== undefined &&
      patch.certProvider !== current.certProvider;
    if (!chosen)
      next.certProvider = certProviderForDns(next.status, next.certProvider);
  }

  await getDb().transaction(async (tx) => {
    await tx
      .update(domainsTable)
      .set(domainToRow(next))
      .where(eq(domainsTable.id, id));
    // Whole-set replace of the ordered middleware child rows.
    await tx
      .delete(domainMiddlewaresTable)
      .where(eq(domainMiddlewaresTable.domainId, id));
    const mwRows = domainMiddlewaresToRows(next);
    if (mwRows.length > 0)
      await tx.insert(domainMiddlewaresTable).values(mwRows);
  });
  const dom = next;
  // A rename moves the hostname every dependent redirect points AT, so the
  // dependents follow it — otherwise a `www` companion would keep 301-ing to a
  // hostname this app no longer answers on.
  if (renamed) await repointRedirects(dom.appId, current.name, dom.name);
  // The www pairing is applied last: it reads the app's rows back, so it must see
  // the renamed row and the re-pointed dependents, and it can move `primary`
  // before the canonical URL below is derived.
  if (patch.www !== undefined)
    await applyWwwRedirect(dom, patch.www, membership.teamId);
  // A rename moves the canonical host; a certificate-provider change moves its
  // scheme (http ⇄ https). Both are visible in the URL, so re-derive it.
  await syncProductionUrl(dom.appId);
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

/* ------------------------------------------------------------------ */
/* www ⇄ non-www pairing                                               */
/* ------------------------------------------------------------------ */

/**
 * Pair a hostname with its `www`/non-`www` counterpart so one of the two serves
 * the app and the other permanently redirects to it. `mode` is expressed relative
 * to `domain` — the row the user is editing: - `none` — break the pair.
 */
async function applyWwwRedirect(
  domain: Domain,
  mode: WwwRedirect,
  teamId: string,
): Promise<void> {
  const all = await loadDomainsForApp(domain.appId);
  const self = all.find((d) => d.id === domain.id) ?? domain;
  if (deriveWwwRedirect(self.name, all) === mode) return;

  const counterpart = wwwCounterpart(self.name);
  if (!counterpart)
    throw new Error(
      `${self.name} has no www variant to pair with — the www redirect is for a site's own domain, e.g. example.com.`,
    );
  // A path-routed row serves ONE path of its host, not the site, so pairing it
  // with a whole-host redirect would send the rest of the host nowhere.
  if ((self.pathPrefix ?? "").trim())
    throw new Error(
      `${self.name} routes the path ${self.pathPrefix} — a www redirect applies to a whole hostname, so it can't be set on a path route.`,
    );
  const other = all.find((d) => d.name === counterpart);

  if (mode === "none") {
    if (self.redirectTo) await writeRedirectTo(self.id, null);
    if (other && other.redirectTo === self.name) {
      // Ours to delete only if we created it; a hostname the user added is left
      // in place, serving the app again.
      if (other.source === "redirect") await deleteDomainRow(other.id);
      else await writeRedirectTo(other.id, null);
    }
    return;
  }

  if (mode === "toThis") {
    // This row serves from now on, so it can't also be redirecting away.
    if (self.redirectTo) await writeRedirectTo(self.id, null);
    if (!other) {
      await insertPairedDomain(self, counterpart, {
        redirectTo: self.name,
        source: "redirect",
        teamId,
      });
    } else {
      // A path route serves ONE path of its host; turning it into a whole-host
      // redirect would send the rest of that hostname nowhere.
      if ((other.pathPrefix ?? "").trim())
        throw new Error(
          `${counterpart} routes the path ${other.pathPrefix} — remove that domain before redirecting the hostname.`,
        );
      await writeRedirectTo(other.id, self.name);
    }
    await movePrimaryToServingHost(domain.appId, self.name, counterpart);
    return;
  }

  // toCounterpart: the counterpart serves, this row redirects to it.
  if (!other) {
    await insertPairedDomain(self, counterpart, {
      redirectTo: null,
      source: "custom",
      teamId,
    });
  } else if (other.redirectTo) {
    await writeRedirectTo(other.id, null);
  }
  await writeRedirectTo(self.id, counterpart);
  await movePrimaryToServingHost(domain.appId, counterpart, self.name);
}

/**
 * Keep `primary` on the half of a pair that SERVES the app.
 */
async function movePrimaryToServingHost(
  appId: string,
  servingName: string,
  redirectingName: string,
): Promise<void> {
  const rows = await loadDomainsForApp(appId);
  const redirecting = rows.find((d) => d.name === redirectingName);
  if (!redirecting?.primary) return;
  const serving = rows.find((d) => d.name === servingName);
  if (!serving) return;
  await getDb().transaction(async (tx) => {
    await tx
      .update(domainsTable)
      .set({ isPrimary: false })
      .where(
        and(eq(domainsTable.appId, appId), eq(domainsTable.isPrimary, true)),
      );
    await tx
      .update(domainsTable)
      .set({ isPrimary: true })
      .where(eq(domainsTable.id, serving.id));
  });
}

/**
 * Follow a renamed hostname with everything that redirects to it.
 */
async function repointRedirects(
  appId: string,
  oldName: string,
  newName: string,
): Promise<void> {
  const dependents = (await loadDomainsForApp(appId)).filter(
    (d) => d.redirectTo === oldName,
  );
  if (dependents.length === 0) return;
  const nextCounterpart = wwwCounterpart(newName);
  for (const dep of dependents) {
    const rename =
      dep.source === "redirect" &&
      dep.name === wwwCounterpart(oldName) &&
      nextCounterpart != null &&
      nextCounterpart !== dep.name &&
      !(await domainNameExists(nextCounterpart));
    if (!rename) {
      await writeRedirectTo(dep.id, newName);
      continue;
    }
    const status = await checkDomainDns(
      nextCounterpart!,
      await appServerIp(appId),
    );
    await getDb()
      .update(domainsTable)
      .set({
        name: nextCounterpart!,
        redirectTo: newName,
        status,
        ssl:
          (dep.certProvider ?? "letsencrypt") !== "none" &&
          (status === "valid" || status === "cloudflare"),
      })
      .where(eq(domainsTable.id, dep.id));
  }
}

/** Point a domain at another hostname (or clear the pointer). The single writer
 * of `redirect_to`, so every path through the pairing above stays one statement
 * and one meaning: "this hostname answers 301 to that one". */
async function writeRedirectTo(
  id: string,
  target: string | null,
): Promise<void> {
  await getDb()
    .update(domainsTable)
    .set({ redirectTo: target })
    .where(eq(domainsTable.id, id));
}

/** Drop a domain row (its `domain_middlewares` children CASCADE). Used only for
 * a companion this feature created — see {@link applyWwwRedirect}. */
async function deleteDomainRow(id: string): Promise<void> {
  await getDb().delete(domainsTable).where(eq(domainsTable.id, id));
}

/**
 * Create the other half of a `www` pair, cloned from the row the user is editing:
 * same container port, same compose service, same entrypoint and the same
 * certificate provider — a redirect that answers on `https://www.…` needs its own
 * valid certificate there, or the browser hits a certificate error BEFORE it is
 * ever told where to go.
 */
async function insertPairedDomain(
  from: Domain,
  name: string,
  opts: {
    redirectTo: string | null;
    source: "redirect" | "custom";
    teamId: string;
  },
): Promise<void> {
  if (await domainNameExists(name))
    throw new Error(
      `${name} is already routed by another app — remove it there first.`,
    );
  const status = await checkDomainDns(name, await appServerIp(from.appId));
  // Mirror the canonical host's certificate choice, upgrading to `cloudflare`
  // when the check finds THIS hostname proxied (the same rule an add follows).
  const certProvider = certProviderForDns(status, from.certProvider ?? "none");
  await assertTeamLetsencryptQuota(opts.teamId, certProvider);
  await insertDomain(getDb(), {
    id: newId("dom"),
    appId: from.appId,
    name,
    status,
    primary: false,
    redirectTo: opts.redirectTo,
    ssl:
      certProvider !== "none" &&
      (status === "valid" || status === "cloudflare"),
    source: opts.source,
    port: from.port ?? null,
    ...(from.entrypoint ? { entrypoint: from.entrypoint } : {}),
    certProvider,
    ...(from.service ? { service: from.service } : {}),
    createdAt: nowIso(),
  });
}

/**
 * Verify a domain against real DNS and settle its status into one of three
 * outcomes (the classification is pure — {@link classifyDomainDns}): - `valid` its
 * A records — following any CNAME chain, which resolve4 does — include the public
 * IPv4 of the server this project runs on.
 */
export async function verifyDomain(
  id: string,
): Promise<Domain & { statusChanged: boolean }> {
  const dom = await loadDomain(id);
  if (!dom) throw new Error("Not found");
  await requireAppCapability(dom.appId, "manage_domains");

  // The domain must point at the server THIS project runs on — not always the
  // panel host: a project on a remote server needs its A record on that server.
  const target = await appServerIp(dom.appId);
  const status = await checkDomainDns(dom.name, target);
  // `valid` (points straight here) and `cloudflare` (proxied — DNS delegated to
  // Cloudflare, origin masked) are the two routable states, so `ssl` (a cert is in
  // effect for end users) is on for those two only — a `pending`/ `misconfigured`
  // host has no working DNS and thus no live cert.
  const ssl = status === "valid" || status === "cloudflare";
  // Discovering the host is proxied also settles WHO issues its certificate:
  // Cloudflare does, at its edge.
  const certProvider = certProviderForDns(status, dom.certProvider);
  const providerChanged = certProvider !== dom.certProvider;
  // `statusChanged` is what tells the caller a routing re-apply is worth an agent
  // round-trip — a provider move rewrites the router's entrypoint and TLS labels,
  // so it counts as a change even when the status itself didn't budge.
  const statusChanged =
    status !== dom.status || ssl !== dom.ssl || providerChanged;

  const updated = await getDb()
    .update(domainsTable)
    .set({ status, ssl, ...(providerChanged ? { certProvider } : {}) })
    .where(eq(domainsTable.id, id))
    .returning();
  if (updated.length === 0) throw new Error("Not found");
  // A provider move flips the canonical URL's scheme (a proxied host is served
  // https:// from now on), so the stored URL follows.
  if (providerChanged) await syncProductionUrl(dom.appId);
  return { ...dom, status, ssl, certProvider, statusChanged };
}

/** The public IPv4 a project's custom domains must resolve to: the IP of the
 * server the project is deployed on, falling back to this instance's host when
 * that server has no usable recorded IP (mirrors the deploy path's choice). */
/**
 * Re-check every domain that was last seen pointing HERE, and report the ones that
 * no longer do.
 */
export async function sweepDomainDns(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({
      id: domainsTable.id,
      name: domainsTable.name,
      appId: domainsTable.appId,
      teamId: appsTable.teamId,
      slug: appsTable.slug,
      appName: appsTable.name,
    })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId))
    .where(eq(domainsTable.status, "valid"));

  for (const row of rows) {
    try {
      const status = await checkDomainDns(
        row.name,
        await appServerIp(row.appId),
      );
      if (status === "valid") continue;
      // Write the new status too, so the page and the alert agree.
      await db
        .update(domainsTable)
        .set({ status, ssl: status === "cloudflare" })
        .where(eq(domainsTable.id, row.id));
      dispatchAlert({
        teamId: row.teamId,
        key: "domain_dns_drift",
        dedupe: { id: `dns:${row.id}`, state: status },
        title: `${row.name} no longer points here`,
        body:
          status === "pending"
            ? "It stopped resolving. Traffic and certificate renewals will fail."
            : `Its DNS now answers with an address that is not ${row.appName}'s server.`,
        path: `/apps/${row.slug}`,
      });
    } catch (e) {
      // One unresolvable domain must never end the sweep.
      console.warn(`[deplo] dns sweep failed for ${row.name}:`, e);
    }
  }
}

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
 * `misconfigured`.
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
 * Working, routable hostnames for a project, primary first. The primary is sorted
 * first so it stays the canonical host.
 */
export async function routableDomains(appId: string): Promise<string[]> {
  return (await routableRoutes(appId)).map((d) => d.name);
}

/**
 * A routable hostname plus everything its Traefik router needs: the per-domain
 * port override (null ⇒ project default) and the resolved TLS triplet (entrypoint,
 * whether TLS is on, and the cert resolver).
 */
export interface RoutableDomain {
  name: string;
  port: number | null;
  /** Entrypoint the router binds to (`websecure` by default, `web` for HTTP). */
  entrypoint: string;
  /** Whether the router terminates TLS (`false` for the `none` provider). */
  tls: boolean;
  /** Resolved ACME resolver name. Empty when `tls` is false, and also when the
   *  provider is `custom` — TLS from a certificate already in the proxy's store
   *  asks no ACME provider for one. */
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
  /**
   * Absolute base URL this host permanently redirects to (`https://example.com`),
   * or "" when it serves the app.
   */
  redirectTo: string;
}

/**
 * A {@link RoutableDomain} for a bare hostname carrying no per-domain config: no
 * path, no strip, and by default the long-standing HTTPS/letsencrypt TLS triplet.
 */
export function defaultRoute(
  name: string,
  service: string | null = null,
  port: number | null = null,
  tls: { entrypoint?: DomainEntrypoint; certProvider?: CertProvider } = {},
): RoutableDomain {
  return {
    name,
    port,
    ...domainTlsConfig(tls),
    middlewares: [],
    pathPrefix: "",
    stripPrefix: false,
    service,
    redirectTo: "",
  };
}

/**
 * Valid, routable hostnames for a project (primary first), each with its port
 * override and resolved TLS triplet.
 */
export async function routableRoutes(appId: string): Promise<RoutableDomain[]> {
  const all = await loadDomainsForApp(appId);
  return (
    all
      // `valid` (points straight here) and `cloudflare` (proxied — Cloudflare may or may
      // not forward here, which DNS cannot tell us) are both routable hosts; a
      // pending/misconfigured host has no working DNS at all and is left off the router.
      .filter((d) => d.status === "valid" || d.status === "cloudflare")
      .sort((a, b) => Number(b.primary) - Number(a.primary))
      // Every row is mapped against the app's FULL domain set, because a
      // redirecting host resolves its target's scheme from the target's own row.
      .map((d) => toRoutableDomain(d, all))
  );
}

/**
 * The stored row → the route its Traefik router is rendered from.
 */
export function toRoutableDomain(
  d: Domain,
  /**
   * The app's other domains, so a redirecting host can read its TARGET's
   * certificate provider (the 301 must land on the scheme the canonical host is
   * really served over).
   */
  siblings: Domain[] = [],
): RoutableDomain {
  return {
    name: d.name,
    port: d.port ?? null,
    ...domainTlsConfig(d),
    middlewares: d.middlewares ?? [],
    pathPrefix: d.pathPrefix ?? "",
    stripPrefix: Boolean(d.stripPrefix),
    service: d.service ?? null,
    redirectTo: redirectTargetUrl(d, siblings),
  };
}

/**
 * The absolute URL a domain's stored `redirectTo` hostname resolves to, or "" when
 * the row serves the app.
 */
function redirectTargetUrl(d: Domain, siblings: Domain[]): string {
  const target = (d.redirectTo ?? "").trim().toLowerCase();
  if (!target || target === d.name) return "";
  const row = siblings.find((s) => s.name === target);
  if (row?.redirectTo) return "";
  return `${domainScheme(row ?? d)}://${target}`;
}

/**
 * The primary's stored row as a route, verified or NOT — the fallback a deploy
 * uses when the canonical host hasn't passed its DNS check yet (a brand-new app,
 * or a custom domain added minutes ago).
 */
export async function pendingPrimaryRoute(
  appId: string,
  primary: string,
): Promise<RoutableDomain | null> {
  if (!primary) return null;
  const all = await loadDomainsForApp(appId);
  const rows = all.filter((d) => d.name === primary);
  // A hostname can carry SEVERAL rows (one per path), so prefer the one actually
  // flagged primary — `primary` is only a name, and picking whichever row happens to
  // come back first would route an arbitrary sibling's path as the canonical host.
  const row = rows.find((d) => d.primary) ?? rows[0];
  return row ? toRoutableDomain(row, all) : null;
}

/**
 * Flip which domain is primary for its project.
 */
export async function setPrimaryDomain(id: string): Promise<string> {
  const dom = await loadDomain(id);
  if (!dom) throw new Error("Not found");
  await requireAppCapability(dom.appId, "manage_domains");
  // A misconfigured domain has no working DNS to this server, so it can't be the
  // canonical host — block promoting it until its DNS is fixed and re-verified.
  // (A `pending` domain is allowed: the first domain added is pending+primary.)
  if (dom.status === "misconfigured")
    throw new Error(
      "This domain’s DNS is misconfigured — fix its DNS and re-verify before setting it as primary.",
    );
  // A redirecting hostname serves nothing: making it canonical would advertise a
  // URL that answers 301 to another one. The pair is flipped from the Redirect
  // setting of the domain that serves, which moves `primary` with it.
  if (dom.redirectTo)
    throw new Error(
      `${dom.name} redirects to ${dom.redirectTo}, so it can't be the canonical host — flip the redirect from ${dom.redirectTo} instead.`,
    );
  // The multi-row primary flip is CLEAR-then-SET in one transaction (PLAN §4).
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
  await syncProductionUrl(dom.appId);
  return dom.appId;
}

/**
 * Point a project's canonical `productionUrl` at its current primary domain. Falls
 * back to the first remaining domain when none is flagged primary, and clears the
 * URL when the last domain is gone.
 */
export async function syncProductionUrl(appId: string): Promise<void> {
  const domains = await loadDomainsForApp(appId);
  // The fallback skips redirecting hostnames: they answer 301 to another host of
  // the same app, so advertising one as the canonical URL would send every
  // visitor (and every link in the dashboard) through a bounce.
  const primary =
    domains.find((x) => x.primary) ??
    domains.find((x) => !x.redirectTo) ??
    domains[0];
  await getDb()
    .update(appsTable)
    .set({
      // Scheme follows the primary's certificate provider: a cert-less (`none`)
      // domain is served plain-HTTP, so its canonical URL must say so.
      productionUrl: primary
        ? `${domainScheme(primary)}://${primary.name}`
        : null,
      updatedAt: nowIso(),
    })
    .where(eq(appsTable.id, appId));
}

/**
 * Which of the remaining domains inherits `primary` when the current primary is
 * deleted.
 */
export function successorPrimary(
  remaining: Domain[],
  removed: { service?: string | null; port?: number | null },
): Domain | null {
  if (remaining.length === 0) return null;
  const service = removed.service ?? null;
  const port = removed.port ?? null;
  // Routability rank: routed > not resolving yet > pointing somewhere else.
  const reach = (d: Domain): number =>
    d.status === "valid" || d.status === "cloudflare"
      ? 2
      : d.status === "misconfigured"
        ? 0
        : 1;
  const rank = (d: Domain): [number, number, number] => [
    (d.service ?? null) === service ? 1 : 0,
    (d.port ?? null) === port ? 1 : 0,
    reach(d),
  ];
  return [...remaining].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++)
      if (ra[i] !== rb[i]) return rb[i] - ra[i];
    return (
      a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name)
    );
  })[0]!;
}

export async function removeDomain(id: string): Promise<string> {
  const user = (await getCurrentUser())!;
  const dom = await loadDomain(id);
  if (!dom) throw new Error("Not found");
  await requireAppCapability(dom.appId, "manage_domains");
  // Removing the PRIMARY hands the crown to the closest remaining domain, in the same
  // transaction as the delete: an app with domains must always have exactly one
  // primary, and a half-applied succession would leave the canonical host undefined
  // (`primaryDomainRow` would fall back to an arbitrary row, and the "Primary" badge
  // would vanish from the domains list).
  const rest = (await loadDomainsForApp(dom.appId)).filter((d) => d.id !== id);
  // Removing a hostname takes its redirects with it: a companion Deplo generated for
  // the pair (`source: "redirect"`) is deleted — it exists only to point at this host
  // — while a hostname the USER added is merely un-redirected, so it stays as a
  // domain of the app and starts serving instead of 301-ing into a hole.
  const dependents = rest.filter((d) => d.redirectTo === dom.name);
  const orphaned = dependents.filter((d) => d.source === "redirect");
  const freed = dependents.filter((d) => d.source !== "redirect");
  const orphanedIds = new Set(orphaned.map((d) => d.id));
  // The heir must be a hostname that will still be there AND still serve: a
  // deleted companion, or a row that redirects somewhere else, is not a
  // canonical host.
  const heir = dom.primary
    ? successorPrimary(
        rest.filter(
          (d) =>
            !orphanedIds.has(d.id) &&
            (!d.redirectTo || d.redirectTo === dom.name),
        ),
        dom,
      )
    : null;
  await getDb().transaction(async (tx) => {
    // The domain_middlewares child rows CASCADE on the domain delete.
    await tx.delete(domainsTable).where(eq(domainsTable.id, id));
    for (const d of orphaned)
      await tx.delete(domainsTable).where(eq(domainsTable.id, d.id));
    for (const d of freed)
      await tx
        .update(domainsTable)
        .set({ redirectTo: null })
        .where(eq(domainsTable.id, d.id));
    if (heir)
      await tx
        .update(domainsTable)
        .set({ isPrimary: true })
        .where(eq(domainsTable.id, heir.id));
  });
  // The canonical URL follows immediately — either onto the heir, or to null when
  // that was the last domain. Otherwise the app card and the title bar keep
  // advertising the hostname the user just deleted until the next deploy.
  await syncProductionUrl(dom.appId);
  await recordActivity(
    "domain",
    `Removed domain ${dom.name}`,
    user.name,
    dom.appId,
  );
  // Caller re-applies routing so the removed host stops being served.
  return dom.appId;
}
