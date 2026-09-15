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
import { requireAppCapability } from "../node-access";
import type {
  CertProvider,
  Domain,
  DomainEntrypoint,
} from "../../types/domain";
import { uniqueAutoDomainName } from "./hostname-claim";
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
  },
): Promise<Map<string, string>> {
  const landed = new Map<string, string>(opts.seed);
  if (routes.length === 0) return landed;
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

    const domain: Domain = {
      id: newId("dom"),
      appId,
      name,
      status: "valid",
      primary: false,
      redirectTo: null,
      ssl: route.certProvider !== "none",
      source: "auto",
      port: route.port,
      ...(route.service ? { service: route.service } : {}),
      certProvider: route.certProvider,
      entrypoint: route.entrypoint,
      ...(pathPrefix ? { pathPrefix } : {}),
      ...(pathPrefix && route.stripPrefix ? { stripPrefix: true } : {}),
      importedFrom: route.sourceHost,
      createdAt: nowIso(),
    };
    await insertDomain(getDb(), domain);
  }
  return landed;
}

export async function applyImportedRoute(
  domainId: string,
  route: ImportedRoute,
): Promise<void> {
  const pathPrefix = normalizePath(route.pathPrefix);
  await getDb()
    .update(domainsTable)
    .set({
      port: route.port,
      service: route.service,
      certProvider: route.certProvider,
      entrypoint: route.entrypoint,
      pathPrefix: pathPrefix || null,
      stripPrefix: (pathPrefix && route.stripPrefix) || null,
      ssl: route.certProvider !== "none",
      importedFrom: route.sourceHost,
    })
    .where(eq(domainsTable.id, domainId));
}

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
