import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { newId, nowIso } from "../../ids";
import {
  insertDomain,
  loadDomainsForApp,
  loadAppGraph,
} from "../app-graph-load";
import {
  LETSENCRYPT_DOMAINS_PER_TEAM_CAP,
  temporaryAddressTls,
} from "../../deploy/domains";
import { requireAppCapability } from "../node-access";
import type {
  CertProvider,
  Domain,
  DomainEntrypoint,
} from "../../types/domain";
import { appTeamId, uniqueAutoDomainName } from "./hostname-claim";
import { certProviderWithinQuota } from "./letsencrypt-quota";
import { isRoutableService, normalizePath } from "./route-config";

export interface ImportedRoute {
  sourceHost: string;
  port: number | null;
  pathPrefix: string;
  stripPrefix: boolean;
  certProvider: CertProvider;
  entrypoint: DomainEntrypoint;
  service: string | null;
}

// The service comes from another panel: kept only when this stack declares it, like every other domain.
async function routableServiceOf(
  appId: string,
): Promise<(service: string | null) => string | null> {
  const compose = (await loadAppGraph(appId))?.compose ?? null;
  return (service) =>
    service && isRoutableService(compose, service) ? service : null;
}

export async function addImportedDomains(
  appId: string,
  routes: ImportedRoute[],
  opts: {
    slug: string;
    ip: string;
    seed?: Map<string, string>;
    notes?: string[];
  },
): Promise<Map<string, string>> {
  const landed = new Map<string, string>(opts.seed);
  if (routes.length === 0) return landed;
  const teamId = await appTeamId(appId);
  const existing = await loadDomainsForApp(appId);
  const routable = await routableServiceOf(appId);
  const taken = new Set(
    existing.map((d) => `${d.name}\u0000${d.pathPrefix ?? ""}`),
  );

  for (const route of routes) {
    const pathPrefix = normalizePath(route.pathPrefix);
    const service = routable(route.service);
    let name = landed.get(route.sourceHost);
    if (!name) {
      name = await uniqueAutoDomainName(
        service ? `${opts.slug}-${service}` : opts.slug,
        opts.ip,
      );
      landed.set(route.sourceHost, name);
    }
    const key = `${name}\u0000${pathPrefix}`;
    if (taken.has(key)) continue;
    taken.add(key);
    const tls = temporaryAddressTls(name, route);
    const certProvider = await certProviderWithinQuota(
      teamId,
      tls.certProvider,
    );
    if (certProvider !== tls.certProvider) opts.notes?.push(capNote(name));

    const domain: Domain = {
      id: newId("dom"),
      appId,
      name,
      status: "valid",
      primary: false,
      redirectTo: null,
      ssl: certProvider !== "none",
      source: "auto",
      port: route.port,
      ...(service ? { service } : {}),
      certProvider,
      entrypoint: tls.entrypoint,
      ...(pathPrefix ? { pathPrefix } : {}),
      ...(pathPrefix && route.stripPrefix ? { stripPrefix: true } : {}),
      importedFrom: route.sourceHost,
      // The app answered without them where it came from; a move must not change that.
      securityHeaders: false,
      createdAt: nowIso(),
    };
    await insertDomain(getDb(), domain);
  }
  return landed;
}

export async function applyImportedRoute(
  appId: string,
  domainId: string,
  route: ImportedRoute,
  notes?: string[],
): Promise<void> {
  const pathPrefix = normalizePath(route.pathPrefix);
  const [row] = await getDb()
    .select({
      appId: domainsTable.appId,
      name: domainsTable.name,
      certProvider: domainsTable.certProvider,
    })
    .from(domainsTable)
    .where(and(eq(domainsTable.id, domainId), eq(domainsTable.appId, appId)));
  if (!row) return;
  const tls = temporaryAddressTls(row.name, route);
  const certProvider =
    row.certProvider === tls.certProvider
      ? tls.certProvider
      : await certProviderWithinQuota(
          await appTeamId(row.appId),
          tls.certProvider,
        );
  if (certProvider !== tls.certProvider) notes?.push(capNote(row.name));
  const routable = await routableServiceOf(appId);
  await getDb()
    .update(domainsTable)
    .set({
      port: route.port,
      service: routable(route.service),
      certProvider,
      entrypoint: tls.entrypoint,
      pathPrefix: pathPrefix || null,
      stripPrefix: (pathPrefix && route.stripPrefix) || null,
      ssl: certProvider !== "none",
      importedFrom: route.sourceHost,
    })
    .where(and(eq(domainsTable.id, domainId), eq(domainsTable.appId, appId)));
}

const capNote = (name: string) =>
  `${name} comes across with no certificate: this team has reached its limit of ${LETSENCRYPT_DOMAINS_PER_TEAM_CAP} Let's Encrypt domains.`;

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
