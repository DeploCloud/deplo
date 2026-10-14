import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { newId, nowIso } from "../../ids";
import {
  insertDomain,
  loadDomainsForApp,
  loadAppGraph,
} from "../app-graph-load";
import { LETSENCRYPT_DOMAINS_PER_TEAM_CAP } from "../../deploy/domains";
import { requireAppCapability } from "../node-access";
import type {
  CertProvider,
  Domain,
  DomainEntrypoint,
} from "../../types/domain";
import { appTeamId, uniqueAutoDomainName } from "./hostname-claim";
import { certProviderWithinQuota } from "./letsencrypt-quota";
import { normalizePath } from "./route-config";

export interface ImportedRoute {
  sourceHost: string;
  port: number | null;
  pathPrefix: string;
  stripPrefix: boolean;
  certProvider: CertProvider;
  entrypoint: DomainEntrypoint;
  service: string | null;
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
  const taken = new Set(
    existing.map((d) => `${d.name}\u0000${d.pathPrefix ?? ""}`),
  );

  for (const route of routes) {
    const pathPrefix = normalizePath(route.pathPrefix);
    let name = landed.get(route.sourceHost);
    if (!name) {
      name = await uniqueAutoDomainName(
        route.service ? `${opts.slug}-${route.service}` : opts.slug,
        opts.ip,
      );
      landed.set(route.sourceHost, name);
    }
    const key = `${name}\u0000${pathPrefix}`;
    if (taken.has(key)) continue;
    taken.add(key);
    const certProvider = await certProviderWithinQuota(
      teamId,
      route.certProvider,
    );
    if (certProvider !== route.certProvider) opts.notes?.push(capNote(name));

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
      ...(route.service ? { service: route.service } : {}),
      certProvider,
      entrypoint: route.entrypoint,
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
    .where(eq(domainsTable.id, domainId));
  if (!row) return;
  const certProvider =
    row.certProvider === route.certProvider
      ? route.certProvider
      : await certProviderWithinQuota(
          await appTeamId(row.appId),
          route.certProvider,
        );
  if (certProvider !== route.certProvider) notes?.push(capNote(row.name));
  await getDb()
    .update(domainsTable)
    .set({
      port: route.port,
      service: route.service,
      certProvider,
      entrypoint: route.entrypoint,
      pathPrefix: pathPrefix || null,
      stripPrefix: (pathPrefix && route.stripPrefix) || null,
      ssl: certProvider !== "none",
      importedFrom: route.sourceHost,
    })
    .where(eq(domainsTable.id, domainId));
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
