import "server-only";

// https://deplo.build/docs/guides/networking/domains-and-https

import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  domains as domainsTable,
  domainMiddlewares as domainMiddlewaresTable,
} from "../../db/schema/control-plane/domains";
import { getCurrentUser } from "../../auth/current-user";
import { newId, nowIso } from "../../ids";
import { requireActiveTeamId } from "../../membership";
import { certProviderForDns, isRoutableDomain } from "../../deploy/cloudflare";
import { portFor } from "../../deploy/ports";
import { usesComposeStack } from "../../utils";
import { recordActivity } from "../activity";
import {
  insertDomain,
  loadDomain,
  loadDomainsForApp,
  loadDomainsForApps,
  loadAppGraph,
  appScopeWhere,
} from "../app-graph-load";
import { domainToRow, domainMiddlewaresToRows } from "../app-graph-rows/domain";
import { appCapabilitiesForTeam, requireAppCapability } from "../node-access";
import { withKeyedLock } from "../keyed-mutex";
import type { WwwRedirect } from "../../www-redirect";
import type {
  CertProvider,
  Domain,
  DomainEntrypoint,
} from "../../types/domain";
import {
  DOMAIN_RE,
  assertHostnameNotAnotherTeams,
  assertNotPanelHost,
} from "./hostname-claim";
import { appServerIp, checkDomainDns } from "./dns-check";
import { assertTeamLetsencryptQuota } from "./letsencrypt-quota";
import {
  normalizeMiddlewares,
  normalizePath,
  resolveApp,
} from "./route-config";
import { syncProductionUrl, successorPrimary } from "./primary-domain";
import { applyWwwRedirect, repointRedirects } from "./www-pairing";

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
  // A domain names its app and its hostname, so an app the caller can't reach
  // (one inside a folder they can't see) contributes none.
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

// DomainConfig: the per-domain routing config a user sets when adding a domain.
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
  /** `www` ⇄ non-`www` pairing for this hostname. Absent/`none` ⇒ the hostname
   * is routed on its own. */
  www?: WwwRedirect;
  /** The user declaring a proxy answers for this hostname, so it is routed even
   * though its DNS can never point here. See {@link Domain.proxied}. */
  proxied?: boolean;
}

export async function addDomain(
  appId: string,
  name: string,
  config: DomainConfig = {},
): Promise<Domain> {
  // The cross-team claim is a check-then-write; one hostname at a time closes
  // the race between two teams adding the same name on two paths.
  return withKeyedLock(`domain:${name.trim().toLowerCase()}`, () =>
    addDomainUnlocked(appId, name, config),
  );
}

async function addDomainUnlocked(
  appId: string,
  name: string,
  config: DomainConfig,
): Promise<Domain> {
  const { membership } = await requireAppCapability(appId, "manage_domains");
  const user = (await getCurrentUser())!;
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!DOMAIN_RE.test(clean)) throw new Error("Enter a valid domain name");
  assertNotPanelHost(clean);
  const project = await loadAppGraph(appId);
  if (!project || project.teamId !== membership.teamId)
    throw new Error("App not found");
  const isCompose = usesComposeStack(project);

  // A path lets several rows share one hostname, so uniqueness is on
  // (host + path), not host alone.
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
    throw new Error("Application port is required");
  const middlewares = normalizeMiddlewares(config.middlewares);
  // Strip is only meaningful with a path, so drop it otherwise - the router
  // grammar does the same.
  const stripPrefix = Boolean(pathPrefix && config.stripPrefix);
  // First domain on the project becomes primary.
  const existing = await loadDomainsForApp(appId);
  const isFirst = existing.length === 0;
  // A path-routed row is a SECOND row on a hostname that may already be verified.
  const sibling = existing.find((d) => d.name === clean && isRoutableDomain(d));
  // No verified sibling ⇒ check DNS NOW instead of parking the row at `pending`
  // until someone finds Verify. Cloudflare is declared, never detected - another
  // proxy publishes no address range.
  const proxied = config.proxied === true;
  const status =
    sibling?.status ?? (await checkDomainDns(clean, await appServerIp(appId)));
  // A host the check found PROXIED is served over HTTPS by Cloudflare, so it is
  // born with the `cloudflare` provider instead of the cert-less default.
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
    ssl: sibling ? sibling.ssl : isRoutableDomain({ status, proxied }),
    // Always store a concrete port so no domain is ever portless.
    port: config.port ?? portFor(project),
    // Entrypoint persists only when the user picked it explicitly (manual mode).
    ...(config.entrypoint ? { entrypoint: config.entrypoint } : {}),
    certProvider,
    ...(middlewares.length ? { middlewares } : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
    ...(stripPrefix ? { stripPrefix } : {}),
    ...(service ? { service } : {}),
    ...(proxied ? { proxied: true } : {}),
    createdAt: nowIso(),
  };
  await insertDomain(getDb(), domain);
  // Runs BEFORE the canonical URL is synced, because a `toCounterpart` pairing
  // hands `primary` to the hostname that ends up serving the app.
  if (config.www && config.www !== "none")
    await applyWwwRedirect(domain, config.www, membership.teamId);
  // The FIRST domain is the app's canonical URL from this second on; a later one
  // can still change the scheme of the fallback the app is showing.
  await syncProductionUrl(appId);
  await recordActivity("domain", `Added domain ${clean}`, user.name, appId);
  return domain;
}

