import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { newId, nowIso } from "../../ids";
import {
  isIpv4,
  isLoopbackIp,
  nipEmbeddedIp,
  rehostNip,
} from "../../deploy/domains";
import { certProviderForDns, isRoutableDomain } from "../../deploy/cloudflare";
import { composeServiceReservedClaim } from "../../deploy/compose-lint/networks";
import { usesComposeStack } from "../../utils";
import {
  insertDomain,
  loadDomainsForApp,
  loadAppGraph,
} from "../app-graph-load";
import type { CertProvider, Domain } from "../../types/domain";
import {
  DOMAIN_RE,
  assertHostnameNotAnotherTeams,
  assertNotPanelHost,
  domainNameExists,
  isPanelHost,
  normalizePreferredHost,
  uniqueAutoDomainName,
} from "./hostname-claim";
import { checkDomainDns } from "./dns-check";
import { composeServiceNames, normalizePath } from "./route-config";

export async function ensureAutoDomain(
  appId: string,
  opts: {
    slug: string;
    ip: string;
    preferred?: string;
    defaultPort: number;
    defaultApp?: string | null;
    certProvider?: CertProvider;
    preferredPath?: string;
  },
): Promise<string> {
  const existing = await loadDomainsForApp(appId);
  const primary = existing.find((d) => d.primary) ?? existing[0];
  if (primary) {
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

  const preferred = normalizePreferredHost(opts.preferred) || undefined;
  const preferredOk =
    !!preferred &&
    (nipEmbeddedIp(preferred) != null || DOMAIN_RE.test(preferred));
  const preferredPath = normalizePath(opts.preferredPath);
  let name: string;
  if (preferredOk && !(await domainNameExists(preferred!, preferredPath))) {
    assertNotPanelHost(preferred!);
    const owner = (
      await getDb()
        .select({ teamId: appsTable.teamId })
        .from(appsTable)
        .where(eq(appsTable.id, appId))
        .limit(1)
    )[0];
    if (owner)
      await assertHostnameNotAnotherTeams(preferred!, owner.teamId, null);
    name = preferred!;
  } else {
    name = await uniqueAutoDomainName(opts.slug, opts.ip);
  }
  const pathPrefix = name === preferred ? preferredPath : "";
  const status =
    nipEmbeddedIp(name) != null
      ? ("valid" as const)
      : await checkDomainDns(name, opts.ip);
  const certProvider = certProviderForDns(status, opts.certProvider ?? "none");
  const domain: Domain = {
    id: newId("dom"),
    appId,
    name,
    status,
    primary: true,
    redirectTo: null,
    ssl: certProvider !== "none" && isRoutableDomain({ status }),
    source: "auto",
    port: opts.defaultPort,
    ...(opts.defaultApp ? { service: opts.defaultApp } : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
    certProvider,
    createdAt: nowIso(),
  };
  await insertDomain(getDb(), domain);
  return name;
}

export async function ensureExtraDomain(
  appId: string,
  rawName: string,
  route: {
    port: number;
    service?: string | null;
    slug: string;
    ip: string;
    certProvider?: CertProvider;
    pathPrefix?: string;
  },
): Promise<void> {
  const pathPrefix = normalizePath(route.pathPrefix);
  const asked = normalizePreferredHost(rawName);
  const service = route.service ?? "";
  const project = service ? await loadAppGraph(appId) : null;
  if (project && usesComposeStack(project)) {
    const declared = composeServiceNames(project.compose);
    if (
      !declared.includes(service) ||
      composeServiceReservedClaim(project.compose, service)
    )
      return;
  }
  const existing = await loadDomainsForApp(appId);
  const wanted =
    asked && DOMAIN_RE.test(asked)
      ? asked
      : pathPrefix
        ? ((existing.find((d) => d.primary) ?? existing[0])?.name ?? "")
        : "";
  if (
    wanted &&
    existing.some(
      (d) =>
        d.name === wanted && (d.pathPrefix ?? "") === pathPrefix && !d.primary,
    )
  )
    return;
  const name =
    wanted &&
    !isPanelHost(wanted) &&
    !(await domainNameExists(wanted, pathPrefix))
      ? wanted
      : await uniqueAutoDomainName(
          route.service ? `${route.slug}-${route.service}` : route.slug,
          route.ip,
        );
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
    port: route.port,
    ...(route.service ? { service: route.service } : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
    certProvider,
    createdAt: nowIso(),
  };
  await insertDomain(getDb(), domain);
}
