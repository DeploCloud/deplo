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

// ImportedRoute: one route an import could not keep the address of.
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

// addImportedDomains: re-host the routes an import could not keep the address of,
// and answer with `sourceHost` -> the new hostname.
export async function addImportedDomains(
  appId: string,
  routes: ImportedRoute[],
  opts: {
    slug: string;
    ip: string;
    /** Source hosts that already landed somewhere - in practice the ONE the
     * app's primary became. Without it a second row on that same source host
     * would split an address that was never split. */
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
    // One mint per source host; every later row on that host joins it.
    let name = landed.get(route.sourceHost);
    if (!name) {
      name = await uniqueAutoDomainName(
        // Labelled by service, the convention `ensureExtraDomain` set: on an app
        // with several addresses, which is which has to be readable.
        route.service ? `${opts.slug}-${route.service}` : opts.slug,
        opts.ip,
      );
      landed.set(route.sourceHost, name);
    }
    const key = `${name}\u0000${pathPrefix}`;
    if (taken.has(key)) continue; // idempotent re-run, or a duplicate source row
    taken.add(key);

    const domain: Domain = {
      id: newId("dom"),
      appId,
      name,
      // Ours by construction: a nip.io host encodes this server's own IP.
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
      ...(pathPrefix ? { pathPrefix } : {}),
      ...(pathPrefix && route.stripPrefix ? { stripPrefix: true } : {}),
      importedFrom: route.sourceHost,
      createdAt: nowIso(),
    };
    await insertDomain(getDb(), domain);
  }
  return landed;
}

// applyImportedRoute: put an imported route onto a domain row that already exists.
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

// dismissImportedDomains: stop telling this app that its addresses changed.
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