// DomainPatch: a full-domain edit - every field the Edit dialog can change, each
// optional so the action only sends what it touched.
export interface DomainPatch {
  name?: string;
  /** `null` clears the override (revert to the project default). */
  port?: number | null;
  certProvider?: CertProvider;
  middlewares?: string[];
  /** Path prefix this host routes; "" clears it. */
  pathPrefix?: string;
  /** Strip the path prefix before forwarding; ignored when there is no path. */
  stripPrefix?: boolean;
  /** Compose-stack only: which compose service this host targets; "" clears it. */
  service?: string;
  /** `www` ⇄ non-`www` pairing. Absent ⇒ the pairing is left exactly as it is. */
  www?: WwwRedirect;
  /** Tri-state: a value → manual mode, `null` → auto (derived at deploy time, so
   * delete it), absent → leave what is stored. Lets the checkbox round-trip. */
  entrypoint?: DomainEntrypoint | null;
  /** The "a proxy answers for this hostname" declaration - see
   * {@link Domain.proxied}. Absent leaves it unchanged. */
  proxied?: boolean;
}

// updateDomain: apply a full edit and return the appId, so the caller can
// re-apply routing (new Traefik labels only reach the container on a re-render).
export async function updateDomain(
  id: string,
  patch: DomainPatch,
): Promise<string> {
  // Same lock as `addDomain`, keyed on the name a rename claims.
  return withKeyedLock(
    `domain:${(patch.name ?? "").trim().toLowerCase() || id}`,
    () => updateDomainUnlocked(id, patch),
  );
}

async function updateDomainUnlocked(
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
  // uniqueness key - several rows may share a host on different paths.
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
  if (renamed) assertNotPanelHost(nextName);
  // Resolve + validate the new path and the service BEFORE mutating, so a bad
  // value rejects without a partial write.
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
    if (nextPort == null) throw new Error("Application port is required");
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
  // refusal `addDomain` does. This row is excluded from the comparison.
  await assertHostnameNotAnotherTeams(nextName, membership.teamId, id);

  const next: Domain = { ...current, name: nextName };
  if (patch.port !== undefined) next.port = patch.port ?? undefined;
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
  // Declaring (or un-declaring) a proxy in front changes whether the host is
  // routed at all, without its DNS having moved an inch.
  if (patch.proxied !== undefined) {
    next.proxied = patch.proxied || undefined;
    next.ssl = isRoutableDomain(next);
  }
  // A renamed domain points at a new host whose DNS the stored status says
  // nothing about, so check the NEW name right now, exactly like addDomain does.
  if (renamed) {
    next.status = await checkDomainDns(
      nextName,
      await appServerIp(current.appId),
    );
    next.ssl = isRoutableDomain(next);
    // The rename's check can discover the NEW host is proxied, so it gets the
    // same automatic Cloudflare provider an add would give it, UNLESS this edit
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
  // dependents follow it.
  if (renamed) await repointRedirects(dom.appId, current.name, dom.name);
  // The www pairing is applied last: it reads the app's rows back, so it must
  // see the renamed row and the re-pointed dependents, and it can move `primary`
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

export async function removeDomain(id: string): Promise<string> {
  const user = (await getCurrentUser())!;
  const dom = await loadDomain(id);
  if (!dom) throw new Error("Not found");
  await requireAppCapability(dom.appId, "manage_domains");
  // Removing the PRIMARY hands the crown to the closest remaining domain in the
  // SAME transaction as the delete: a half-applied succession would leave the
  // canonical host undefined.
  const rest = (await loadDomainsForApp(dom.appId)).filter((d) => d.id !== id);
  // A companion Deplo generated for the pair (`source: "redirect"`) is deleted -
  // it exists only to point at this host - while a hostname the USER added is
  // merely un-redirected, so it stays and starts serving instead of 301-ing.
  const dependents = rest.filter((d) => d.redirectTo === dom.name);
  const orphaned = dependents.filter((d) => d.source === "redirect");
  const freed = dependents.filter((d) => d.source !== "redirect");
  const orphanedIds = new Set(orphaned.map((d) => d.id));
  // The heir must be a hostname that will still be there AND still serve.
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
  // The canonical URL follows immediately - either onto the heir, or to null
  // when that was the last domain.
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
