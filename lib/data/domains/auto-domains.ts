import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { newId, nowIso } from "../../ids";
import {
  isWildcardIp,
  isLoopbackIp,
  wildcardEmbeddedIp,
  rehostWildcard,
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
  appTeamId,
  assertHostnameClaimable,
  domainNameExists,
  hostnameClaimable,
  normalizePreferredHost,
  uniqueAutoDomainName,
} from "./hostname-claim";
import { appServerAddresses, checkDomainDns } from "./dns-check";
import { certProviderWithinQuota } from "./letsencrypt-quota";
import { composeServiceNames, normalizePath } from "./route-config";

export async function ensureAutoDomain(
  appId: string,
  opts: {
    slug: string;
    ip: string | null;
    preferred?: string;
    defaultPort: number;
    defaultApp?: string | null;
    certProvider?: CertProvider;
    preferredPath?: string;
  },
): Promise<string | null> {
  const existing = await loadDomainsForApp(appId);
  const primary = existing.find((d) => d.primary) ?? existing[0];
  if (primary) {
    if (
      primary.source === "auto" &&
      opts.ip &&
      isWildcardIp(opts.ip) &&
      !isLoopbackIp(opts.ip)
    ) {
      const embedded = wildcardEmbeddedIp(primary.name);
      if (embedded && embedded !== opts.ip) {
        const fixed = rehostWildcard(primary.name, opts.ip);
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

  const teamId = await appTeamId(appId);
  const preferred = normalizePreferredHost(opts.preferred) || undefined;
  const preferredOk =
    !!preferred &&
    (wildcardEmbeddedIp(preferred) != null || DOMAIN_RE.test(preferred));
  const preferredPath = normalizePath(opts.preferredPath);
  let name: string;
  if (preferredOk && !(await domainNameExists(preferred!, preferredPath))) {
    // A preferred host gets what a typed one gets: not the panel's address, not a name another team routes.
    await assertHostnameClaimable(preferred!, teamId);
    name = preferred!;
  } else if (opts.ip) {
    name = await uniqueAutoDomainName(opts.slug, opts.ip);
  } else {
    return null;
  }
  const pathPrefix = name === preferred ? preferredPath : "";
  const status =
    wildcardEmbeddedIp(name) != null
      ? ("valid" as const)
      : await checkDomainDns(name, await appServerAddresses(appId));
  // An absent provider reads as letsencrypt at the deploy edge, so the born-without-a-cert default is written.
  const certProvider = certProviderForDns(
    status,
    await certProviderWithinQuota(teamId, opts.certProvider ?? "none"),
  );
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
    ip: string | null;
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
  const teamId = await appTeamId(appId);
  const usable =
    wanted &&
    (await hostnameClaimable(wanted, teamId)) &&
    !(await domainNameExists(wanted, pathPrefix));
  if (!usable && !route.ip) return;
  const name = usable
    ? wanted
    : await uniqueAutoDomainName(
        route.service ? `${route.slug}-${route.service}` : route.slug,
        route.ip!,
      );
  const certProvider = await certProviderWithinQuota(
    teamId,
    route.certProvider ?? "none",
  );
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
