import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { nowIso } from "../../ids";
import { domainScheme } from "../../deploy/domains";
import { isRoutableDomain } from "../../deploy/cloudflare";
import { loadDomain, loadDomainsForApp } from "../app-graph-load";
import { requireAppCapability } from "../node-access";
import type { Domain } from "../../types/domain";

// primaryDomainName: the hostname of a project's primary domain, or "" when it has none.
export async function primaryDomainName(appId: string): Promise<string> {
  return (await primaryDomainRow(appId))?.name ?? "";
}

// primaryDomainRow: the full stored row behind primaryDomainName, or null.
export async function primaryDomainRow(appId: string): Promise<Domain | null> {
  const domains = await loadDomainsForApp(appId);
  // A redirecting hostname is never the canonical host, it only points at it.
  return (
    domains.find((d) => d.primary) ??
    domains.find((d) => !d.redirectTo) ??
    domains[0] ??
    null
  );
}

// primaryDomainApp: the compose service the primary domain routes to, or "".
export async function primaryDomainApp(appId: string): Promise<string> {
  const domains = await loadDomainsForApp(appId);
  const primary = domains.find((d) => d.primary) ?? domains[0];
  return primary?.service ?? "";
}

// setPrimaryDomain: flip which domain is primary for its project.
export async function setPrimaryDomain(id: string): Promise<string> {
  const dom = await loadDomain(id);
  if (!dom) throw new Error("Not found");
  await requireAppCapability(dom.appId, "manage_domains");
  // A misconfigured domain has no working DNS to this server, so it can't be the
  // canonical host. (A `pending` one is allowed: the first domain added is that.)
  if (dom.status === "misconfigured" && !dom.proxied)
    throw new Error(
      "This domain’s DNS is misconfigured - fix its DNS and re-verify before setting it as primary.",
    );
  // A redirecting hostname serves nothing: making it canonical would advertise a
  // URL that answers 301 to another one.
  if (dom.redirectTo)
    throw new Error(
      `${dom.name} redirects to ${dom.redirectTo}, so it can't be the canonical host - flip the redirect from ${dom.redirectTo} instead.`,
    );
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

// syncProductionUrl: point a project's canonical productionUrl at its current primary domain.
export async function syncProductionUrl(appId: string): Promise<void> {
  const domains = await loadDomainsForApp(appId);
  // The fallback skips redirecting hostnames: advertising one as the canonical
  // URL would send every visitor through a bounce.
  const primary =
    domains.find((x) => x.primary) ??
    domains.find((x) => !x.redirectTo) ??
    domains[0];
  await getDb()
    .update(appsTable)
    .set({
      // Scheme follows the primary's certificate provider (a cert-less domain is
      // served plain-HTTP); the path travels with it, since a host whose router
      // matches `/app` answers nothing at its root.
      productionUrl: primary
        ? `${domainScheme(primary)}://${primary.name}${primary.pathPrefix ?? ""}`
        : null,
      updatedAt: nowIso(),
    })
    .where(eq(appsTable.id, appId));
}

// successorPrimary: which remaining domain inherits `primary` when the current primary is deleted.
export function successorPrimary(
  remaining: Domain[],
  removed: { service?: string | null; port?: number | null },
): Domain | null {
  if (remaining.length === 0) return null;
  const service = removed.service ?? null;
  const port = removed.port ?? null;
  // Routability rank: routed > not resolving yet > pointing somewhere else.
  const reach = (d: Domain): number =>
    isRoutableDomain(d) ? 2 : d.status === "misconfigured" ? 0 : 1;
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
