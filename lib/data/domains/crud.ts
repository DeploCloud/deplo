import "server-only";

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

export interface DomainConfig {
  port?: number | null;
  entrypoint?: DomainEntrypoint;
  certProvider?: CertProvider;
  middlewares?: string[];
  pathPrefix?: string;
  stripPrefix?: boolean;
  service?: string;
  www?: WwwRedirect;
  proxied?: boolean;
}

export async function addDomain(
  appId: string,
  name: string,
  config: DomainConfig = {},
): Promise<Domain> {
  // Check-then-write: one hostname at a time is what closes the race between two teams adding the same name.
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

  const pathPrefix = normalizePath(config.pathPrefix);
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
  await assertHostnameNotAnotherTeams(clean, membership.teamId, null);

  await assertTeamLetsencryptQuota(
    membership.teamId,
    config.certProvider ?? "none",
  );

  const service = resolveApp(config.service, project, isCompose);
  if (isCompose && config.port == null)
    throw new Error("Application port is required");
  const middlewares = normalizeMiddlewares(config.middlewares);
  const stripPrefix = Boolean(pathPrefix && config.stripPrefix);
  const existing = await loadDomainsForApp(appId);
  const isFirst = existing.length === 0;
  const sibling = existing.find((d) => d.name === clean && isRoutableDomain(d));
  const proxied = config.proxied === true;
  const status =
    sibling?.status ?? (await checkDomainDns(clean, await appServerIp(appId)));
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
    port: config.port ?? portFor(project),
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
  if (config.www && config.www !== "none")
    await applyWwwRedirect(domain, config.www, membership.teamId);
  await syncProductionUrl(appId);
  await recordActivity("domain", `Added domain ${clean}`, user.name, appId);
  return domain;
}

export interface DomainPatch {
  name?: string;
  port?: number | null;
  certProvider?: CertProvider;
  middlewares?: string[];
  pathPrefix?: string;
  stripPrefix?: boolean;
  service?: string;
  www?: WwwRedirect;
  entrypoint?: DomainEntrypoint | null;
  proxied?: boolean;
}

export async function updateDomain(
  id: string,
  patch: DomainPatch,
): Promise<string> {
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
  const nextPath =
    patch.pathPrefix !== undefined
      ? normalizePath(patch.pathPrefix)
      : (current.pathPrefix ?? "");
  const nextApp =
    patch.service !== undefined
      ? resolveApp(patch.service, project, isCompose)
      : (current.service ?? null);
  const nextPort =
    patch.port !== undefined ? patch.port : (current.port ?? null);
  if (isCompose) {
    if (!nextApp) throw new Error("Select the container this domain routes to");
    if (nextPort == null) throw new Error("Application port is required");
  }
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
  // A rename is the other way onto another team's hostname, so it gets the same refusal addDomain makes.
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
  if (patch.stripPrefix !== undefined || patch.pathPrefix !== undefined) {
    const effPath =
      patch.pathPrefix !== undefined ? nextPath : (current.pathPrefix ?? "");
    const strip =
      Boolean(effPath) && (patch.stripPrefix ?? current.stripPrefix ?? false);
    next.stripPrefix = strip ? true : undefined;
  }
  if (patch.service !== undefined) next.service = nextApp ?? undefined;
  if (patch.proxied !== undefined) {
    next.proxied = patch.proxied || undefined;
    next.ssl = isRoutableDomain(next);
  }
  if (renamed) {
    next.status = await checkDomainDns(
      nextName,
      await appServerIp(current.appId),
    );
    next.ssl = isRoutableDomain(next);
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
    await tx
      .delete(domainMiddlewaresTable)
      .where(eq(domainMiddlewaresTable.domainId, id));
    const mwRows = domainMiddlewaresToRows(next);
    if (mwRows.length > 0)
      await tx.insert(domainMiddlewaresTable).values(mwRows);
  });
  const dom = next;
  if (renamed) await repointRedirects(dom.appId, current.name, dom.name);
  if (patch.www !== undefined)
    await applyWwwRedirect(dom, patch.www, membership.teamId);
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
  const rest = (await loadDomainsForApp(dom.appId)).filter((d) => d.id !== id);
  const dependents = rest.filter((d) => d.redirectTo === dom.name);
  const orphaned = dependents.filter((d) => d.source === "redirect");
  const freed = dependents.filter((d) => d.source !== "redirect");
  const orphanedIds = new Set(orphaned.map((d) => d.id));
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
  // The succession rides in the delete's own transaction: half-applied would leave the canonical host undefined.
  await getDb().transaction(async (tx) => {
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
  await syncProductionUrl(dom.appId);
  await recordActivity(
    "domain",
    `Removed domain ${dom.name}`,
    user.name,
    dom.appId,
  );
  return dom.appId;
}
